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
    'frame-ancestors ncw://main'
  ].join('; ')
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
const handlers = { activate: null, deactivate: null, commands: new Map(), tools: new Map() }
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
    void call('tools.register', { name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' }, readOnly: tool.readOnly === true, destructive: tool.destructive === true, needsNetwork: tool.needsNetwork === true })
    return new Disposable(() => { handlers.tools.delete(name); void call('tools.unregister', { name }) })
  }
}

export const tabs = {
  openCustomEditor: (viewType, path) => call('tabs.openCustomEditor', { viewType, path })
}

export const diagnostics = { log: (level, message) => call('diagnostics.log', { level, message }) }

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
      return await tool.invoke({ input: payload.input, callId: payload.callId, session: payload.session })
    }
    throw new Error('unsupported invocation: ' + kind)
  })
  bridge.ready(id)
}
`
}

/** `<userData>/plugins/<id>` 的解析器。由 `host-window.ts` 注入,协议层不认识 app。 */
export type PluginRootResolver = (pluginId: string) => { root: string; main: string } | undefined

let resolveRoot: PluginRootResolver = () => undefined

export function setPluginRootResolver(resolver: PluginRootResolver): void {
  resolveRoot = resolver
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
    return new Response(response.body, { status: response.status, headers: headers(mimeOf(path)) })
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
