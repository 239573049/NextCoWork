import type { HookDiagnostic, HookListItem, HookRunReport, HookScope, HookUpsert } from '../../../shared/domain/hook'
import type { InvokeReq } from '../../../shared/ipc/contract'
import { invoke, on } from './ipc'

/**
 * 试运行。★ 跑的是弹层里此刻的草稿，不读磁盘上那一条。
 *
 * ★ 请求体**整条转发**，不在这一层拆开重组：它按 `type` 分成两支（command 带
 *   command、prompt 带 prompt），拆成位置参数的话，调用点就没有任何东西拦得住
 *   「一条 prompt 草稿带着 command 字段发出去」——而主进程按 `type` 只读一支，
 *   那个多余的字段会**静默消失**，看起来什么都不像出了问题。
 */
export function testHook(req: InvokeReq<'hooks:test'>): Promise<HookRunReport> {
  return invoke('hooks:test', req)
}

export function listHooks(workspaceId?: string): Promise<HookListItem[]> {
  return invoke('hooks:list', workspaceId === undefined ? {} : { workspaceId })
}

export function hookDiagnostics(workspaceId?: string): Promise<HookDiagnostic[]> {
  return invoke('hooks:diagnostics', workspaceId === undefined ? {} : { workspaceId })
}

export function saveHook(
  scope: HookScope,
  hook: HookUpsert,
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
