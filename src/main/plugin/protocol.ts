/**
 * `ncw-plugin://` 协议 —— 插件包里的文件、宿主页面、API 垫片,全部经这里出。
 *
 * ## 三类响应
 *
 * | 路径 | 内容 | 从哪来 |
 * |---|---|---|
 * | `/__host.html` | 宿主页面 | **生成的**,不在包里 |
 * | `/__runtime.js` | `nextcowork` 模块的实现 | **生成的**,闭包里写死 pluginId |
 * | 其余 | 包内文件 | `<userData>/plugins/<id>/` |
 *
 * ★ 前两个必须是生成的:插件不能提供自己的宿主页面(那等于自己写 CSP),
 * 也不能提供 API 垫片(那等于自己声明自己的身份)。**身份由协议层写死** ——
 * URL 的 host 段就是 pluginId,而 URL 是 Chromium 给的,不是插件传的参数。
 *
 * ## CSP 由 handler **强制注入**
 *
 * 不写在页面的 `<meta>` 里:meta 版 CSP 是页面内容的一部分,而页面内容里
 * 有插件的代码。响应头版本插件改不了。
 *
 * `connect-src` 不给外网是**关键设计,不是疏漏**:它让「插件能访问哪些域名」
 * 变成主进程可校验、可审计、可关闭的一条通道(`ncw.net.fetch`)。
 */
import { net, protocol, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLUGIN_SCHEME = 'ncw-plugin'

/**
 * 插件宿主窗口的 session 分区。放这里(而不是 `host-window.ts`)是因为
 * `installPluginProtocol` 也要用 —— 常量住在最低层,谁引谁都不会成环。
 */
export const PLUGIN_HOST_PARTITION = 'persist:plugin-host'

/** 在 `app.whenReady()` **之前**调用 —— 之后调不报错,但 privileges 全丢。 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // 每个插件一个 origin,彼此之间不跨源
        corsEnabled: false,
        stream: true
      }
    }
  ])
}

/**
 * CSP。
 *
 * ★ **`nonce` 是必需的,不是可选加固。** 宿主页面(`/__host.html`)靠两段
 * **内联**脚本启动:importmap 把裸模块名 `nextcowork` 映射到 `/__runtime.js`,
 * 紧随其后的 module 脚本调 `__bootstrap`。而 `script-src 'self'` 只放行
 * **外部**脚本 —— 内联的一律拦掉(importmap 同样受 `script-src` 管)。
 *
 * 症状极难定位:控制台只有一句「Refused to execute inline script」,而主进程
 * 那边表现为「插件点了没反应 / 启用后不自启动」—— `__bootstrap` 从不执行,
 * `bridge.ready()` 从不调用,`spawn()` 里的 `await ready` 就永远不 resolve。
 *
 * 所以给内联脚本发 nonce。**每个响应新生成**,不用固定值:固定值等于换个写法
 * 的 `'unsafe-inline'`,任何能往页面里写内容的人都带得上它。
 */
function csp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    'media-src blob:',
    'worker-src blob:',
    // ★ 仍然禁外网:所有网络请求必须走 ncw.net.fetch,由主进程逐 URL 校验
    "connect-src 'self' data: blob:",
    `frame-ancestors ${mainWindowOrigin()}`
  ].join('; ')
}

/**
 * 主窗口的**真实** origin —— 给 `frame-ancestors` 用。
 *
 * ★ 这里原来写死的是 `ncw://main`,而那个 scheme **全仓从未注册过**:
 * 主窗口 dev 时是 `ELECTRON_RENDERER_URL`(http://localhost:<port>),
 * 打包后是 `loadFile` 的 `file://`。两者都匹配不上 `ncw://main`,于是
 * **插件视图的 iframe 在两种模式下都被拒**。
 *
 * 症状分两段,而且第二段会把人带偏:先是「Framing 'ncw-plugin://…' violates
 * …」(那是**主窗口**的 CSP 少了 frame-src),把它修好之后才轮到这一条 ——
 * 同样是一片空白,但报的是 frame-ancestors。所以两处必须一起改。
 *
 * 这里返回 origin 而不是写死端口:dev 端口是 vite 分配的,写死等于换台机器就坏。
 */
function mainWindowOrigin(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && devUrl !== '') {
    try {
      return new URL(devUrl).origin
    } catch {
      // 环境变量被写坏了 —— 退到生产那一支,而不是放开成 `*`
    }
  }
  // 打包后主窗口走 loadFile。`file:` 是 scheme-source,匹配 file:// 下的祖先。
  return 'file:'
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot === -1 ? undefined : MIME[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
}

function headers(contentType: string, nonce?: string): Headers {
  const out = new Headers()
  out.set('Content-Type', contentType)
  out.set('Content-Security-Policy', csp(nonce ?? randomNonce()))
  // 插件包里的东西不该被别的 origin 嵌进去,也不该被当成下载执行
  out.set('X-Content-Type-Options', 'nosniff')
  out.set('Cache-Control', 'no-store')
  return out
}

/**
 * 一次响应用一次的 nonce。
 *
 * ★ 用 `crypto.randomUUID()` 而不是 Math.random:后者对「猜出下一个值」
 * 不设防,而 nonce 的全部意义就是让**别人写的内容**带不上它。
 */
function randomNonce(): string {
  return randomUUID()
}

/**
 * 宿主页面 —— **一个空壳**。
 *
 * 它只做两件事:把 `nextcowork` 这个裸模块名映射到生成的垫片(import map),
 * 然后动态 import 插件的入口。插件代码里的 `import * as ncw from 'nextcowork'`
 * 因此能解析 —— 和 VS Code 里 `vscode` 被标成 external 是同一套做法。
 *
 * ★ **两段脚本都带 nonce**,而 `nonce` 必须和响应头里那个是**同一个值** ——
 * 分两次生成的话 CSP 依然拦得住它们。见上面 `csp()` 的说明。
 */
function hostHtml(pluginId: string, main: string, nonce: string): string {
  const entry = JSON.stringify(`./${main.replace(/^\.\//, '')}`)
  const attr = `nonce="${nonce}"`
  return `<!doctype html>
<html><head><meta charset="utf-8">
<script ${attr} type="importmap">
{"imports":{"nextcowork":"/__runtime.js"}}
</script>
</head><body>
<script ${attr} type="module">
import { __bootstrap } from '/__runtime.js'
__bootstrap(${entry}, ${JSON.stringify(pluginId)})
</script>
</body></html>`
}

/**
 * `nextcowork` 模块的运行期实现。
 *
 * ★ **pluginId 写在这段生成的代码里**,不是从调用方传进来的参数。
 * 插件可以读它、改自己那份拷贝,但每一条真正出去的消息都由 preload 经
 * 一条固定的 IPC 频道发出,而主进程认的是**发送者的 webContents**,
 * 不是消息里的任何字段。所以伪造身份这件事在这一层根本没有着力点。
 */
function runtimeJs(pluginId: string): string {
  return `const bridge = globalThis.__ncwPluginBridge
let nextId = 1
const pending = new Map()
const handlers = { activate: null, deactivate: null, commands: new Map(), tools: new Map(), appearance: new Set() }
const toolActions = new Map()
const exposedApiMethods = new Map()
const eventSubscribers = new Map()
let api = null

function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    bridge.request({ id, method, params: params ?? {} }).then((response) => {
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      if (response.ok) entry.resolve(response.data)
      else entry.reject(Object.assign(new Error(response.error.message), { code: response.error.code }))
    }, (error) => {
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      entry.reject(error)
    })
  })
}

export class Disposable {
  constructor(callOnDispose) { this._dispose = callOnDispose }
  static from(...items) { return new Disposable(() => { for (const item of items) item.dispose() }) }
  dispose() { this._dispose?.() }
}

export const version = '1'
export const extensionId = ${JSON.stringify(pluginId)}

export const env = {
  appInfo: () => call('env.appInfo'),
  openExternal: (url) => call('env.openExternal', { url }),
  clipboard: {
    readText: () => call('env.clipboardRead').then((r) => r.text),
    writeText: (text) => call('env.clipboardWrite', { text })
  }
}

export const permissions = {
  contains: (p) => call('permissions.contains', { permissions: Array.isArray(p) ? p : [p] }).then((r) => r.granted),
  request: (p, reasonKey) => call('permissions.request', { permissions: p, reasonKey }).then((r) => r.granted),
  remove: (p) => call('permissions.remove', { permissions: p })
}

export const workspace = {
  folders: () => call('workspace.folders').then((r) => r.folders),
  fs: {
    readFile: (path, encoding) => call('workspace.readFile', { path, encoding }),
    writeFile: (path, data, options) => call('workspace.writeFile', { path, data, ...(options ?? {}) }),
    delete: (path) => call('workspace.deleteFile', { path }),
    stat: (path) => call('workspace.stat', { path })
  },
  findFiles: (glob, limit) => call('workspace.findFiles', { glob, limit }).then((r) => r.paths)
}

export const process_ = { exec: (command, args, options) => call('process.exec', { command, args: args ?? [], ...(options ?? {}) }) }
export { process_ as process }

export const net = { fetch: (url, init) => call('net.fetch', { url, ...(init ?? {}) }) }

export const storage = {
  global: { get: (key) => call('storage.get', { scope: 'global', key }).then((r) => r.value), set: (key, value) => call('storage.set', { scope: 'global', key, value }), keys: () => call('storage.keys', { scope: 'global' }).then((r) => r.keys) },
  workspace: { get: (key) => call('storage.get', { scope: 'workspace', key }).then((r) => r.value), set: (key, value) => call('storage.set', { scope: 'workspace', key, value }), keys: () => call('storage.keys', { scope: 'workspace' }).then((r) => r.keys) }
}

export const secrets = {
  get: (key) => call('secrets.get', { key }).then((r) => r.value),
  set: (key, value) => call('secrets.set', { key, value })
}

export const window_ = {
  showMessage: (kind, messageKey, params) => call('window.showMessage', { kind, messageKey, params }),
  showQuickPick: (items, placeholderKey) => call('window.showQuickPick', { items, placeholderKey }).then((r) => r.id),
  setStatusBarItem: (id, textKey, options) => call('window.setStatusBarItem', { id, textKey, ...(options ?? {}) })
}
export { window_ as window }

export const commands = {
  registerCommand(commandId, handler) {
    handlers.commands.set(commandId, handler)
    void call('commands.register', { commandId })
    return new Disposable(() => { handlers.commands.delete(commandId); void call('commands.unregister', { commandId }) })
  },
  executeCommand: (commandId, args) => call('commands.execute', { commandId, args }).then((r) => r.value)
}

export const tools = {
  registerTool(name, tool) {
    handlers.tools.set(name, tool)
    void call('tools.register', { name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' }, readOnly: tool.readOnly === true, destructive: tool.destructive === true, needsNetwork: tool.needsNetwork === true, interactive: tool.interactive === true })
    return new Disposable(() => { handlers.tools.delete(name); void call('tools.unregister', { name }) })
  }
}

export const tabs = {
  openCustomEditor: (viewType, path) => call('tabs.openCustomEditor', { viewType, path })
}

export const plugins = {
  exposeApi(methods) {
    const names = Object.keys(methods ?? {})
    for (const name of names) exposedApiMethods.set(name, methods[name])
    void call('plugins.expose', { methods: [...exposedApiMethods.keys()] })
    return new Disposable(() => {
      for (const name of names) exposedApiMethods.delete(name)
      void call('plugins.expose', { methods: [...exposedApiMethods.keys()] })
    })
  },
  connect(target) {
    return new Proxy({}, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        return (...args) => call('plugins.invoke', { target, method, args }).then((r) => r.value)
      }
    })
  },
  events: {
    emit: (topic, payload) => call('plugins.emitEvent', { topic, payload }),
    on(topic, handler) {
      let set = eventSubscribers.get(topic)
      if (set === undefined) { set = new Set(); eventSubscribers.set(topic, set); void call('plugins.subscribeEvent', { topic }) }
      set.add(handler)
      return new Disposable(() => {
        const s = eventSubscribers.get(topic)
        if (s === undefined) return
        s.delete(handler)
        if (s.size === 0) { eventSubscribers.delete(topic); void call('plugins.unsubscribeEvent', { topic }) }
      })
    }
  }
}

export const diagnostics = { log: (level, message) => call('diagnostics.log', { level, message }) }

/**
 * 宿主的深浅色。无需权限 —— 不含用户数据。
 *
 * 只在第一次注册 onDidChange 时向主进程订阅:重复 subscribe 对主进程
 * 是同一笔(它记的是布尔),多发一次 IPC 没有意义。
 *
 * 注意这段在模板字符串里,注释里不能出现反引号 —— 它会把模板提前闭合,
 * 而报错会落在几十行之外、看起来毫不相干的地方。
 */
export const appearance = {
  get: () => call('appearance.get').then((r) => r.appearance),
  onDidChange(handler) {
    const first = handlers.appearance.size === 0
    handlers.appearance.add(handler)
    if (first) void call('appearance.subscribe')
    return new Disposable(() => { handlers.appearance.delete(handler) })
  }
}

export function __bootstrap(entry, id) {
  bridge.onInvoke(async (invocation) => {
    const { kind, payload } = invocation
    if (kind === 'activate') {
      const module = await import(entry)
      api = module
      const context = { extensionId: id, subscriptions: [] }
      globalThis.__ncwContext = context
      await module.activate?.(context)
      return {}
    }
    if (kind === 'deactivate') {
      await api?.deactivate?.()
      for (const item of globalThis.__ncwContext?.subscriptions ?? []) { try { item.dispose?.() } catch {} }
      return {}
    }
    if (kind === 'command.run') {
      const handler = handlers.commands.get(payload.commandId)
      if (handler === undefined) throw new Error('no such command: ' + payload.commandId)
      return { value: await handler(payload.args) }
    }
    if (kind === 'tool.execute') {
      const tool = handlers.tools.get(payload.name)
      if (tool === undefined) throw new Error('no such tool: ' + payload.name)
      const progress = (update) => {
        const u = update ?? {}
        void call('tool.progress', { callId: payload.callId, message: u.message, card: u.card })
      }
      const onAction = (handler) => { toolActions.set(payload.callId, handler) }
      try {
        return await tool.invoke({ input: payload.input, callId: payload.callId, session: payload.session, progress, onAction })
      } finally {
        toolActions.delete(payload.callId)
      }
    }
    if (kind === 'tool.action') {
      const handler = toolActions.get(payload.callId)
      if (handler !== undefined) handler({ actionId: payload.actionId, value: payload.value })
      return {}
    }
    if (kind === 'api.call') {
      const fn = exposedApiMethods.get(payload.method)
      if (fn === undefined) throw new Error('no such api method: ' + payload.method)
      return { value: await fn(...(payload.args ?? [])) }
    }
    if (kind === 'plugins.event') {
      const set = eventSubscribers.get(payload.topic)
      if (set !== undefined) for (const handler of set) { try { handler(payload.payload, payload.from) } catch {} }
      return {}
    }
    /*
      宿主播来的事件。**一个插件的处理函数抛了,不能影响别的处理函数,也不能
      让这次 invocation 变成失败** —— 事件是通知,不是请求,没有「失败」这个
      语义可以回给宿主。所以逐个 try。
    */
    if (kind === 'event') {
      if (payload.event === 'appearance.changed') {
        for (const handler of handlers.appearance) {
          try { handler(payload.appearance) } catch {}
        }
      }
      return {}
    }
    throw new Error('unsupported invocation: ' + kind)
  })
  bridge.ready(id)
}
`
}

/**
 * 视图垫片 —— **注入进每一个插件视图 HTML** 的一小段脚本。
 *
 * ## 它补的是哪一段
 *
 * 宿主(`renderer/src/shell/PluginViewFrame.tsx`)已经在往视图 iframe
 * postMessage 一条 `ncw:theme`,带着 24 个 color token、`appearance`、`motion`。
 * 但视图 iframe 和宿主**不同源**,它拿不到宿主的样式;而 `__runtime.js` 那套
 * API 垫片只经 `__host.html` 的 importmap 加载,**只服务于隐藏的插件宿主页面** ——
 * 视图这边一行都够不着。结果是那条消息发出去之后没有任何人接,
 * 每个插件作者都得自己写一遍 origin 校验 + 写变量的样板。
 *
 * ## 为什么是注入,不是让插件自己 import
 *
 * 同 `__host.html` 的理由(见文件头):垫片一旦由插件提供,插件就能决定
 * 自己看见什么主题 —— 而且更现实的是,**没人会记得引它**,于是「插件不跟随
 * 主题」会以每个插件各犯一次的方式反复出现。注入是唯一能让它默认成立的做法。
 *
 * ## 约定
 *
 * - CSS 变量写成 `--ncw-<token>`(如 `--ncw-canvas`)。**不用宿主内部的
 *   `--color-*`**:那是宿主的实现细节,而这里是给插件作者看的公开名字。
 * - `document.documentElement` 上同步设 `data-theme` / `data-theme-motion`,
 *   纯 CSS 的插件不写一行 JS 也能用属性选择器分支。
 * - `globalThis.__ncwTheme` 是**同步可读**的当前值 —— 插件首帧就要选对颜色,
 *   而等一条 message 到达至少是下一个 tick,那一帧会闪。
 * - 变化时派发 `ncw:theme` CustomEvent(detail 同 `__ncwTheme`)。
 *
 * ★ `event.origin !== location.origin` 的必须拒绝:视图是能被插件自己
 * 导航的,而 `window.parent` 之外还有别的窗口能拿到这个 frame 的引用。
 * 只认与自己同源的那条(宿主发送时 targetOrigin 就写死成这个 origin)。
 */
function viewShimJs(): string {
  return `(() => {
  const root = document.documentElement
  const state = { appearance: ${JSON.stringify(resolveAppearance())}, motion: 'full', tokens: {} }
  globalThis.__ncwTheme = state
  const apply = (message) => {
    state.appearance = message.appearance === 'light' ? 'light' : 'dark'
    state.motion = typeof message.motion === 'string' ? message.motion : 'full'
    const tokens = message.tokens
    if (tokens !== null && typeof tokens === 'object') {
      state.tokens = tokens
      for (const key of Object.keys(tokens)) {
        const value = tokens[key]
        if (typeof value === 'string') root.style.setProperty('--ncw-' + key, value)
      }
    }
    root.dataset.theme = state.appearance
    root.dataset.themeMotion = state.motion
    globalThis.dispatchEvent(new CustomEvent('ncw:theme', { detail: state }))
  }
  globalThis.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return
    const data = event.data
    if (data === null || typeof data !== 'object' || data.type !== 'ncw:theme') return
    apply(data)
  })
  root.dataset.theme = state.appearance
})()`
}

/**
 * 把垫片插进视图 HTML 的 `<head>` 里。**纯函数,单测冲它来。**
 *
 * ★ 插在 `<head>` **开头**,不是末尾、更不是 `</body>` 前:宿主是在 iframe 的
 * `load` 事件里发第一条 `ncw:theme` 的,而 `load` 晚于全部解析 —— 只要垫片
 * 在文档里出现过,监听器就一定先于那条消息登记。但插件自己的 `<script>` 可能
 * 同步读 `__ncwTheme`,所以要抢在它们前面。
 *
 * 没有 `<head>` 的畸形文档(插件手写的片段)走 `<html>` 之后;再没有就顶在
 * 最前面 —— 浏览器会把它收进隐式的 head。**任何一种情况都不能静默跳过注入**,
 * 那等于这个插件的视图永远不跟随主题,而且不报错。
 */
export function injectViewShim(html: string, nonce: string): string {
  const tag = `<script nonce="${nonce}">${viewShimJs()}</script>`
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}

/** `<userData>/plugins/<id>` 的解析器。由 `host-window.ts` 注入,协议层不认识 app。 */
export type PluginRootResolver = (pluginId: string) => { root: string; main: string } | undefined

let resolveRoot: PluginRootResolver = () => undefined

export function setPluginRootResolver(resolver: PluginRootResolver): void {
  resolveRoot = resolver
}

/**
 * 当前深浅色。**注入进视图垫片的初值**,让插件视图的第一帧就是对的。
 *
 * ★ 为什么要这个初值:宿主那条 `ncw:theme` 是在 iframe 的 `load` 事件里发的,
 * 最快也是解析完之后的下一个 tick —— 在那之前插件自己的脚本已经跑过了。
 * 没有初值的话,深色环境下的插件视图会先画一帧浅色再跳过去。
 *
 * ★ 走 setter 而不是直接 import:同 `PluginRootResolver` 的理由 ——
 * **协议层不认识 app、也不认识 store**。它只认自己收到的 URL。
 */
let resolveAppearance: () => 'light' | 'dark' = () => 'dark'

export function setPluginAppearanceResolver(resolver: () => 'light' | 'dark'): void {
  resolveAppearance = resolver
}

/**
 * 插件系统别处也要读这个值(`ipc/plugins.ts` 的 `appearance.get`)。
 *
 * ★ 从这里读、而不是各自 `import { resolveTheme } from '../ipc/app'`:
 * 后者会让 `ipc/app.ts` 和 `ipc/plugins.ts` 互相 import —— 而 app.ts 正要
 * 反向调 `notifyPluginsThemeChanged`。协议层谁都不依赖,放这儿不成环。
 */
export function pluginAppearance(): 'light' | 'dark' {
  return resolveAppearance()
}

/** 在 `app.whenReady()` 之后调用。 */
export function installPluginProtocol(): void {
  /*
    ★ **两个 session 都要注册,缺一个是装不出来的。**

    顶层的 `protocol.handle` 只挂在**默认 session**上;而插件宿主窗口跑在
    `persist:plugin-host` 分区里(ElectronPluginRuntime 给它单独的 partition,
    隔离插件的网络与存储)。分区 session 里没有这个处理器的话,
    `loadURL('ncw-plugin://…')` 直接 `ERR_FAILED(-2)` —— 没有更多解释,
    页面一个字节都到不了,而这个错误和「协议根本没注册」在表现上完全一样。

    `session.fromPartition` 在窗口创建之前就可以调,session 对象会复用。
    `registerSchemesAsPrivileged` 是全局的,不受影响。
  */
  const handler = (request: Request): Promise<Response> => handlePluginRequest(request, resolveRoot)
  protocol.handle(PLUGIN_SCHEME, handler)
  session.fromPartition(PLUGIN_HOST_PARTITION).protocol.handle(PLUGIN_SCHEME, handler)
}

export async function handlePluginRequest(
  request: Request,
  resolver: PluginRootResolver
): Promise<Response> {
  let url: URL
  try { url = new URL(request.url) } catch { return new Response('bad request', { status: 400 }) }

  const pluginId = url.hostname
  const entry = resolver(pluginId)
  if (entry === undefined) return new Response('forbidden', { status: 403 })

  const path = decodeURIComponent(url.pathname)
  if (path === '/__host.html' || path === '/') {
    /*
      ★ nonce **在这里生成一次**,同时给响应头和页面里的两段内联脚本 ——
      各生成各的等于没加:页面里那个值和 CSP 里那个对不上,CSP 照样拦。
    */
    const nonce = randomNonce()
    return new Response(hostHtml(pluginId, entry.main, nonce), {
      status: 200,
      headers: headers(MIME['.html'] as string, nonce)
    })
  }
  if (path === '/__runtime.js') {
    return new Response(runtimeJs(pluginId), { status: 200, headers: headers(MIME['.js'] as string) })
  }

  const target = resolveInsidePackage(entry.root, path)
  // ★ 403 而不是 404:两者要能区分开。404 是「这个文件没了」,403 是
  //   「有人在构造越界路径」—— 后者应当被注意到。
  if (target === null) return new Response('forbidden', { status: 403 })

  try {
    const rootStat = await lstat(entry.root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return new Response('not found', { status: 404 })
    const canonicalRoot = await realpath(entry.root)
    const canonicalTarget = await realpath(target).catch(() => null)
    if (canonicalTarget === null) return new Response('not found', { status: 404 })
    /*
      ★ 第二层:realpath 之后再验一次落点。第一层验的是「路径长得对不对」,
      这一层验的是「跟着软链走完之后落在哪」。缺了它,包里一个指向
      `~/.ssh/id_rsa` 的软链会被原样读出来 —— 而词法检查完全看不出来。
    */
    if (!isWithin(canonicalRoot, canonicalTarget)) return new Response('forbidden', { status: 403 })
    const targetStat = await lstat(canonicalTarget)
    if (!targetStat.isFile()) return new Response('not found', { status: 404 })

    const response = await net.fetch(pathToFileURL(canonicalTarget).toString())
    if (!response.ok) return new Response('not found', { status: 404 })
    const contentType = mimeOf(path)
    /*
      ★ **HTML 要落地读完再发,不能像其它类型那样流式透传** —— 垫片必须
      插进正文里。只有 HTML 走这条路:图片、字体、wasm 仍然流式,
      一个几 MB 的 .wasm 不该为了这件事先进一次内存。

      nonce **在这里生成一次**,同时给响应头和注入的那段脚本。分两次生成
      等于没注入:CSP 里那个值和标签上那个对不上,脚本照样被拦,
      而症状是「插件视图颜色永远不对」加控制台一句 Refused to execute。
    */
    if (contentType === MIME['.html']) {
      const nonce = randomNonce()
      return new Response(injectViewShim(await response.text(), nonce), {
        status: 200,
        headers: headers(contentType, nonce)
      })
    }
    return new Response(response.body, { status: response.status, headers: headers(contentType) })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** 纯函数,单测就是冲它来的。返回 null = 拒绝。 */
export function resolveInsidePackage(root: string, pathname: string): string | null {
  if (pathname.includes('\0')) return null
  const rel = pathname.replace(/^\/+/, '')
  if (rel === '') return null
  if (rel.split('/').some((segment) => segment === '..' || segment === '.')) return null
  const target = resolve(join(root, rel))
  return isWithin(root, target) ? target : null
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
