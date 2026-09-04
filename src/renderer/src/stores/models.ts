/**
 * 上游供应商 / 模型别名的渲染层缓存。
 *
 * **一个全局 store 而不是每个 Composer 各自 fetch 一次**:一个工作区里开五个
 * 对话 Tab 就是五次 `provider:listModels`,而这张表全应用只有一份。
 *
 * 它不放进 `useWindowStore` —— 那是**窗口**状态(哪些 Tab 开着、哪个激活),
 * 而模型表是**应用**数据。混在一起的话,一次模型列表刷新会让整条 Tab 栏重渲染。
 *
 * **订阅 `provider:changed`**(照 `stores/mcp.ts`):设置页改完供应商,主进程广播,
 * 这里更新 —— 于是**输入框那颗模型药丸不用重新打开就跟着变了**,而且多窗口一致。
 * 写操作因此都不本地 `set`,广播是唯一的更新入口。
 */
import { create } from 'zustand'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import { on } from '../services/ipc'
import { listModels, listProviders } from '../services/provider'

interface ModelsState {
  providers: UpstreamProvider[]
  models: ModelAlias[]
  /** 首次加载完成前下拉框显示「加载中」,而不是显示成「一个模型都没配」 */
  loaded: boolean
  load: () => Promise<void>
  /**
   * 绕过 `load()` 的去重再拉一次。
   *
   * ★ 和 `load()` 的区别不是「强制」两个字:`load()` 里那个 `inflight ??=` 会让
   * **已经加载过**的调用直接命中一个早就 resolve 的 promise,什么都不发。
   * 广播是兜底路径(`provider:changed` 已经把新数据带过来了),这个留给
   * 「我怀疑不同步了」的显式重取。
   */
  reload: () => Promise<void>
  /** 别名 → 提供它的 provider。模型药丸上要显示 `供应商 / 模型` 两段 */
  providerOf: (alias: string) => UpstreamProvider | undefined
}

let inflight: Promise<void> | null = null
let subscribed = false

/**
 * 订阅装在第一次 `load()` 里,不在模块顶层 —— 顶层 `on(...)` 会在 import 那一刻
 * 就去碰 `window.nextcowork`,而 `services/ipc.ts` 的 `bridge()` 在桥没挂上时是
 * **抛异常**的,于是任何 import 到这个 store 的单测都会在 import 阶段炸。
 * 理由和 `stores/mcp.ts` 那段一模一样,改一处记得改两处。
 */
function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  on('provider:changed', ({ providers, models }) => {
    useModelsStore.setState({ providers, models, loaded: true })
  })
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  providers: [],
  models: [],
  loaded: false,

  async load() {
    subscribeOnce()
    // 五个 Tab 同时挂载 = 五次并发请求。共享同一个 promise,只发一次。
    inflight ??= fetchAll(set)
    return inflight
  },

  async reload() {
    subscribeOnce()
    inflight = fetchAll(set)
    return inflight
  },

  providerOf(alias) {
    const m = get().models.find((x) => x.alias === alias)
    if (m === undefined) return undefined
    return get().providers.find((p) => p.id === m.providerId)
  }
}))

function fetchAll(set: (partial: Partial<ModelsState>) => void): Promise<void> {
  return Promise.all([listProviders(), listModels()])
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
}
