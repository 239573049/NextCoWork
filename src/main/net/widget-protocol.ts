/**
 * `ncw-widget://` 协议 —— 给**内置**可视化 widget 用的沙箱外壳。
 *
 * ## 它只服务一个页面,和插件协议刻意不同
 *
 * | 路径 | 内容 | 从哪来 |
 * |---|---|---|
 * | `/index.html` | 外壳页面(空壳) | **生成的** |
 * | `/runtime.js` | 页面侧运行时 | main 段的第二个构建入口(`out/main/widgetShell.js`) |
 * | 其余一切 | 404 | —— |
 *
 * ★ **widget 的代码永远不经过这个协议。** 它是宿主经 postMessage 推进 iframe 的
 * (见 `widget-shell/runtime.ts`)。所以这里没有任何"URL → 文件"的映射,
 * 也就没有路径穿越面 —— 这正是内置 widget 与插件视图最大的区别:
 * 插件视图要服务一整个插件包,而这里只有两个我们自己写的文件。
 *
 * ## 为什么不复用 `ncw-plugin://`
 *
 * 三点,每一点单独都不足以另开一个 scheme:
 * 1. 插件协议的 host 段就是 pluginId,**内置工具没有 pluginId**,而那个协议
 *    内部多处按它反查插件根目录(`PLUGIN_RUNTIME_DIR` / 安装根);
 * 2. 它的 CSP 是给插件代码设计的(`connect-src` 全禁、要 nonce 才跑内联脚本),
 *    而 widget 的 CSP 必须放开 CDN 与内联样式 —— 两种策略写在一个函数里,
 *    改一种必然牵动另一种;
 * 3. 语义:插件是用户**安装**的第三方代码,内置 widget 是我们自己产出的
 *    一段 HTML。让后者走前者的身份体系,下一个人会以为 widget 有 pluginId。
 *
 * ## 为什么不能干脆用 `srcDoc`
 *
 * `srcDoc` 的文档**继承父文档的 CSP**。父窗口在打包版里是
 * `script-src 'self'`(`src/renderer/index.html`),dev 版是 `'unsafe-inline'`
 * (`electron.vite.config.ts` 的 DEV_CSP)。于是 widget 里的内联 `<script>`
 * **开发时能跑、打包后全被拦**,而症状是"图渲染出来了但不动、控制台只有一句
 * 谁也读不懂的 Refused to execute inline script"。给 widget 一个自己的 origin
 * 和一份自己说了算的 CSP,这条 dev/prod 分叉就一次性消失了。
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WIDGET_SCHEME, WIDGET_SHELL_PATH } from '../../shared/domain/widget'
import { mainWindowOrigin } from '../plugin/protocol'
import { WIDGET_BASE_STYLES } from './widget-shell/base-styles'

/**
 * widget 允许加载的外部来源 —— **这是本功能唯一的安全边界清单**。
 *
 * 与 Claude 的实现同名同值(cdnjs / jsdelivr / unpkg / esm.sh):规范正文
 * (`visualize-guidelines/*.ts`)里给模型写的例子引用的就是这几个域名,
 * 少一个的后果是模型照着规范写的 Chart.js 图表**静默不出现**。
 *
 * ★ 加域名之前先想清楚:这是一条"模型写的代码可以从哪里取回脚本"的通道。
 * 只有在规范正文里被明确用到时才该加,并且要同步改 `read_me` 的说明。
 */
const CDN_SOURCES = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh'
]

/**
 * 外壳页面的 CSP。
 *
 * 逐条的理由:
 * - `script-src 'self' 'nonce-…' <CDN>` —— `'self'` 是那个 runtime.js;
 *   nonce 给**widget 自己的内联脚本**(`runScripts` 逐个数贴上,见 `sync.ts`);
 *   CDN 是 Chart.js / D3 这类库。**没有 `'unsafe-inline'`** —— 有它的话
 *   nonce 就没有意义了,而那是这份 CSP 里唯一还在防的东西。
 * - `style-src 'unsafe-inline' <CDN>` —— 规范明确要求用**内联 style**
 *   (流式中途样式必须立刻生效),所以这里必须放开内联样式。样式不是代码。
 * - `img-src … https:` —— 图片是惰性资源,放开任意 https 只是"图片能不能显示"
 *   的问题;收紧到白名单反而会让模型贴一张外链图时**静默空白**,而它看不出来。
 * - `connect-src <CDN>` —— 程序化出网收在白名单内。这里比 img 严:它是
 *   "模型写的代码主动发起请求"的通道,而 `visualize_show_widget` 申报了
 *   `needsNetwork: true` 正是为了这件事不是隐形的。
 * - `frame-ancestors` —— 只允许主窗口嵌它,防止这段 HTML 被别处套用。
 */
function csp(nonce: string): string {
  const cdn = CDN_SOURCES.join(' ')
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn}`,
    `img-src 'self' data: blob: https: ${cdn}`,
    `font-src 'self' data: ${cdn}`,
    'media-src blob: data:',
    `connect-src ${cdn}`,
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${mainWindowOrigin()}`
  ].join('; ')
}

/**
 * 外壳页面。
 *
 * ★ **一段内联脚本都没有。** 逻辑全在 `/runtime.js` 里,靠 `script-src 'self'`
 * 加载 —— 少一处需要 nonce 的地方,也少一处"忘了带 nonce 就整块不干活"的坑。
 * nonce 只经 meta 传给运行时,由它贴到 widget 自己的内联脚本上。
 *
 * ★ 背景透明 + 无内边距:widget 要看起来长在对话里。样式表里那几条基础规则
 * (字体、盒模型、淡入动画)是外壳的职责,不是 widget 的。
 *
 * ★ `WIDGET_BASE_STYLES` 排在**前面**:规范让模型用的那些 class
 * (`class="box"` / `class="t"` / 裸 `<button>`)由它提供,而外壳自己的规则
 * (透明底、无外边距)必须能盖住它。顺序反了的话 widget 会被一张不透明的
 * 白/黑底框住,而那看起来像是我们这个卡片画错了。
 */
function shellHtml(nonce: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="ncw-widget-nonce" content="${nonce}">
<style>
${WIDGET_BASE_STYLES}
</style>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: 14px;
    color: var(--color-text-primary, #e6e6e6);
    -webkit-font-smoothing: antialiased;
  }
  #ncw-root { display: flow-root; }
  /* 新出现的节点淡入一次。宿主每推进一段内容都会走到这里 ——
     它是"看着它长出来"这件事的观感来源,又不至于每帧整页重排。 */
  .ncw-widget-enter { animation: ncw-widget-enter .3s ease both; }
  @keyframes ncw-widget-enter { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ncw-widget-enter { animation: none; } }
  #ncw-loading { color: var(--color-text-secondary, #999); font-size: 13px; padding: 2px 0; }
</style>
</head><body>
<div id="ncw-loading"></div>
<div id="ncw-root"></div>
<script src="/runtime.js"></script>
</body></html>
`
}

/**
 * 运行时脚本的内容。**构建产物**,不是源码:它由 main 段的第二个入口
 * (`src/main/net/widget-shell/runtime.ts`)产出到 `out/main/widgetShell.js`。
 *
 * ★ 读失败时返回 null 而不是抛异常 —— 它只可能发生在"构建配置被人动过"
 * 这种开发期情形上,而那种时候需要看到的是一句说明,不是一屏 stack trace。
 * 缓存住:这个文件在一次进程生命周期里不会变。
 */
let runtimeSource: string | null | undefined
async function readRuntime(): Promise<string | null> {
  if (runtimeSource !== undefined) return runtimeSource
  try {
    runtimeSource = await readFile(join(__dirname, 'widgetShell.js'), 'utf8')
  } catch (err) {
    runtimeSource = null
    console.error(
      `[widget] 读不到 widgetShell.js —— 内置 widget 无法渲染。` +
        `检查 electron.vite.config.ts 的 main 段是否还有那个第二入口。原因:${String(err)}`
    )
  }
  return runtimeSource
}

function randomNonce(): string {
  // 一次性 nonce。用 crypto.randomUUID 而不是 Math.random:后者对"猜下一个值"
  // 不设防,而 nonce 的全部意义就是让**别人写的内容**带不上它。
  return crypto.randomUUID()
}

function respond(body: BodyInit | null, contentType: string, nonce: string, status = 200): Response {
  const headers = new Headers()
  if (body !== null) headers.set('Content-Type', contentType)
  headers.set('Content-Security-Policy', csp(nonce))
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'no-store')
  return new Response(body, { status, headers })
}

/**
 * 请求处理。导出是为了单测 —— `installWidgetProtocol` 只是把它接到
 * Electron 的协议层上,那一步没有可测的东西。
 *
 * 认不出的一律 404:`host` 段必须是 `shell`,路径只认那两个。
 */
export async function handleWidgetRequest(request: Request): Promise<Response> {
  const nonce = randomNonce()
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return respond('bad request', 'text/plain; charset=utf-8', nonce, 400)
  }
  if (url.hostname !== 'shell') return respond('not found', 'text/plain; charset=utf-8', nonce, 404)

  if (url.pathname === WIDGET_SHELL_PATH || url.pathname === '/') {
    return respond(shellHtml(nonce), 'text/html; charset=utf-8', nonce)
  }
  if (url.pathname === '/runtime.js') {
    const source = await readRuntime()
    if (source === null) return respond('// widget runtime missing', 'text/javascript; charset=utf-8', nonce)
    return respond(source, 'text/javascript; charset=utf-8', nonce)
  }
  /*
    ★ 404 到 `.js` 上要**出声**。

    iframe 只被下发了 `/index.html` 与 `/runtime.js` 两个地址,所以任何对别的
    js 的请求都说明"外壳的产物不再自包含" —— 最可能的成因是
    `widget-shell/runtime.ts` 里多了一个**按值** import,rollup 于是把那个模块
    提到两个入口共用的 chunk 里,而 chunk 的文件名带哈希、我们从不服务它。
    那一次改动**构建照样成功**,界面上只是 widget 一片空白。

    默默 404 的话,下一个人要花很久才想到去看网络面板;打一行日志,
    他至少知道该去看哪个文件。
  */
  if (url.pathname.endsWith('.js')) {
    console.error(
      `[widget] iframe 请求了一个我们不服务的脚本:${url.pathname}。` +
        `外壳产物应当只有 runtime.js —— 出现别的说明它不再自包含:` +
        `检查 widget-shell/runtime.ts 有没有多出按值 import(共享 chunk 的文件名带哈希)。`
    )
  }
  return respond('not found', 'text/plain; charset=utf-8', nonce, 404)
}

/** 在 `app.whenReady()` **之前**调用 —— 之后调不报错,但 privileges 全丢。 */
export function registerWidgetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WIDGET_SCHEME,
      privileges: {
        standard: true,
        // ★ secure 必须有:不透明源 + 非安全来源会被当成"混合内容",
        // 而 CSP 里的 nonce 与 sandbox 组合在这种情况下行为不一致。
        secure: true,
        supportFetchAPI: true,
        // widget 之间没有互相访问的需求,这个 origin 只有一个文档
        corsEnabled: false,
        stream: false
      }
    }
  ])
}

/** 在 `app.whenReady()` 之后调用。 */
export function installWidgetProtocol(): void {
  protocol.handle(WIDGET_SCHEME, (request) => handleWidgetRequest(request))
}
