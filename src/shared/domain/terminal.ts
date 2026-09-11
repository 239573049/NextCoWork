/**
 * 终端会话 —— 方案 §6。这是唯一的原生模块(node-pty)。
 */

export interface TerminalInfo {
  id: string
  workspaceId: string
  title: string
  /** cwd 取工作区根 */
  cwd: string
  shell: string
  cols: number
  rows: number
  alive: boolean
  createdAt: number
}

export interface TerminalCreateRequest {
  workspaceId: string
  /** Renderer tab id; reusing it reconnects to an existing shell after remount. */
  id?: string
  cwd?: string
  cols: number
  rows: number
  approval?: string
}

export interface TerminalIntent {
  id: string
  terminalId: string
  workspaceId: string
  connection: string
  cwd: string
  shell: string
  expiresAt: number
}

export type TerminalPreparation =
  | { kind: 'ready'; terminal: TerminalInfo }
  | { kind: 'approval'; intent: TerminalIntent }

/**
 * ★ 主进程保留环形缓冲(每终端 ~256KB)供 terminal:getBuffer,
 * 否则切走再切回来 xterm 重新挂载,历史全没了(方案 §6)。
 */
export const TERMINAL_BUFFER_BYTES = 256 * 1024

/**
 * ★ 输出必须合批:一条 `yes` 命令能每秒产生上万行。
 * 同 §8 的 16–33ms 合批规则,外加单批上限。
 */
export const TERMINAL_FLUSH_MS = 16
export const TERMINAL_MAX_CHUNK_BYTES = 64 * 1024

export interface TerminalBuffer {
  id: string
  /** 环形缓冲里现存的内容;可能从中间截断 */
  data: string
  truncated: boolean
  /** Last output batch included in data; lets renderer deduplicate reconnect races. */
  seq: number
}
