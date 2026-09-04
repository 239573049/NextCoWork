/**
 * MCP 服务器列表的渲染层缓存。
 *
 * 照 `stores/models.ts` 的写法:全局一份 + `inflight` 去重。多出来的一件事是
 * **订阅 `mcp:changed`** —— MCP 的状态会自己变(后台连接完成、连接掉线、
 * 工具数变了),不只是被这个页面改。只在打开设置页时拉一次的话,用户会
 * 盯着一行「连接中」看到天亮,而它其实早就连上了。
 */
import { create } from 'zustand'
import type { McpServerConfig, McpServerStatus } from '../../../shared/domain/mcp'
import { on } from '../services/ipc'
import { listMcpServers, removeMcpServer, upsertMcpServer } from '../services/mcp'

interface McpState {
  servers: McpServerStatus[]
  loaded: boolean
  /** 加载失败的原因。`null` = 没失败 —— 空列表和「读不出来」是两回事 */
  error: string | null
  load: () => Promise<void>
  upsert: (config: McpServerConfig) => Promise<void>
  remove: (id: string) => Promise<void>
}

let inflight: Promise<void> | null = null
let subscribed = false

/**
 * ★ **订阅在第一次 `load()` 时装,不在模块顶层装。**
 *
 * 顶层 `on(...)` 会在 import 那一刻就去碰 `window.nextcowork`,而 `services/ipc.ts`
 * 的 `bridge()` 在桥没挂上时是**抛异常**的 —— 于是任何 import 到这个 store 的
 * 单测都会在 import 阶段炸,炸点还离原因很远。
 *
 * 装上就不退订:这是进程级单例,活到窗口关闭为止。放进组件的 useEffect 才是错的 ——
 * 设置页一关就收不到状态变化(MCP 是会自己变的:后台连上、掉线、工具数变),
 * 下次打开又得从头拉一遍。
 */
function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  on('mcp:changed', ({ servers }) => {
    useMcpStore.setState({ servers, loaded: true, error: null })
  })
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  loaded: false,
  error: null,

  async load() {
    subscribeOnce()
    inflight ??= listMcpServers()
      .then((servers) => {
        set({ servers, loaded: true, error: null })
      })
      .catch((err: unknown) => {
        console.error('[mcp] 服务器列表加载失败:', err)
        // ★ 仍然置 loaded,但带上 error —— 否则空列表会被画成「你还没加过服务器」,
        // 而用户明明加过。那句话会让人以为配置丢了。
        set({ loaded: true, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  async upsert(config) {
    await upsertMcpServer(config)
    // 不在这里 set —— 主进程写完会广播 `mcp:changed`,让那一条路径成为唯一的更新入口。
    // 两条路径都写的话,「本地先改、广播再改」中间那一帧会闪一次旧状态。
  },

  async remove(id) {
    await removeMcpServer(id)
  }
}))
