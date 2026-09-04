/**
 * 上游供应商 / 模型别名的渲染层缓存。
 *
 * **一个全局 store 而不是每个 Composer 各自 fetch 一次**:一个工作区里开五个
 * 对话 Tab 就是五次 `provider:listModels`,而这张表全应用只有一份。
 *
 * 它不放进 `useWindowStore` —— 那是**窗口**状态(哪些 Tab 开着、哪个激活),
 * 而模型表是**应用**数据。混在一起的话,一次模型列表刷新会让整条 Tab 栏重渲染。
 *
 * 步骤 4 的设置页写入面接上之后,`upsert` / `remove` 完要调 `reload()`;
 * 现在只有读,所以只有 `load()`。
 */
import { create } from 'zustand'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import { listModels, listProviders } from '../services/provider'

interface ModelsState {
  providers: UpstreamProvider[]
  models: ModelAlias[]
  /** 首次加载完成前下拉框显示「加载中」,而不是显示成「一个模型都没配」 */
  loaded: boolean
  load: () => Promise<void>
  /** 别名 → 提供它的 provider。模型药丸上要显示 `供应商 / 模型` 两段 */
  providerOf: (alias: string) => UpstreamProvider | undefined
}

let inflight: Promise<void> | null = null

export const useModelsStore = create<ModelsState>((set, get) => ({
  providers: [],
  models: [],
  loaded: false,

  async load() {
    // 五个 Tab 同时挂载 = 五次并发请求。共享同一个 promise,只发一次。
    inflight ??= Promise.all([listProviders(), listModels()])
      .then(([providers, models]) => {
        set({ providers, models, loaded: true })
      })
      .catch((err: unknown) => {
        console.error('[models] 模型列表加载失败:', err)
        // 仍然置 loaded:否则下拉框永远停在「加载中」,用户看不出是失败了
        set({ loaded: true })
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  providerOf(alias) {
    const m = get().models.find((x) => x.alias === alias)
    if (m === undefined) return undefined
    return get().providers.find((p) => p.id === m.providerId)
  }
}))
