import { randomUUID } from 'node:crypto'
import type { TerminalBuffer, TerminalCreateRequest, TerminalInfo, TerminalIntent, TerminalPreparation } from '../shared/domain/terminal'
import { TERMINAL_BUFFER_BYTES, TERMINAL_FLUSH_MS, TERMINAL_MAX_CHUNK_BYTES } from '../shared/domain/terminal'
import { terminalTopic, windows } from './window/registry'
import type { WebContents } from 'electron'
import { IpcError } from './ipc/errors'
import { EnvironmentError } from './environment/errors'
import type { EnvironmentLease, TerminalDriver, WorkspaceEnvironment } from './environment/contract'
import { getEnvironments } from './runtime'

type Session = {
  info: TerminalInfo
  process: TerminalDriver
  environment: WorkspaceEnvironment
  ownerId: number
  release(): void
  buffer: string
  truncated: boolean
  pending: string
  flushTimer: NodeJS.Timeout | null
  seq: number
}

type PendingIntent = { info: TerminalIntent; ownerId: number; lease: EnvironmentLease; grant?: string; timer: NodeJS.Timeout }
type PendingCreation = { ownerId: number; workspaceId: string; cwd?: string; approval?: string; controller: AbortController; promise: Promise<TerminalInfo> }

function safeSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(2, Math.floor(value)) : fallback
}

/** Owns long-lived interactive shells. It intentionally lives in main, never in the renderer. */
export class TerminalHost {
  private readonly sessions = new Map<string, Session>()
  private readonly intents = new Map<string, PendingIntent>()
  private readonly creating = new Map<string, PendingCreation>()
  private readonly preparing = new Map<string, { ownerId: number; controller: AbortController }>()
  private readonly owners = new Set<number>()

  constructor(private readonly acquire: (workspaceId: string) => EnvironmentLease = (id) => getEnvironments().acquire(id),
    private readonly now: () => number = Date.now) {}

  async prepare(req: TerminalCreateRequest, sender: WebContents): Promise<TerminalPreparation> {
    this.watchOwner(sender)
    const lease = this.acquire(req.workspaceId)
    try {
      const environment = lease.environment
      environment.assertReady()
      if (!environment.remote) return { kind: 'ready', terminal: await this.create(req, sender) }
      const existing = req.id ? this.sessions.get(req.id) : undefined
      if (existing?.info.alive) {
        this.checkSession(existing, req.workspaceId, sender, environment)
        windows.subscribe(terminalTopic(existing.info.id), sender)
        return { kind: 'ready', terminal: existing.info }
      }
      if (existing) this.checkOwner(existing, sender)
      const id = req.id ?? randomUUID()
      const previous = this.preparing.get(id)
      if (previous && previous.ownerId !== sender.id) throw new EnvironmentError('approval-required')
      previous?.controller.abort()
      const pendingPreparation = { ownerId: sender.id, controller: new AbortController() }
      this.preparing.set(id, pendingPreparation)
      let cwd: string
      try {
        cwd = await this.cwd(environment, req.cwd)
        if (pendingPreparation.controller.signal.aborted || sender.isDestroyed()) throw new EnvironmentError('cancelled')
      } finally { if (this.preparing.get(id) === pendingPreparation) this.preparing.delete(id) }
      for (const [intentId, pending] of this.intents) {
        if (pending.info.expiresAt <= this.now()) this.dropIntent(intentId)
        else if (pending.info.terminalId === id) {
          if (pending.ownerId !== sender.id) throw new EnvironmentError('approval-required')
          this.dropIntent(intentId)
        }
      }
      if (this.intents.size >= 64) throw new EnvironmentError('conflict')
      const info: TerminalIntent = { id: randomUUID(), terminalId: id, workspaceId: req.workspaceId,
        connection: environment.description, cwd, shell: environment.platform.shell, expiresAt: this.now() + 60_000 }
      const held = this.acquire(req.workspaceId)
      if (held.environment.key !== environment.key) { held.release(); throw new EnvironmentError('disconnected') }
      const timer = setTimeout(() => this.dropIntent(info.id), 60_000)
      timer.unref()
      this.intents.set(info.id, { info, ownerId: sender.id, lease: held, timer })
      return { kind: 'approval', intent: info }
    } finally { lease.release() }
  }

  approve(id: string, approved: boolean, sender: WebContents): string | null {
    const pending = this.intents.get(id)
    if (!pending || pending.ownerId !== sender.id) throw new EnvironmentError('approval-expired')
    if (!approved) { this.dropIntent(id); return null }
    if (pending.info.expiresAt <= this.now()) { this.dropIntent(id); throw new EnvironmentError('approval-expired') }
    pending.lease.environment.assertReady()
    pending.grant ??= randomUUID()
    return pending.grant
  }

  create(req: TerminalCreateRequest, sender: WebContents): Promise<TerminalInfo> {
    this.watchOwner(sender)
    const id = req.id ?? randomUUID()
    const pending = this.creating.get(id)
    if (pending) {
      if (pending.ownerId !== sender.id || pending.workspaceId !== req.workspaceId || pending.approval !== req.approval || pending.cwd !== req.cwd) {
        return Promise.reject(new EnvironmentError('approval-required'))
      }
      return pending.promise
    }
    const controller = new AbortController()
    const promise = this.createOne({ ...req, id }, sender, controller.signal).finally(() => this.creating.delete(id))
    this.creating.set(id, { ownerId: sender.id, workspaceId: req.workspaceId, cwd: req.cwd, approval: req.approval, controller, promise })
    return promise
  }

  private async createOne(req: TerminalCreateRequest & { id: string }, sender: WebContents, signal: AbortSignal): Promise<TerminalInfo> {
    const existing = req.id ? this.sessions.get(req.id) : undefined
    let lease = this.acquire(req.workspaceId)
    let retained = false
    try {
    const environment = lease.environment
    environment.assertReady()
    if (existing) {
      this.checkOwner(existing, sender)
      if (existing.info.alive) {
        this.checkSession(existing, req.workspaceId, sender, environment)
        windows.subscribe(terminalTopic(existing.info.id), sender)
        return existing.info
      }
    }
    let cwd: string
    if (environment.remote) {
      const pending = [...this.intents.values()].find((intent) => intent.grant !== undefined && intent.grant === req.approval)
      if (!pending) throw new EnvironmentError('approval-required')
      if (pending.ownerId !== sender.id || pending.info.terminalId !== req.id || pending.info.workspaceId !== req.workspaceId
        || pending.lease.environment.key !== environment.key || (req.cwd !== undefined && req.cwd !== pending.info.cwd)) {
        throw new EnvironmentError('approval-required')
      }
      if (pending.info.expiresAt <= this.now()) { this.dropIntent(pending.info.id); throw new EnvironmentError('approval-expired') }
      pending.lease.environment.assertReady()
      this.intents.delete(pending.info.id)
      clearTimeout(pending.timer)
      lease.release()
      lease = pending.lease
      cwd = await this.cwd(lease.environment, pending.info.cwd)
      if (cwd !== pending.info.cwd) throw new EnvironmentError('approval-expired')
    } else cwd = await this.cwd(environment, req.cwd)
    if (sender.isDestroyed() || signal.aborted) throw new EnvironmentError('cancelled')
    const id = req.id
    const cols = safeSize(req.cols, 100)
    const rows = safeSize(req.rows, 28)
    const shell = environment.terminalShell ?? environment.platform.shell
    const child = await lease.environment.openTerminal({ cols, rows, cwd })
    if (sender.isDestroyed() || signal.aborted) { child.kill(); throw new EnvironmentError('cancelled') }
    try { lease.environment.assertReady() } catch (error) { child.kill(); throw error }
    const info: TerminalInfo = {
      id,
      workspaceId: req.workspaceId,
      title: environment.path.basename(cwd) || shell,
      cwd,
      shell,
      cols,
      rows,
      alive: true,
      createdAt: this.now()
    }
    const session: Session = {
      info,
      process: child,
      environment: lease.environment,
      ownerId: sender.id,
      release: lease.release,
      buffer: existing?.buffer ?? '',
      truncated: existing?.truncated ?? false,
      pending: '',
      flushTimer: null,
      seq: existing?.seq ?? 0
    }
    this.sessions.set(id, session)
    retained = true
    windows.subscribe(terminalTopic(id), sender)

    child.onData((data) => {
      if (this.sessions.get(id) !== session || !session.info.alive) return
      session.pending += data
      if (session.pending.length >= TERMINAL_MAX_CHUNK_BYTES) this.flush(id)
      else if (session.flushTimer === null) {
        session.flushTimer = setTimeout(() => { if (this.sessions.get(id) === session) this.flush(id) }, TERMINAL_FLUSH_MS)
      }
    })
    child.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== session || !session.info.alive) return
      if (session.flushTimer !== null) clearTimeout(session.flushTimer)
      session.flushTimer = null
      this.flush(id)
      session.info = { ...session.info, alive: false }
      session.release()
      windows.emitToTopic(terminalTopic(id), 'terminal:exit', { id, code: exitCode })
    })
    return info
    } finally { if (!retained) lease.release() }
  }

  attach(id: string, sender: WebContents): TerminalBuffer {
    const session = this.sessions.get(id)
    if (!session) throw new IpcError('unknown', `终端不存在: ${id}`)
    this.checkOwner(session, sender)
    windows.subscribe(terminalTopic(id), sender)
    return { id, data: session.buffer, truncated: session.truncated, seq: session.seq }
  }

  list(workspaceId: string, sender?: WebContents): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.info.workspaceId === workspaceId && (!session.environment.remote || session.ownerId === sender?.id))
      .map((session) => session.info)
  }

  write(id: string, data: string, sender: WebContents): void {
    const session = this.sessions.get(id)
    if (!session || !session.info.alive || typeof data !== 'string') return
    this.checkOwner(session, sender)
    session.environment.assertReady()
    session.process.write(data)
  }

  resize(id: string, cols: number, rows: number, sender: WebContents): void {
    const session = this.sessions.get(id)
    if (!session || !session.info.alive) return
    this.checkOwner(session, sender)
    session.environment.assertReady()
    const nextCols = safeSize(cols, session.info.cols)
    const nextRows = safeSize(rows, session.info.rows)
    session.process.resize(nextCols, nextRows)
    session.info = { ...session.info, cols: nextCols, rows: nextRows }
  }

  kill(id: string, sender?: WebContents): void {
    const pending = this.creating.get(id)
    const preparation = this.preparing.get(id)
    if (sender && ((pending && pending.ownerId !== sender.id) || (preparation && preparation.ownerId !== sender.id))) throw new EnvironmentError('approval-required')
    pending?.controller.abort()
    preparation?.controller.abort()
    for (const [intentId, intent] of this.intents) {
      if (intent.info.terminalId === id && (!sender || intent.ownerId === sender.id)) this.dropIntent(intentId)
    }
    const session = this.sessions.get(id)
    if (!session) return
    if (sender) this.checkOwner(session, sender)
    if (session.flushTimer !== null) clearTimeout(session.flushTimer)
    if (session.info.alive) session.process.kill()
    session.release()
    this.sessions.delete(id)
  }

  shutdown(): void {
    for (const pending of this.creating.values()) pending.controller.abort()
    for (const pending of this.preparing.values()) pending.controller.abort()
    for (const id of this.intents.keys()) this.dropIntent(id)
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private async cwd(environment: WorkspaceEnvironment, requested?: string): Promise<string> {
    const cwd = await environment.path.resolveWithin(environment.rootPath, requested || environment.rootPath)
    if (!(await environment.fs.stat(cwd)).isDir) throw new EnvironmentError('invalid-path')
    environment.assertReady()
    return cwd
  }

  private checkOwner(session: Session, sender: WebContents): void {
    if (session.environment.remote && session.ownerId !== sender.id) throw new EnvironmentError('approval-required')
  }

  private checkSession(session: Session, workspaceId: string, sender: WebContents, environment: WorkspaceEnvironment): void {
    this.checkOwner(session, sender)
    if (session.info.workspaceId !== workspaceId || session.environment.key !== environment.key) throw new EnvironmentError('approval-required')
    session.environment.assertReady()
  }

  private dropIntent(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) return
    this.intents.delete(id)
    clearTimeout(intent.timer)
    intent.lease.release()
  }

  private watchOwner(sender: WebContents): void {
    if (sender.isDestroyed()) throw new EnvironmentError('cancelled')
    if (this.owners.has(sender.id)) return
    this.owners.add(sender.id)
    sender.once('destroyed', () => {
      this.owners.delete(sender.id)
      for (const pending of this.creating.values()) if (pending.ownerId === sender.id) pending.controller.abort()
      for (const pending of this.preparing.values()) if (pending.ownerId === sender.id) pending.controller.abort()
      for (const [id, intent] of this.intents) if (intent.ownerId === sender.id) this.dropIntent(id)
      for (const [id, session] of this.sessions) if (session.ownerId === sender.id && session.environment.remote) this.kill(id)
    })
  }

  private flush(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.pending.length === 0) return
    const chunk = session.pending
    session.pending = ''
    session.flushTimer = null
    session.seq += 1
    session.buffer += chunk
    if (Buffer.byteLength(session.buffer, 'utf8') > TERMINAL_BUFFER_BYTES) {
      const bytes = Buffer.from(session.buffer, 'utf8')
      session.buffer = bytes.subarray(bytes.length - TERMINAL_BUFFER_BYTES).toString('utf8')
      session.truncated = true
    }
    windows.emitToTopic(terminalTopic(id), 'terminal:data', { id, seq: session.seq, chunk })
  }
}

export const terminalHost = new TerminalHost()
export const shutdownTerminals = (): void => terminalHost.shutdown()
