import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import * as pty from 'node-pty'
import type { TerminalBuffer, TerminalCreateRequest, TerminalInfo } from '../shared/domain/terminal'
import { TERMINAL_BUFFER_BYTES, TERMINAL_FLUSH_MS, TERMINAL_MAX_CHUNK_BYTES } from '../shared/domain/terminal'
import { terminalTopic, windows } from './window/registry'
import { store } from './state/store'
import type { WebContents } from 'electron'
import { IpcError } from './ipc/errors'

type Session = {
  info: TerminalInfo
  process: pty.IPty
  buffer: string
  truncated: boolean
  pending: string
  flushTimer: NodeJS.Timeout | null
  seq: number
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['ComSpec'] ?? 'cmd.exe'
  return process.env['SHELL'] ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

function safeSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(2, Math.floor(value)) : fallback
}

/** Owns long-lived interactive shells. It intentionally lives in main, never in the renderer. */
class TerminalHost {
  private readonly sessions = new Map<string, Session>()

  create(req: TerminalCreateRequest & { id?: string }, sender: WebContents): TerminalInfo {
    const existing = req.id ? this.sessions.get(req.id) : undefined
    if (existing) {
      if (existing.info.workspaceId !== req.workspaceId) {
        throw new IpcError('unknown', '终端不属于当前工作区')
      }
      windows.subscribe(terminalTopic(existing.info.id), sender)
      return existing.info
    }

    const workspace = store.getWorkspace(req.workspaceId)
    if (!workspace) throw new IpcError('unknown', `工作区不存在: ${req.workspaceId}`)
    const requestedCwd = req.cwd ? resolve(req.cwd) : workspace.rootPath
    const relativeCwd = relative(workspace.rootPath, requestedCwd)
    const insideWorkspace = relativeCwd === '' || (!relativeCwd.startsWith('..') && !isAbsolute(relativeCwd))
    const cwd = insideWorkspace && existsSync(requestedCwd)
      ? requestedCwd
      : workspace.rootPath
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new IpcError('unknown', `终端工作目录不可用: ${cwd}`)
    }

    const id = req.id ?? randomUUID()
    const cols = safeSize(req.cols, 100)
    const rows = safeSize(req.rows, 28)
    const shell = defaultShell()
    const child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    const info: TerminalInfo = {
      id,
      workspaceId: req.workspaceId,
      title: basename(cwd) || '终端',
      cwd,
      shell,
      cols,
      rows,
      alive: true,
      createdAt: Date.now()
    }
    const session: Session = {
      info,
      process: child,
      buffer: '',
      truncated: false,
      pending: '',
      flushTimer: null,
      seq: 0
    }
    this.sessions.set(id, session)
    windows.subscribe(terminalTopic(id), sender)

    child.onData((data) => {
      session.pending += data
      if (session.pending.length >= TERMINAL_MAX_CHUNK_BYTES) this.flush(id)
      else if (session.flushTimer === null) {
        session.flushTimer = setTimeout(() => this.flush(id), TERMINAL_FLUSH_MS)
      }
    })
    child.onExit(({ exitCode }) => {
      if (session.flushTimer !== null) clearTimeout(session.flushTimer)
      session.flushTimer = null
      this.flush(id)
      session.info = { ...session.info, alive: false }
      windows.emitToTopic(terminalTopic(id), 'terminal:exit', { id, code: exitCode })
    })
    return info
  }

  attach(id: string, sender: WebContents): TerminalBuffer {
    const session = this.sessions.get(id)
    if (!session) throw new IpcError('unknown', `终端不存在: ${id}`)
    windows.subscribe(terminalTopic(id), sender)
    return { id, data: session.buffer, truncated: session.truncated, seq: session.seq }
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.info.workspaceId === workspaceId)
      .map((session) => session.info)
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.info.alive || typeof data !== 'string') return
    session.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session || !session.info.alive) return
    const nextCols = safeSize(cols, session.info.cols)
    const nextRows = safeSize(rows, session.info.rows)
    session.process.resize(nextCols, nextRows)
    session.info = { ...session.info, cols: nextCols, rows: nextRows }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.flushTimer !== null) clearTimeout(session.flushTimer)
    if (session.info.alive) session.process.kill()
    this.sessions.delete(id)
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
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
