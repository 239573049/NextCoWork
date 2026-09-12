import type { HookDefinition, HookListItem, HookScope } from '../../../shared/domain/hook'
import { invoke, on } from './ipc'

export function listHooks(workspaceId?: string): Promise<HookListItem[]> {
  return invoke('hooks:list', workspaceId === undefined ? {} : { workspaceId })
}

export function hookDiagnostics(workspaceId?: string): Promise<Array<{ path: string; message: string }>> {
  return invoke('hooks:diagnostics', workspaceId === undefined ? {} : { workspaceId })
}

export function saveHook(
  scope: HookScope,
  hook: Omit<HookDefinition, 'id'> & { id?: string },
  workspaceId?: string
): Promise<HookListItem> {
  return invoke('hooks:save', { scope, hook, ...(workspaceId === undefined ? {} : { workspaceId }) })
}

export function deleteHook(scope: HookScope, id: string, workspaceId?: string): Promise<void> {
  return invoke('hooks:delete', { scope, id, ...(workspaceId === undefined ? {} : { workspaceId }) })
}

export function setHookEnabled(
  scope: HookScope,
  id: string,
  enabled: boolean,
  workspaceId?: string
): Promise<void> {
  return invoke('hooks:setEnabled', { scope, id, enabled, ...(workspaceId === undefined ? {} : { workspaceId }) })
}

export function onHooksChanged(callback: () => void): () => void {
  return on('hooks:changed', callback)
}
