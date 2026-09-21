/**
 * widget 外壳的**页面侧运行时** —— 跑在 `ncw-widget://shell/` 那个沙箱 iframe 里。
 *
 * 它是被 `ncw-widget://shell/runtime.js` 下发给 iframe 的那份脚本
 * (作为 main 那段构建的第二个入口产出,见 `electron.vite.config.ts`)。
 * 真正的 DOM 算法在 `sync.ts`,这里只做四件事:
 *
 * 1. 收发 postMessage(内容 / 主题 / 加载提示);
 * 2. 内容到达时调 `syncInto`,流结束那一帧再调 `runScripts`;
 * 3. 量自己的高度报给宿主(宿主钳制后设给 iframe);
 * 4. 把宿主推来的主题变量写进 `:root`。
 *
 * ## 为什么是 postMessage 而不是让宿主直接写 DOM
 *
 * iframe 带 `sandbox="allow-scripts"`(**没有** `allow-same-origin`),它因此
 * 是一个**不透明源**:父文档拿不到它的 DOM,它也拿不到父文档的。这是刻意的 ——
 * widget 是模型生成的任意 HTML,让它跟聊天界面同源等于把整个渲染进程
 * (以及窗口里那个 preload 桥)交给它。全仓唯一被允许同源嵌入的是插件视图,
 * 那是因为插件是用户显式安装的、有清单和权限声明的东西。
 *
 * ★ 两条 postMessage 的约定与插件卡片相反,别照抄那边:
 * - **上行**(这里 → 宿主)的 `event.origin` 是字符串 `"null"`(不透明源),
 *   所以宿主侧只能靠 `event.source === iframe.contentWindow` 认身份;
 * - **下行**(宿主 → 这里)必须用 `targetOrigin: '*'`,因为不透明源没法点名。
 *   安全性来自"宿主手里握着那个 contentWindow 引用",不是来自 origin。
 *
 * ## 刻意没有的东西
 *
 * `sendPrompt()` —— Claude 的 widget 里有一个"像用户打字一样发一条消息"的函数,
 * 规范正文里也常常让模型用它做下钻按钮。这里**没有实现**,因为它是 widget
 * 通往 agent 主循环的一条输入通道(点一下就触发一轮),值不值得开要单独定。
 * 规范正文照旧提到它,所以 `visualize_read_me` 的 description 里明说了
 * 本宿主不提供它 —— 不写那句的话,模型会按规范画出点不动的按钮。
 */
import type { WidgetMessageNames } from '../../../shared/domain/widget'
import { runScripts, syncInto } from './sync'

/**
 * 那五个消息名 —— **故意在这里重写一遍,而不是按值 import `shared/domain/widget`**。
 *
 * 这不是顺手抄的:那份运行时是 iframe 里的一条**自包含**脚本,由
 * `ncw-widget://shell/runtime.js` 下发,而协议只服务固定两个路径。一旦按值
 * import 那个共享模块,rollup 会把它提到**两个入口共用的 chunk** 里
 * (main 的入口也要用同样的常量),于是运行时第一行变成
 * `require("./widget-xxxx.js")` —— iframe 永远取不到那个文件,而且它是 CJS,
 * 在浏览器里连 `require` 都没有。
 *
 * 症状:**构建完全成功**,widget 一片空白,主进程/控制台只有一条取不到文件的错。
 * 这个坑已经踩过一次(`out/main/widget-qsN_xeJ0.js`),所以这里用
 * `satisfies` 把两边钉在一起:值各写一份,但**不一致就编译不过**。
 */
const MESSAGE = {
  content: 'ncw:widget:content',
  theme: 'ncw:widget:theme',
  loading: 'ncw:widget:loading',
  ready: 'ncw:widget:ready',
  height: 'ncw:widget:height'
} as const satisfies WidgetMessageNames

const root = document.getElementById('ncw-root')
const loading = document.getElementById('ncw-loading')

/** 外壳页面缺了根节点就没什么可做的了 —— 说明页面与服务端不同版本。 */
if (root === null) throw new Error('ncw-widget shell: #ncw-root is missing')

/**
 * 内联脚本要用的 nonce,由外壳页面写在 meta 里,值与响应头 CSP 里那个是同一个
 * (见 `widget-protocol.ts`)。读不到就退化成空串:那时内联脚本会被 CSP 拦下,
 * 但 widget 的静态部分照常显示 —— 比整块渲染失败要好。
 */
const nonce = document.querySelector('meta[name="ncw-widget-nonce"]')?.getAttribute('content') ?? ''

let contentSeen = false

/**
 * 高度上报。
 *
 * ★ **量的是 `#ncw-root`,不是 `document.body`。** 量 body 会把宿主刚设给
 * iframe 的高度(经 `body { height: 100% }` 之类)量回去,于是"报高 → 宿主调高
 * → 再报高"变成一次无限增长,而它看起来像是 widget 自己在变高。
 * (这一条是 `claude-widgets` 那个仓库踩出来的,症状与成因都已核对过。)
 *
 * ★ 用 rAF 合并:内容每变一次都会触发一次 ResizeObserver,而一帧里
 * 报三次高度除了多刷两次宿主状态之外没有别的效果。
 */
let heightScheduled = false
function reportHeight(): void {
  if (heightScheduled) return
  heightScheduled = true
  requestAnimationFrame(() => {
    heightScheduled = false
    const height = root === null ? 0 : Math.ceil(root.getBoundingClientRect().height)
    post({ type: MESSAGE.height, height })
  })
}

function post(message: Record<string, unknown>): void {
  // targetOrigin 必须是 '*' —— 本帧是不透明源,点名写法没有可用的值。见文件头。
  window.parent.postMessage(message, '*')
}

/**
 * 收到内容。`final` 为真时先同步再执行脚本 —— **顺序不能反**:脚本里通常有
 * `document.getElementById(...)`,元素没进树它拿到的是 null,而那种失败
 * 表现为"图没画出来但也不报错"。
 */
function onContent(html: string, final: boolean): void {
  if (loading !== null) loading.hidden = true
  contentSeen = true
  if (root !== null) {
    syncInto(root, html)
    if (final) runScripts(root, html, nonce)
  }
  reportHeight()
}

/** 主题变量。宿主推来的是**已经算好的具体色值**,这里不做任何解释。 */
function onTheme(tokens: Record<string, string>, appearance: string): void {
  const style = document.documentElement.style
  for (const [name, value] of Object.entries(tokens)) style.setProperty(name, value)
  document.documentElement.style.colorScheme = appearance === 'light' ? 'light' : 'dark'
  // 背景保持透明:widget 要看起来长在对话里,而不是嵌了一张白纸进去。
  document.documentElement.dataset['appearance'] = appearance
  reportHeight()
}

/** 加载提示。宿主负责在几条消息之间轮换,这里只管显示当前那条。 */
function onLoading(message: string): void {
  if (loading === null || contentSeen) return
  loading.textContent = message
  reportHeight()
}

window.addEventListener('message', (event: MessageEvent) => {
  // ★ 只认父窗口发来的消息。`origin` 在这里用不了(不透明源是 "null"),
  // 所以判据是身份:这个窗口的 parent 只能有一个。
  if (event.source !== window.parent) return
  const data = event.data as { type?: unknown; html?: unknown; final?: unknown; tokens?: unknown; appearance?: unknown; message?: unknown }
  if (data === null || typeof data !== 'object') return

  switch (data.type) {
    case MESSAGE.content:
      if (typeof data.html === 'string') onContent(data.html, data.final === true)
      return
    case MESSAGE.theme: {
      const tokens = data.tokens
      if (tokens !== null && typeof tokens === 'object' && !Array.isArray(tokens)) {
        const flat: Record<string, string> = {}
        for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
          if (typeof value === 'string') flat[name] = value
        }
        onTheme(flat, typeof data.appearance === 'string' ? data.appearance : 'dark')
      }
      return
    }
    case MESSAGE.loading:
      if (typeof data.message === 'string') onLoading(data.message)
      return
    default:
      // 未知类型一律忽略 —— 前向兼容:宿主将来加的东西,旧外壳安静地不受影响。
      return
  }
})

// 内容一变就重新量:图表加载完、动画跑起来、用户点了滑块都会改变高度。
if (root !== null && typeof ResizeObserver === 'function') {
  new ResizeObserver(reportHeight).observe(root)
}

// 告诉宿主"可以推了"。宿主不一定会等它(推晚了这条只是让它重推一次),
// 但有了它,外壳与宿主的启动顺序就不需要靠定时器去猜。
post({ type: MESSAGE.ready })
