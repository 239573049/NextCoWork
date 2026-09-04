/**
 * 搜索服务 —— 「设置 › 连接 › 搜索服务」那一页调的六条频道。
 *
 * ★ 叫 `websearch` 不叫 `search`:本仓库已经有一个「搜索」了 ——
 * `conversations:searchAll` 那个会话全文检索。见 contract.ts 里同名的那段注释。
 */
import type { CredentialInfo } from '../../../shared/domain/provider'
import type { SearchProviderId, SearchProviderStatus } from '../../../shared/domain/search'
import { invoke, tryInvoke } from './ipc'

export function listSearchProviders(): Promise<SearchProviderStatus[]> {
  return invoke('websearch:list', undefined)
}

export function setSearchEnabled(id: SearchProviderId, enabled: boolean): Promise<void> {
  return invoke('websearch:setEnabled', { id, enabled })
}

/** 拖完给全量顺序,不给 `{from,to}` —— 界面已经算好了 */
export function reorderSearchProviders(ids: SearchProviderId[]): Promise<void> {
  return invoke('websearch:reorder', { ids })
}

/** ★ 只写不读:回程是 `{hasKey, last4}`,明文有去无回(方案 §9) */
export function setSearchCredential(
  id: SearchProviderId,
  apiKey: string
): Promise<CredentialInfo> {
  return invoke('websearch:setCredential', { id, apiKey })
}

export function clearSearchCredential(id: SearchProviderId): Promise<void> {
  return invoke('websearch:clearCredential', { id })
}

/**
 * 「测试」按钮。用 `tryInvoke` —— 理由同 `testMcpConnection`:
 * Key 过期、额度用完都是这个按钮要报告的**结果**,不是要吞掉的异常。
 */
export function testSearchProvider(
  id: SearchProviderId
): ReturnType<typeof tryInvoke<'websearch:test'>> {
  return tryInvoke('websearch:test', { id })
}
