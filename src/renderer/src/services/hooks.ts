import type { HookDefinition, HookEvent, HookListItem, HookRunReport, HookScope } from '../../../shared/domain/hook'
import { invoke, on } from './ipc'

/** 试运行。★ 跑的是弹层里此刻的草稿，不读磁盘上那一条。 */
export function testHook(
  scope: HookScope,
  event: HookEvent,
  command: string,
  timeoutMs: number,
  workspaceId?: string
): Promise<HookRunReport> {
  return invoke('hooks:test', { scope, event, command, timeoutMs, ...(workspaceId === undefined ? {} : { workspaceId }) })
}

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
