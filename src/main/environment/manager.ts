import type { ConnectionProfile, ConnectionStatus } from '../../shared/domain/environment'
import { normalizeEnvironmentRef } from '../../shared/domain/environment'
import type { Workspace } from '../../shared/domain/workspace'
import { abortable } from '../kernel/abort'
import type { EnvironmentConnection, EnvironmentLease, WorkspaceEnvironment } from './contract'
import { EnvironmentError } from './errors'

export interface ConnectionContext {
  senderId: number
  signal: AbortSignal
}

interface ConnectionEntry {
  profile: ConnectionProfile
  generation: number
  controller: AbortController
  waiters: number
  references: number
  idleTimer?: NodeJS.Timeout
  connection?: EnvironmentConnection
  pending?: Promise<EnvironmentConnection>
}

interface EnvironmentManagerDeps {
  workspace(id: string): Workspace | undefined
  profile(id: string): ConnectionProfile | undefined
  local(root: string): WorkspaceEnvironment
  connect(profile: ConnectionProfile, context: ConnectionContext & {
    generation: number
    assertCurrent(): void
    onDisconnect(): void
  }): Promise<EnvironmentConnection>
  onStatus?(status: ConnectionStatus): void
}

export class EnvironmentManager {
  private readonly entries = new Map<string, ConnectionEntry>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private nextGeneration = 0

  constructor(private readonly deps: EnvironmentManagerDeps) {}

  status(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? { connectionId: id, phase: 'disconnected', generation: 0 }
  }

  private publish(status: ConnectionStatus): void {
    this.statuses.set(status.connectionId, status)
    this.deps.onStatus?.(status)
  }

  private profile(id: string): ConnectionProfile {
    const profile = this.deps.profile(id)
    if (!profile || profile.kind !== 'ssh') throw new EnvironmentError('unbound')
    if (!profile.enabled) throw new EnvironmentError('disabled')
    return profile
  }

  private assertCurrent(id: string, entry: ConnectionEntry): void {
    const profile = this.profile(id)
    if (this.entries.get(id) !== entry || entry.controller.signal.aborted || profile.revision !== entry.profile.revision) {
      throw new EnvironmentError('disconnected')
    }
  }

  private scheduleIdle(id: string, entry: ConnectionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (entry.references !== 0 || entry.waiters !== 0 || this.entries.get(id) !== entry) return
    entry.idleTimer = setTimeout(() => { if (this.entries.get(id) === entry && entry.references === 0 && entry.waiters === 0) void this.disconnect(id) }, 60_000)
    entry.idleTimer.unref()
  }

  async connect(id: string, context: ConnectionContext): Promise<EnvironmentConnection> {
    context.signal.throwIfAborted()
    const profile = this.profile(id)
    let entry = this.entries.get(id)
    if (entry && (entry.profile.revision !== profile.revision || entry.controller.signal.aborted)) {
      await this.disconnect(id)
      entry = undefined
    }
    if (!entry) {
      entry = { profile: structuredClone(profile), generation: ++this.nextGeneration, controller: new AbortController(), waiters: 0, references: 0 }
      this.entries.set(id, entry)
      this.publish({ connectionId: id, phase: 'connecting', generation: entry.generation })
      const current = entry
      current.pending = this.deps.connect(current.profile, {
        senderId: context.senderId, signal: current.controller.signal, generation: current.generation,
        assertCurrent: () => this.assertCurrent(id, current),
        onDisconnect: () => { if (this.entries.get(id) === current) void this.disconnect(id) }
      }).then(async (connection) => {
        try { this.assertCurrent(id, current) } catch (error) { await connection.close(); throw error }
        current.connection = connection
        this.publish({ connectionId: id, phase: 'ready', generation: current.generation })
        return connection
      }).catch((error: unknown) => {
        if (this.entries.get(id) === current) {
          current.controller.abort()
          this.entries.delete(id)
          this.publish({ connectionId: id, phase: 'error', generation: current.generation,
            error: error instanceof EnvironmentError ? error.code : 'connection-failed',
            detail: error instanceof EnvironmentError ? error.detail : undefined })
        }
        throw error
      })
    }
    entry.waiters++
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
    const current = entry
    try { return await abortable(() => current.connection ? Promise.resolve(current.connection) : current.pending!, context.signal) } finally {
      entry.waiters--
      if (!entry.connection && entry.waiters === 0) entry.controller.abort()
      this.scheduleIdle(id, entry)
    }
  }

  async prepare(workspaceId: string, context: ConnectionContext): Promise<WorkspaceEnvironment> {
    const workspace = this.deps.workspace(workspaceId)
    if (!workspace) throw new EnvironmentError('unbound')
    const ref = normalizeEnvironmentRef(workspace.environment)
    if (ref.kind === 'unbound') throw new EnvironmentError('unbound')
    const environment = ref.kind === 'local' ? this.deps.local(workspace.rootPath)
      : { ...await this.connect(ref.connectionId, context), rootPath: workspace.rootPath }
    if (!workspace.rootPath && ref.kind === 'local') return environment
    const root = await abortable(() => environment.fs.realpath(workspace.rootPath), context.signal)
    const stat = await abortable(() => environment.fs.stat(root), context.signal)
    if (!stat.isDir) throw new EnvironmentError('invalid-path')
    environment.assertReady()
    return { ...environment, rootPath: root }
  }

  get(workspaceId: string): WorkspaceEnvironment {
    const workspace = this.deps.workspace(workspaceId)
    if (!workspace) throw new EnvironmentError('unbound')
    const ref = normalizeEnvironmentRef(workspace.environment)
    if (ref.kind === 'local') return this.deps.local(workspace.rootPath)
    if (ref.kind === 'unbound') throw new EnvironmentError('unbound')
    const entry = this.entries.get(ref.connectionId)
    if (!entry?.connection) throw new EnvironmentError('disconnected')
    this.assertCurrent(ref.connectionId, entry)
    entry.connection.assertReady()
    return { ...entry.connection, rootPath: workspace.rootPath }
  }

  acquire(workspaceId: string): EnvironmentLease {
    return this.retain(this.get(workspaceId))
  }

  retain(environment: WorkspaceEnvironment): EnvironmentLease {
    environment.assertReady()
    const current = environment.remote ? [...this.entries].find(([, entry]) => entry.connection?.key === environment.key && entry.generation === environment.generation) : undefined
    if (environment.remote && !current) throw new EnvironmentError('disconnected')
    const [id, entry] = current ?? []
    if (entry) {
      this.assertCurrent(id!, entry)
      entry.references++
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
    }
    let released = false
    return { environment, release: () => {
      if (released) return
      released = true
      if (entry) { entry.references--; this.scheduleIdle(id!, entry) }
    } }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.controller.abort()
    this.publish({ connectionId: id, phase: 'disconnected', generation: entry.generation })
    await entry.connection?.close()
  }

  async shutdown(): Promise<void> { await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id))) }
}