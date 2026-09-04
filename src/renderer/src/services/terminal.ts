import type { TerminalBuffer, TerminalInfo } from '../../../shared/domain/terminal'
import { invoke, on, send } from './ipc'

export function createTerminal(req: {
  workspaceId: string
  id?: string
  cwd?: string
  cols: number
  rows: number
}): Promise<TerminalInfo> {
  return invoke('terminal:create', req)
}

export function getTerminalBuffer(id: string): Promise<TerminalBuffer> {
  return invoke('terminal:getBuffer', { id })
}

export function listTerminals(workspaceId: string): Promise<TerminalInfo[]> {
  return invoke('terminal:list', { workspaceId })
}

export function killTerminal(id: string): Promise<void> {
  return invoke('terminal:kill', { id })
}

export function writeTerminal(id: string, data: string): void {
  send('terminal:write', { id, data })
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  send('terminal:resize', { id, cols, rows })
}

export function onTerminalData(callback: (payload: { id: string; seq: number; chunk: string }) => void): () => void {
  return on('terminal:data', callback)
}

export function onTerminalExit(callback: (payload: { id: string; code: number }) => void): () => void {
  return on('terminal:exit', callback)
}
