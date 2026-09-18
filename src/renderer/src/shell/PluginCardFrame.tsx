/**
 * 工具结果的 **frame 卡片**外壳 —— 内联版的 `PluginViewFrame`。
 *
 * 与侧栏视图(`PluginViewFrame`)刻意分开:卡片是**内联在聊天流里、随消息滚动、
 * 只读数据单向推入、高度协商、可回收**的,和常驻一个 pane 的视图生命周期不同。
 * 复用的是同一套隔离基建(`ncw-plugin://<id>` 跨源 iframe、sandbox、主题 postMessage、
 * 来源双重核对),换掉的是数据方向与尺寸策略。
 *
 * ## 数据只进不出
 *
 * 宿主把工具结果的 `data` 快照经 `ncw:card:data` **单向推入**,卡片只读渲染。
 * 它不像编辑器那样能存回工作区 —— 卡片是「这次工具调用产出的一张画」,不是文档。
 *
 * ## 高度协商
 *
 * 卡片内联,不能无限长。iframe 里的内容经 `ncw:card:height` 上报自己的高度,
 * 宿主**钳制在上限内**再应用。不给上限的话,一个插件报 100000px 就能把聊天顶飞。
 *
 * ## 只在展开态挂载
 *
 * 调用方(`CardRenderer`)只有在工具卡片展开时才渲染这个组件,折叠即卸载 iframe。
 * 一条长对话里可能有几十个工具结果,常驻 iframe 会很重。
 *
 * ## 为第 2 层(交互式卡片)留的位
 *
 * message switch 带 `default` 分支**忽略未知类型**(前向兼容),并预留 `ncw:card:action`
 * 上行类型名 —— 本层不消费。信封里已带上 `callId` / `pluginId`,交互回传时按它路由。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { THEME_TOKENS } from '../../../shared/domain/theme'
import { cn } from '../lib/cn'
import { invoke } from '../services/ipc'

export interface PluginCardFrameProps {
  pluginId: string
  /** 包内相对路径,来自 `contributes.cardViews[].path` */
  path: string
  viewType: string
  /** 这次工具调用的 id —— 随数据下发,给第 2 层交互回传路由用 */
  callId?: string
  /** 只读数据快照,单向推入 */
  data: unknown
  /** 无障碍名字,已 `t()` */
  label: string
  className?: string
}

/** 卡片高度钳制:太矮看不见内容,太高把聊天顶飞。 */
const MIN_HEIGHT = 40
const MAX_HEIGHT = 720

export function PluginCardFrame({ pluginId, path, viewType, callId, data, label, className }: PluginCardFrameProps): ReactNode {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const origin = `ncw-plugin://${pluginId}`
  const src = `${origin}/${path.replace(/^\.?\//, '')}`

  // 主题同步:与 PluginViewFrame 同样的三时机 postMessage(load / 主题变化 / 重载)。
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const post = (): void => {
      const root = document.documentElement
      const style = getComputedStyle(root)
      const tokens: Record<string, string> = {}
      for (const token of THEME_TOKENS) tokens[token] = style.getPropertyValue(`--color-${token}`).trim()
      frame.contentWindow?.postMessage(
        { type: 'ncw:theme', tokens, appearance: root.dataset.theme ?? 'dark', motion: root.dataset.themeMotion ?? 'full' },
        origin
      )
    }
    frame.addEventListener('load', post)
    const observer = new MutationObserver(post)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-motion', 'style'] })
    return () => {
      frame.removeEventListener('load', post)
      observer.disconnect()
    }
  }, [origin])

  // 数据下发 + 高度上报。数据变化时重推;卡片自己 ready 时也推一次(它可能晚于 data 就绪)。
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const send = (): void => {
      frame.contentWindow?.postMessage({ type: 'ncw:card:data', viewType, pluginId, callId, data }, origin)
    }
    const onMessage = (event: MessageEvent): void => {
      // ★ 来源逐条核对:同窗口里还有别的 frame,只认 origin 的话会被冒充。
      if (event.source !== frame.contentWindow || event.origin !== origin) return
      const message = event.data as { type?: string; height?: unknown; actionId?: unknown; value?: unknown }
      if (message === null || typeof message !== 'object') return
      switch (message.type) {
        case 'ncw:card:ready':
          send()
          return
        case 'ncw:card:height':
          if (typeof message.height === 'number' && Number.isFinite(message.height)) {
            setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(message.height))))
          }
          return
        case 'ncw:card:action':
          // 交互回传:frame 里点了按钮 → 反向通道回到仍在运行的工具(第 2 层)。
          // callId 缺席(不是实时卡片)时无处可送,忽略。
          if (callId !== undefined && typeof message.actionId === 'string') {
            void invoke('plugins:cardAction', { pluginId, callId, actionId: message.actionId, value: message.value })
          }
          return
        default:
          // 其它未知类型一律忽略 —— 前向兼容,别 reject。
          return
      }
    }
    window.addEventListener('message', onMessage)
    frame.addEventListener('load', send)
    send()
    return () => {
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', send)
    }
  }, [origin, viewType, pluginId, callId, data])

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={label}
      // 与 PluginViewFrame 同一套 sandbox:安全来自 origin 差异,不是这几个属性。
      sandbox="allow-same-origin allow-scripts allow-forms"
      style={{ height }}
      className={cn('w-full rounded-md border border-line/60 bg-canvas', className)}
    />
  )
}
