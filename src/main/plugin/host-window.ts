/**
 * 插件宿主的 Electron 实现 —— `PluginRuntime` 的那一半机制。
 *
 * ## ★ 与计划的一处偏离:**每个插件一个隐藏 BrowserWindow**,不是一个窗口 N 个 iframe
 *
 * 计划写的是「一个隐藏窗口 + 每插件一个 `ncw-plugin://<id>` 的 iframe」,
 * 理由是站点隔离会把它们分到不同 renderer 进程。那个理由成立,但同样的隔离
 * 用**独立窗口**也能得到,而且少了三样东西:
 *
 * 1. 宿主页面要在 iframe 与主进程之间转交 MessagePort —— 一段没有业务价值、
 *    却必须完全正确的握手代码;
 * 2. `allow-same-origin` 的取舍要在安全评审里解释(opaque origin 会让
 *    `localStorage` / `IndexedDB` 抛异常);
 * 3. 一个 iframe 崩溃时,宿主页面还活着但那一格已经死了 —— 需要额外的存活探测。
 *
 * 独立窗口里,**进程的生死就是插件的生死**:`render-process-gone` 是一个明确的
 * 信号,`destroy()` 是一个确定的收尾。代价是每个插件多一个 BrowserWindow 的
 * 固定开销,而这条被懒激活 + 空闲 5 分钟休眠压住了(见 `manager.ts`)。
 *
 * ## 身份从哪来
 *
 * `webContents.id → pluginId` 的映射**只在这里建立**,建立的时刻是窗口创建的
 * 那一刻。插件发上来的每一条消息都按 `event.sender.id` 反查身份 ——
 * 报文里有没有 pluginId 字段无关紧要,主进程一个字都不看。
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { PluginInvocation, PluginRequest, PluginResponse } from '../../shared/plugin/protocol'
import type { PluginRuntime } from './manager'
import { setPluginRootResolver } from './protocol'

/** 插件窗口用的独立分区 —— 与主窗口的存储完全隔离。 */
const PARTITION = 'persist:plugin-host'

/** preload 只暴露三件事:发请求、收反向调用、报告就绪。 */
const CHANNEL_REQUEST = 'plugin:rpc'
const CHANNEL_INVOKE = 'plugin:invoke'
const CHANNEL_INVOKE_RESULT = 'plugin:invokeResult'
const CHANNEL_READY = 'plugin:ready'

interface HostEntry {
  window: BrowserWindow
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  /** 反向调用的在途表:invocation id → settle */
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  nextInvocationId: number
}

export class ElectronPluginRuntime implements PluginRuntime {
  private readonly hosts = new Map<string, HostEntry>()
  private readonly byWebContents = new Map<number, string>()
  private readonly roots = new Map<string, { root: string; main: string }>()

  constructor(
    private readonly handleRequest: (pluginId: string, request: PluginRequest) => Promise<PluginResponse>,
    private readonly preloadPath: string
  ) {
    setPluginRootResolver((pluginId) => this.roots.get(pluginId))
    this.installIpc()
  }

  private installIpc(): void {
    ipcMain.handle(CHANNEL_REQUEST, async (event: IpcMainInvokeEvent, raw: unknown): Promise<PluginResponse> => {
      /*
        ★ 身份来自 `event.sender.id`,**不是报文里的任何字段**。
        认不出的发送者一律拒 —— 那意味着一个不是我们创建的窗口在用这条频道。
      */
      const pluginId = this.byWebContents.get(event.sender.id)
      const request = raw as PluginRequest
      const id = typeof request?.id === 'number' ? request.id : 0
      if (pluginId === undefined) {
        return { id, ok: false, error: { code: 'permission_denied', message: 'unrecognised sender' } }
      }
      return this.handleRequest(pluginId, { id, method: String(request?.method), params: request?.params })
    })

    ipcMain.on(CHANNEL_READY, (event) => {
      const pluginId = this.byWebContents.get(event.sender.id)
      if (pluginId === undefined) return
      this.hosts.get(pluginId)?.resolveReady()
    })

    ipcMain.on(CHANNEL_INVOKE_RESULT, (event, raw: unknown) => {
      const pluginId = this.byWebContents.get(event.sender.id)
      if (pluginId === undefined) return
      const result = raw as { id: number; ok: boolean; data?: unknown; error?: { message: string } }
      const entry = this.hosts.get(pluginId)
      const settle = entry?.pending.get(result.id)
      if (settle === undefined) return
      entry?.pending.delete(result.id)
      if (result.ok) settle.resolve(result.data)
      else settle.reject(new Error(result.error?.message ?? 'plugin error'))
    })
  }

  async spawn(plugin: { id: string; root: string; main: string }): Promise<void> {
    this.dispose(plugin.id)
    this.roots.set(plugin.id, { root: plugin.root, main: plugin.main })

    let resolveReady = (): void => {}
    let rejectReady = (_: Error): void => {}
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise
      rejectReady = rejectPromise
    })

    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        /*
          ★ 不设这个,隐藏窗口的 timer 会被 Chromium 降频到大约一分钟一次。
          症状是「插件的定时器好像停了」,而没有任何错误。
        */
        backgroundThrottling: false,
        partition: PARTITION,
        preload: this.preloadPath
      }
    })

    const entry: HostEntry = { window, ready, resolveReady, rejectReady, pending: new Map(), nextInvocationId: 1 }
    this.hosts.set(plugin.id, entry)
    this.byWebContents.set(window.webContents.id, plugin.id)

    /*
      ★ 进程没了 = 所有在途调用**立刻 reject**,不是等它们各自超时。
      等超时意味着一个崩掉的插件会让 agent 的工具调用挂满 60 秒。
    */
    window.webContents.on('render-process-gone', () => { this.fail(plugin.id, new Error('plugin process crashed')) })
    window.on('closed', () => { this.fail(plugin.id, new Error('plugin host closed')) })

    // 插件不许自己开窗口,也不许把宿主导航到别处。
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => { event.preventDefault() })

    await window.loadURL(`${'ncw-plugin'}://${plugin.id}/__host.html`)
    await ready
  }

  async invoke(pluginId: string, invocation: PluginInvocation, timeoutMs: number): Promise<unknown> {
    const entry = this.hosts.get(pluginId)
    if (entry === undefined || entry.window.isDestroyed()) throw new Error('plugin host is not running')
    const id = entry.nextInvocationId++
    const message: PluginInvocation = { ...invocation, id }
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id)
        rejectPromise(new Error('plugin_timeout'))
      }, timeoutMs)
      entry.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); rejectPromise(error) }
      })
      entry.window.webContents.send(CHANNEL_INVOKE, message)
    })
  }

  dispose(pluginId: string): void {
    const entry = this.hosts.get(pluginId)
    if (entry === undefined) return
    this.fail(pluginId, new Error('plugin host disposed'))
    this.byWebContents.delete(entry.window.webContents.id)
    this.hosts.delete(pluginId)
    this.roots.delete(pluginId)
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }

  disposeAll(): void {
    for (const id of [...this.hosts.keys()]) this.dispose(id)
  }

  /** 把在途调用全部 reject 掉,并让还在等握手的 spawn 立刻失败。 */
  private fail(pluginId: string, error: Error): void {
    const entry = this.hosts.get(pluginId)
    if (entry === undefined) return
    entry.rejectReady(error)
    for (const [, settle] of entry.pending) settle.reject(error)
    entry.pending.clear()
  }
}

/**
 * 插件 preload 的位置。
 *
 * ★ 它是**手写的 .cjs 资源文件**,不是打包产物(理由见那个文件的头)。
 * 所以取法和内置 Skill 那批资源一样:打包后在 `process.resourcesPath` 下,
 * 开发时在仓库的 `resources/` 下。
 */
export function pluginPreloadPath(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged
    ? join(input.resourcesPath, PLUGIN_PRELOAD_FILE)
    : join(input.appPath, 'resources', PLUGIN_PRELOAD_FILE)
}

export const PLUGIN_PRELOAD_FILE = 'plugin-preload.cjs'
