/**
 * 内置可视化 widget 的**契约常量** —— scheme、外壳地址、两边共用的消息名。
 *
 * 需求:这三个东西在**两个进程、两个 origin** 上各有一份使用者(main 侧
 * `net/widget-protocol.ts` 与 `net/widget-shell/runtime.ts`,渲染层
 * `shell/WidgetFrame.tsx`),而它们必须逐字一致。分别写死的话,漂移的表现是
 * "框出来了、里面永远是空的"这类零报错的故障 —— 与本仓库对
 * `ncw-plugin://` 那两处 CSP 的处理是同一个道理(`renderer/index.html` 里
 * 那条注释:"两处 CSP 都要有它,只改一处的话开发时正常、打包后图片全不显示,
 * 而且不报错")。
 *
 * ★ 这里**只放常量与类型**。who serves what、CSP 里允许哪些域名这类策略,
 * 留在各自的实现里:那些是"必须能一眼看出被谁改过"的东西。
 */

/** widget 外壳的 scheme。与 `ncw-plugin://` / `ncw://` 并列的第三条自定义 scheme。 */
export const WIDGET_SCHEME = 'ncw-widget'

/** 外壳页面的 host 段。协议层只认这一个 —— 它不是插件 id,不需要可变。 */
export const WIDGET_SHELL_HOST = 'shell'

export const WIDGET_SHELL_PATH = '/index.html'

/** iframe 的 `src`。渲染层用它,协议层用 host + path 判断该不该响应。 */
export const WIDGET_SHELL_URL = `${WIDGET_SCHEME}://${WIDGET_SHELL_HOST}${WIDGET_SHELL_PATH}`

/**
 * postMessage 的类型名。
 *
 * 前缀与插件卡片一致(`ncw:`),后缀分成两段:载体(widget)→ 方向。
 * 前三个是宿主 → 外壳,后两个是外壳 → 宿主。
 */
export const WIDGET_MESSAGE = {
  /** 宿主 → 外壳:一段(可能还没写完的)HTML + 是否已收尾 */
  content: 'ncw:widget:content',
  /** 宿主 → 外壳:主题变量(已算好的具体色值)与外观 */
  theme: 'ncw:widget:theme',
  /** 宿主 → 外壳:当前那条加载提示 */
  loading: 'ncw:widget:loading',
  /** 外壳 → 宿主:运行时已就绪,可以推了 */
  ready: 'ncw:widget:ready',
  /** 外壳 → 宿主:内容高度,宿主钳制后设给 iframe */
  height: 'ncw:widget:height'
} as const

/** 外壳报上来的高度。`height` 是未钳制的原始值 —— 钳制由宿主做。 */
export interface WidgetHeightMessage {
  type: typeof WIDGET_MESSAGE.height
  height: number
}

/** 宿主推下去的内容帧。`final` 为真时外壳会执行脚本,只做一次。 */
export interface WidgetContentMessage {
  type: typeof WIDGET_MESSAGE.content
  html: string
  final: boolean
}

/**
 * `WIDGET_MESSAGE` 的形状 —— **给 widget 外壳的运行时用**。
 *
 * ★ 存在理由很具体:那份运行时是 iframe 里的一条**自包含**脚本
 * (`ncw-widget://shell/runtime.js`,由 main 段的第二个入口产出),它**不能**
 * 按值 import 这个文件 —— 一旦按值 import,rollup 会把这个模块提到两个入口
 * 共用的 chunk 里,而 iframe 永远取不到那个 chunk(协议只服务固定两个路径)。
 * 于是它在自己的文件里重写一遍那五个字符串,再用 `satisfies` 挂到这个类型上:
 * 编译期保证两边逐字一致,而产物里一行 import 都没有。
 *
 * 删掉这个类型,下一个人就会把运行时的 import 改回按值 —— 那一次改动**构建
 * 依然成功**,只是 widget 一片空白。
 */
export type WidgetMessageNames = typeof WIDGET_MESSAGE
