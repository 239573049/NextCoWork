/**
 * 搜索服务的 handler —— 「设置 › 连接 › 搜索服务」那一页背后的六条频道。
 *
 * ★ **明文 Key 只有一个方向:进。**
 * `setCredential` 写进 safeStorage 之后,回程只带 `{hasKey, last4, encryptionAvailable}`;
 * 没有任何一条频道能把它读出来(方案 §9)。`service.ts` 那个装配槽是明文的
 * **唯一**消费者,而它在主进程里,不过 IPC。
 *
 * `list` 之所以还带一个 `last4`,是因为界面要显示「已配置 ✓ ····1234」——
 * 那需要知道**有没有**和**末四位**,但不需要知道是什么。
 */
import type {
  SearchProviderId,
  SearchProviderStatus
} from '../../shared/domain/search'
import { SEARCH_PROVIDER_IDS, isUsableProvider, searchSecretRef } from '../../shared/domain/search'
import type { CredentialInfo } from '../../shared/domain/provider'
import { getHost } from '../runtime'
import { testProvider } from '../search/service'
import { last4Of, searchStatuses } from '../search/status'
import { store } from '../state/store'
import { windows } from '../window/registry'

/** 合成在 `search/status.ts` —— 那一层不认识 electron,`runtime.ts` 也要用它 */
export async function listSearchProviders(): Promise<SearchProviderStatus[]> {
  return searchStatuses(getHost().secrets)
}

async function broadcast(): Promise<void> {
  windows.emitToAll('websearch:changed', { providers: await listSearchProviders() })
}

/**
 * ★ 标了 `unavailable` 的家**不能被启用**。
 *
 * 界面已经把开关禁掉了,但这条频道是渲染层之外的第二个入口 —— 而「界面禁掉了」
 * 不是一条约束,只是一次提示。放进来的话它会进 `searchChain`、拿不到适配器、
 * 每次搜索白跑一圈 continue。
 */
export async function setSearchEnabled(id: SearchProviderId, enabled: boolean): Promise<void> {
  if (enabled && !isUsableProvider(id)) {
    throw new Error('这家搜索服务目前用不了,不能启用 —— 原因见列表里那行说明。')
  }
  const current = store.listSearchProviders().find((c) => c.id === id)
  if (current === undefined) throw new Error(`没有 ID 为 "${id}" 的搜索服务。`)
  store.putSearchProvider({ ...current, enabled })
  await broadcast()
}

/**
 * 拖拽排序的落点。**整批写、一个事务** —— 半新半旧的 priority 会让
 * 「今天先试 A、明天先试 B」,而那种不确定比顺序不合心意难查得多。
 *
 * 传进来的 `ids` 要是全集。缺了的家会掉到末尾并保持原有相对顺序,
 * 而不是被删掉 —— 这条频道是排序,不是设置成员。
 */
export async function reorderSearchProviders(ids: readonly SearchProviderId[]): Promise<void> {
  const valid = new Set<string>(SEARCH_PROVIDER_IDS)
  const wanted = ids.filter((id) => valid.has(id))
  const seen = new Set<SearchProviderId>(wanted)
  const rest = store
    .listSearchProviders()
    .map((c) => c.id)
    .filter((id) => !seen.has(id))

  const order = [...wanted, ...rest]
  const byId = new Map(store.listSearchProviders().map((c) => [c.id, c]))
  store.putSearchProviders(
    order.map((id, priority) => ({ ...byId.get(id)!, priority }))
  )
  await broadcast()
}

/**
 * 写 Key。`secrets.set` 在密钥环不可用时会**拒绝**(不是静默明文落盘),
 * 异常经 `safeHandle` 的信封回到界面。
 */
export async function setSearchCredential(
  id: SearchProviderId,
  apiKey: string
): Promise<CredentialInfo> {
  const host = getHost()
  const trimmed = apiKey.trim()
  if (trimmed === '') throw new Error('API Key 不能是空的。要清除请用「清除」。')

  await host.secrets.set(searchSecretRef(id), trimmed)
  await broadcast()
  return {
    hasKey: true,
    last4: last4Of(trimmed) ?? null,
    encryptionAvailable: host.secrets.available()
  }
}

/**
 * 清 Key。**顺手把这家关掉** —— 留着「已启用但没 Key」的状态,
 * `searchChain` 会把它滤掉,于是界面上开关是开的、搜索却永远不经过它。
 */
export async function clearSearchCredential(id: SearchProviderId): Promise<void> {
  store.clearSearchCredential(id)
  const current = store.listSearchProviders().find((c) => c.id === id)
  if (current !== undefined && current.enabled) {
    store.putSearchProvider({ ...current, enabled: false })
  }
  await broadcast()
}

/**
 * 「测试」按钮。真发一次最小查询 —— 假的 ping 测不出「Key 过期」和
 * 「额度用完」,而那两样正是用户点这个按钮时最想知道的。
 *
 * 30 秒硬上限:`service.ts` 里每家 15 秒,这里再兜一层,免得一个不回包的
 * 服务器把界面上那颗转圈图标留到天荒地老。
 */
const TEST_TIMEOUT_MS = 30_000

export async function testSearchProvider(
  id: SearchProviderId
): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
  const host = getHost()
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    ctl.abort(new Error('测试超时'))
  }, TEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await testProvider(id, { fetch: host.fetch, signal: ctl.signal }, () => host.clock.now())
  } finally {
    clearTimeout(timer)
  }
}
