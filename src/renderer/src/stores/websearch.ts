/**
 * 搜索服务列表的渲染层缓存。结构与 `stores/mcp.ts` 相同,理由也相同。
 *
 * 这一页的写操作有四种(开关 / 排序 / 存 Key / 清 Key),**一律不本地 set**,
 * 全都等 `websearch:changed` 回来 —— 因为它们互相牵连:清 Key 会顺手把那家
 * 关掉(见 `main/ipc/websearch.ts`),本地乐观更新只改开关不改 hasKey 的话,
 * 界面上会出现「没 Key 但开着」这种主进程根本不允许的状态。
 *
 * 唯一的例外是拖拽排序,见 `reorder` 的注释。
 */
import { create } from 'zustand'
import type { SearchProviderId, SearchProviderStatus } from '../../../shared/domain/search'
import { on } from '../services/ipc'
import {
  clearSearchCredential,
  listSearchProviders,
  reorderSearchProviders,
  setSearchCredential,
  setSearchEnabled
} from '../services/websearch'

interface WebSearchState {
  providers: SearchProviderStatus[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  setEnabled: (id: SearchProviderId, enabled: boolean) => Promise<void>
  reorder: (ids: SearchProviderId[]) => Promise<void>
  setCredential: (id: SearchProviderId, apiKey: string) => Promise<void>
  clearCredential: (id: SearchProviderId) => Promise<void>
}

let inflight: Promise<void> | null = null
let subscribed = false

/** 订阅在第一次 `load()` 时装,不在模块顶层 —— 理由见 `stores/mcp.ts` 的同名函数 */
function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  on('websearch:changed', ({ providers }) => {
    useWebSearchStore.setState({ providers: byPriority(providers), loaded: true, error: null })
  })
}

const byPriority = (list: SearchProviderStatus[]): SearchProviderStatus[] =>
  [...list].sort((a, b) => a.config.priority - b.config.priority)

export const useWebSearchStore = create<WebSearchState>((set, get) => ({
  providers: [],
  loaded: false,
  error: null,

  async load() {
    subscribeOnce()
    inflight ??= listSearchProviders()
      .then((providers) => {
        set({ providers: byPriority(providers), loaded: true, error: null })
      })
      .catch((err: unknown) => {
        console.error('[websearch] 搜索服务列表加载失败:', err)
        set({ loaded: true, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  async setEnabled(id, enabled) {
    await setSearchEnabled(id, enabled)
  },

  /**
   * ★ **只有排序做乐观更新。** 拖拽是连续动作:等一次 IPC 往返再重排,
   * 松手那一刻列表会先弹回原位再跳到新位置,而那一下看起来像「拖失败了」。
   * 主进程的广播随后会覆盖这份乐观状态,顺序不一致时以它为准。
   */
  async reorder(ids) {
    const rank = new Map(ids.map((id, i) => [id, i]))
    set({
      providers: [...get().providers]
        .map((p) => ({ ...p, config: { ...p.config, priority: rank.get(p.config.id) ?? 99 } }))
        .sort((a, b) => a.config.priority - b.config.priority)
    })
    await reorderSearchProviders(ids)
  },

  async setCredential(id, apiKey) {
    await setSearchCredential(id, apiKey)
  },

  async clearCredential(id) {
    await clearSearchCredential(id)
  }
}))
