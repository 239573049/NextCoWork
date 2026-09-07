/**
 * Preload —— **安全边界**,不是转发层(方案 §3 规则 6)。
 *
 * 三条约束在这个文件里落地:
 * 1. 每个频道在**运行时**对着契约生成的白名单校验。仅有编译期类型不够 ——
 *    被攻破的渲染层可以 `invoke(任意字符串)`,而在本架构里那等价于经工具层
 *    获得任意文件系统访问。
 * 2. `on()` 返回退订函数(协议 §3.3)。否则 HMR 会叠加几十个监听器,
 *    MaxListenersExceededWarning,每次状态更新触发 N 次 —— 只在 dev 出现,极难定位。
 * 3. 绝不把 IpcRendererEvent 交给渲染层 —— 它带着 `sender`,是个现成的逃逸口。
 *
 * ★ 这个文件必须被**完整打包成单文件**,否则 `sandbox: true` 下无法 require
 * (electron.vite.config.ts 里的 `isolatedEntries: true` + `externalizeDeps: false`)。
 * 所以这里只 import 类型和三个纯常量,不 import 任何 node 内置模块。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  isEventChannel,
  isInvokeChannel,
  isSendChannel,
  type EventChannel,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type IpcEventMap,
  type IpcResult,
  type IpcSendMap,
  type SendChannel,
  type Unsubscribe
} from '../shared/ipc/contract'

const api = {
  /**
   * 渲染 → 主,要返回值。**永远 resolve**,失败经 IpcResult 信封表达
   * —— 主进程侧的 safeHandle 保证异常不穿过 ipcMain.handle(方案 §3 规则 3)。
   */
  invoke<K extends InvokeChannel>(ch: K, req: InvokeReq<K>): Promise<IpcResult<InvokeRes<K>>> {
    if (!isInvokeChannel(ch)) {
      return Promise.reject(new Error(`[preload] 未登记的 invoke 频道: ${String(ch)}`))
    }
    return ipcRenderer.invoke(ch, req) as Promise<IpcResult<InvokeRes<K>>>
  },

  /** 渲染 → 主,高频无返回(终端按键、Tab 拖动落盘)。协议 §3.2 */
  send<K extends SendChannel>(ch: K, payload: IpcSendMap[K]): void {
    if (!isSendChannel(ch)) throw new Error(`[preload] 未登记的 send 频道: ${String(ch)}`)
    ipcRenderer.send(ch, payload)
  },

  /**
   * 主 → 渲染。**必须**用返回值退订 —— 在 useEffect 的清理阶段调它。
   * contextBridge 支持把函数作为返回值传回渲染层(会被代理),这是官方支持的用法。
   */
  on<K extends EventChannel>(ch: K, cb: (payload: IpcEventMap[K]) => void): Unsubscribe {
    if (!isEventChannel(ch)) throw new Error(`[preload] 未登记的 event 频道: ${String(ch)}`)
    // 只把 payload 交出去:IpcRendererEvent 带 sender,不能给渲染层
    const listener = (_e: IpcRendererEvent, payload: IpcEventMap[K]): void => cb(payload)
    ipcRenderer.on(ch, listener)
    return () => {
      ipcRenderer.removeListener(ch, listener)
    }
  },

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },

  /**
   * 渲染层唯一的平台来源。**只有 macOS 有红绿灯**,而侧边栏表头和外层 Tab 条
   * 都为它们硬留了一块位置(`pl-[74px]` / `pl-[78px]`)—— 别的平台上那是空洞。
   * 反过来,非 macOS 的右上角画着自绘的三颗窗口按钮(`shell/WindowControls.tsx`),
   * 画不画、以及顶栏右端让不让位,也都由这个值决定。
   *
   * 沙箱 preload 的 `process` 是个 polyfill,但 `platform` 在里面
   * (`versions` / `contextIsolated` 也来自同一份,上面已经在用)。
   */
  platform: process.platform
} as const

export type NextCoWorkApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('nextcowork', api)
} else {
  // 走到这里说明 webPreferences 被改坏了。宁可白屏,也不要静默降级成一个没有边界的桥。
  throw new Error('contextIsolation must be enabled')
}
