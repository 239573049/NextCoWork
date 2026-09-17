/**
 * 插件宿主窗口的 preload —— **整个插件系统里最小的一块,也是最关键的一块**。
 *
 * ## 为什么是一份手写的 .cjs,而不是打包产物
 *
 * 1. **它是安全边界,应该能被逐行读完。** 这个文件是插件与主进程之间唯一的
 *    通道;一份经过打包、压缩、注入过 shim 的产物没法在代码审查里被逐行确认。
 * 2. **它没有任何依赖。** 只 `require('electron')` —— 而那正是沙箱 preload
 *    唯一允许 require 的东西。没有依赖就没有打包的理由。
 * 3. 打包反而带来一个真实的坑:`preload` 那一段开着 `isolatedEntries`
 *    (沙箱 preload 必须是单文件),而那个模式下第二个入口不产出任何东西 ——
 *    表现是「插件窗口起来了,但 `__ncwPluginBridge` 是 undefined」,
 *    而构建日志里一个字都不会说。
 *
 * ## 它只暴露三件事,而且**一件都不带参数化的目标**
 *
 * - `request(msg)`   → 固定频道 `plugin:rpc`
 * - `onInvoke(cb)`   → 固定频道 `plugin:invoke`
 * - `ready(id)`      → 固定频道 `plugin:ready`
 *
 * ★ 对比主窗口的 preload:那一份要做频道白名单校验,因为渲染层会把频道名
 * 传进来。这一份**没有频道名可传** —— 三个函数各自写死一条频道。于是
 * 「插件调了一个它不该调的频道」这件事在这里没有着力点。
 *
 * ★ `ready` 里的 id 只用于**插件侧自查**(垫片拿它填 `extensionId`),
 * 主进程一个字都不看:身份来自 `event.sender.id`(见 `main/plugin/host-window.ts`)。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

let handler = null

ipcRenderer.on('plugin:invoke', (_event, invocation) => {
  void (async () => {
    if (handler === null) {
      ipcRenderer.send('plugin:invokeResult', {
        id: invocation.id,
        ok: false,
        error: { message: 'plugin is not ready' }
      })
      return
    }
    try {
      const data = await handler(invocation)
      ipcRenderer.send('plugin:invokeResult', { id: invocation.id, ok: true, data })
    } catch (error) {
      /*
        ★ 插件代码抛出来的异常**必须变成一条回执**,不能就这么消失。
        没有回执的话,主进程那一侧会一直等到超时 —— 而超时的错误信息里
        不会有插件真正抛出的那句话,作者因此完全看不到自己的报错。
      */
      ipcRenderer.send('plugin:invokeResult', {
        id: invocation.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) }
      })
    }
  })()
})

contextBridge.exposeInMainWorld('__ncwPluginBridge', {
  request: (message) => ipcRenderer.invoke('plugin:rpc', message),
  onInvoke: (fn) => {
    handler = fn
  },
  ready: (pluginId) => {
    ipcRenderer.send('plugin:ready', pluginId)
  }
})
