/**
 * 可视化 widget 的**宿主侧外壳** —— 内联在工具卡片里的那个 iframe。
 *
 * 需求:模型产出的一段 HTML/SVG 要长在对话里,而且要**边生成边长出来**。
 * 它是内置 `visualize_show_widget` 的渲染末端,和插件卡片
 * (`shell/PluginCardFrame.tsx`)是同一类东西的两个变体。刻意没有合并成一个
 * 组件:插件卡片拿的是"一次性推入的只读快照 + pluginId 反查",这里拿的是
 * "一份持续增长的 HTML + 自己的 scheme",数据方向与生命周期都不一样
 * (见 `shared/agent/tool-card.ts` 里 `kind: 'widget'` 上那段说明)。
 *
 * ## 三条不变式
 *
 * 1. **iframe 是不透明源**(`sandbox="allow-scripts"` 而**没有** `allow-same-origin`)。
 *    widget 是模型生成的任意 HTML,一旦允许同源,它就能拿到父文档 ——
 *    而父文档里有那份 preload 桥。全仓唯一被允许同源嵌入的是插件视图,
 *    那是因为插件有清单、有权限声明、由用户显式安装。
 * 2. **只信 `event.source`。** 不透明源发来的消息 `event.origin` 是字符串
 *    `"null"`,拿它做判据等于没判。身份来自"这个窗口手里的那个 contentWindow
 *    引用"—— 冒充者拿不到它。
 * 3. **高度由 iframe 报、宿主钳制。** 不钳制的话一个报 100000px 的 widget
 *    能把聊天顶飞;钳得太小又会让内容出现内滚动条,而"卡片里套一个滚动条"
 *    是这套 UI 里最难用的形态之一。
 *
 * ## 为什么这里有一份"半截 HTML"
 *
 * `code` 从两个来源来,取决于这次工具调用走到哪一步(`WidgetDetail.tsx` 里写着):
 * 生成中拿的是**半截参数**,生成完拿的是卡片里那份完整代码。两条路都汇到
 * 这个组件的 `code`/`final` 两个 prop 上 —— 于是"边写边渲染"和"重开对话看到成品"
 * 是同一段渲染代码,不需要两套。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WIDGET_MESSAGE, WIDGET_SHELL_URL } from '../../../../shared/domain/widget'
import { WIDGET_SOURCE_VARS, widgetTokens } from '../../theme/widget-tokens'
import { cn } from '../../lib/cn'
import { createPushScheduler } from './widget-push'

/**
 * 高度钳制区间。
 *
 * ★ 下限 60 而不是 40:widget 里常常先出现一个加载提示或一行标题,
 * 太矮的话那几帧会被裁掉半行字。
 * ★ 上限 1400 比插件卡片的 720 宽得多 —— 仪表盘与长流程图是这套东西的
 * 常规产物,把它们压进 720 只会得到一个内滚动条。上限的作用只是挡住
 * "一次失控的高度上报",不是限流正常内容。
 */
const MIN_HEIGHT = 60
const MAX_HEIGHT = 1400

/** 加载提示的轮换间隔。只在内容出现之前有意义。 */
const LOADING_ROTATE_MS = 2200

export interface WidgetFrameProps {
  /** 当前这份 HTML —— 生成中是半截的,完成后是完整的 */
  code: string
  /** 生成是否已结束。为真时 iframe 里才会执行脚本(只执行一次) */
  final: boolean
  /** 无障碍名字。模型给的 snake_case 标识,属领域值,不翻译 */
  title: string
  /** 内容出现之前轮换显示的提示词,来自模型。可能为空数组 */
  loadingMessages?: readonly string[]
  className?: string
}

export function WidgetFrame({ code, final, title, loadingMessages, className }: WidgetFrameProps): ReactNode {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [loadingIndex, setLoadingIndex] = useState(0)

  /**
   * 主题变量。**在推送那一刻现读**,不在渲染期读:换色器改的是
   * `documentElement` 上的 CSS 变量,而 React 不会因为 CSS 变量变化而重渲
   * —— 提前算好再 memo 会得到一份永远停在首次渲染的值。
   */
  const readTheme = useCallback((): { tokens: Record<string, string>; appearance: string; motion: string } => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    const source: Partial<Record<(typeof WIDGET_SOURCE_VARS)[number], string>> = {}
    for (const name of WIDGET_SOURCE_VARS) source[name] = style.getPropertyValue(name).trim()
    const appearance = root.dataset['theme'] === 'light' ? 'light' : 'dark'
    return {
      tokens: widgetTokens(appearance, source),
      appearance,
      motion: root.dataset['themeMotion'] ?? 'full'
    }
  }, [])

  /** 往 iframe 里发一条消息。targetOrigin 只能是 `'*'` —— 见文件头第 2 条。 */
  const post = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  /** 把当前状态整份重推。`load` 与 `ready` 都走它 —— 两边的启动顺序不需要靠猜。 */
  const pushAll = useCallback(() => {
    const theme = readTheme()
    post({ type: WIDGET_MESSAGE.theme, tokens: theme.tokens, appearance: theme.appearance, motion: theme.motion })
    post({ type: WIDGET_MESSAGE.loading, message: loadingMessages?.[loadingIndex] ?? '' })
    post({ type: WIDGET_MESSAGE.content, html: code, final })
  }, [post, readTheme, loadingMessages, loadingIndex, code, final])

  /*
    推送节流。★ 依赖里刻意**没有** `code`/`final`:调度器是一份长期存活的对象,
    内容变化经 `offer` 交给它,而不是每次都重建 —— 重建会丢掉待发的那一份,
    也会把"到点就发"的节奏打乱。见 `widget-push.ts` 的文件头。
  */
  const scheduler = useMemo(
    () => createPushScheduler((html, isFinal) => post({ type: WIDGET_MESSAGE.content, html, final: isFinal })),
    [post]
  )

  useEffect(() => {
    scheduler.offer(code, final)
  }, [scheduler, code, final])

  // 卸载前把待发的最后一份发出去,再拆掉定时器。
  useEffect(() => () => {
    scheduler.flush()
    scheduler.dispose()
  }, [scheduler])

  // 主题变化(换色器 / 深色切换 / 动效档位)要重推,否则 widget 会停在旧配色上。
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      const theme = readTheme()
      post({ type: WIDGET_MESSAGE.theme, tokens: theme.tokens, appearance: theme.appearance, motion: theme.motion })
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-motion', 'data-theme-font', 'data-theme-weight', 'style'] })
    return () => {
      observer.disconnect()
    }
  }, [post, readTheme])

  // 加载提示轮换。内容一到就没用了(iframe 里自己会把它藏掉)。
  useEffect(() => {
    if (final || (loadingMessages?.length ?? 0) <= 1) return
    const timer = setInterval(() => {
      setLoadingIndex((index) => index + 1)
    }, LOADING_ROTATE_MS)
    return () => {
      clearInterval(timer)
    }
  }, [final, loadingMessages])

  // 提示换了一条也要推下去。跟着 loadingIndex 走。
  useEffect(() => {
    const message = loadingMessages?.[loadingIndex % Math.max(1, loadingMessages.length)]
    if (message !== undefined) post({ type: WIDGET_MESSAGE.loading, message })
  }, [post, loadingMessages, loadingIndex])

  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const onMessage = (event: MessageEvent): void => {
      // ★ 只认这一个 frame 发来的。见文件头第 2 条:origin 在这里是 "null"。
      if (event.source !== frame.contentWindow) return
      // 入参是 `unknown` 的世界:iframe 里跑的是页面脚本,消息体只能逐字段收窄。
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (data === null || typeof data !== 'object') return
      if (data.type === WIDGET_MESSAGE.ready) {
        pushAll()
        return
      }
      if (data.type === WIDGET_MESSAGE.height && typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(data.height))))
      }
    }
    const onLoad = (): void => pushAll()
    window.addEventListener('message', onMessage)
    frame.addEventListener('load', onLoad)
    return () => {
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', onLoad)
    }
  }, [pushAll])

  return (
    <iframe
      ref={frameRef}
      src={WIDGET_SHELL_URL}
      title={title}
      // 见文件头第 1 条。allow-forms 是给规范里那批表单/滑块用的。
      sandbox="allow-scripts allow-forms"
      style={{ height }}
      className={cn('w-full border-0 bg-transparent', className)}
    />
  )
}
