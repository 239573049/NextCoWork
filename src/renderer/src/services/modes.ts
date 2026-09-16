import type { ModeDefinition } from '../../../shared/domain/mode'
import type { Unsubscribe } from '../../../shared/ipc/contract'
import { invoke, on } from './ipc'

export interface ModeCatalog {
  modes: readonly ModeDefinition[]
  diagnostics: ReadonlyArray<{ path: string; message: string }>
  tools: readonly string[]
}

export function listModes(workspaceId: string): Promise<ModeCatalog> {
  return invoke('modes:list', { workspaceId })
}

export function onModesChanged(listener: () => void): Unsubscribe {
  return on('modes:changed', listener)
}
