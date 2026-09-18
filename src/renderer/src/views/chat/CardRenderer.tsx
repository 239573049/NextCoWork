/**
 * 声明式工具卡片的渲染器 —— 把 `ToolCard` 的白名单原语摆成版式。
 *
 * ★ 跑在**可信主渲染进程**里(不是插件 iframe),所以每一条都只接受已消毒的数据:
 * `link` 只走 `openExternal`(绝不渲染裸 `<a href>`,否则 `javascript:`/`file:`/顶层导航
 * 会命中宿主窗口);`image` 的 dataRef 已被 `sanitizeToolCard` 限定为 `data:`/`ncw://`。
 *
 * ★ `frame` 卡片不由这里画 —— 它交给 `PluginCardFrame`(插件自己的 iframe),
 * pluginId/path 经 externalName 反查(见 `frameCardTarget`)。
 */
import { useMemo, type ReactNode } from 'react'
import type { CardBlock, CardTone, ToolCard } from '../../../../shared/agent/tool-card'
import { openExternal } from '../../services/app'
import { invoke } from '../../services/ipc'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { PluginCardFrame } from '../../shell/PluginCardFrame'
import { frameCardTarget, pluginIdForTool, usePluginsStore } from '../../stores/plugins'

/** 卡片按钮动作的回传句柄。工具已结束 / 反查不到插件时为 undefined —— 按钮渲染成禁用。 */
type CardActionSink = ((actionId: string, value?: unknown) => void) | undefined

const TONE_TEXT: Record<CardTone, string> = {
  neutral: 'text-fg-faint',
  info: 'text-accent',
  ok: 'text-accent',
  warn: 'text-warning',
  danger: 'text-danger'
}

function StatusBadge({ label, tone }: { label: string; tone?: CardTone }): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill bg-tint px-2 py-0.5 text-[11px]',
        TONE_TEXT[tone ?? 'neutral']
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function Block({ block, onAction }: { block: CardBlock; onAction: CardActionSink }): ReactNode {
  switch (block.type) {
    case 'keyValue':
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          {block.rows.map((row, i) => (
            <div key={i} className="contents">
              <dt className="text-fg-faint">{row.label}</dt>
              <dd className={cn('min-w-0 break-words', TONE_TEXT[row.tone ?? 'neutral'], row.tone === undefined && 'text-fg')}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr>
                {block.columns.map((col, i) => (
                  <th key={i} className="border-b border-line/60 px-2 py-1 font-medium text-fg-faint">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {block.columns.map((_col, c) => (
                    <td key={c} className="border-b border-line/30 px-2 py-1 text-fg">{row[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'status':
      return <StatusBadge label={block.label} tone={block.tone} />
    case 'text':
      return <p className="selectable whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg">{block.value}</p>
    case 'code':
      return (
        <pre className="selectable overflow-x-auto rounded-md bg-tint px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
          {block.value}
        </pre>
      )
    case 'image':
      // dataRef 已被限定为 data:/ncw://,两者都能安全直显;不走 MessageImage 是因为
      // 卡片要的是内联缩略,不需要 lightbox,且这里 data: 也要能画。
      return (
        <img
          src={block.dataRef}
          alt={block.alt ?? ''}
          className="max-h-64 max-w-full rounded-md border border-line/50 object-contain"
        />
      )
    case 'progress':
      return <ProgressBar value={block.fraction} label={block.label ?? ''} />
    case 'link':
      return (
        <button
          type="button"
          onClick={() => void openExternal(block.href)}
          className="inline-flex max-w-full items-center gap-1 truncate text-[12.5px] text-accent hover:underline"
          title={block.href}
        >
          {block.label ?? block.href}
        </button>
      )
    case 'button':
      // 工具已结束(onAction 为空)→ 渲染禁用态:点了也送不到,别给可点的假象。
      return (
        <button
          type="button"
          disabled={onAction === undefined}
          onClick={() => onAction?.(block.actionId)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-line/60 px-2.5 py-1 text-[12px] transition-colors',
            onAction === undefined
              ? 'cursor-not-allowed text-fg-faint opacity-60'
              : cn('hover:bg-tint-hover/60', TONE_TEXT[block.tone ?? 'neutral'], block.tone === undefined && 'text-fg')
          )}
        >
          {block.label}
        </button>
      )
    default:
      // 未知块(旧宿主遇到新原语):静默跳过,别把整张卡打崩。
      return null
  }
}

/** frame 卡片:反查挂载目标 → PluginCardFrame;查不到(插件已卸载/禁用)→ 温和提示。 */
function FrameCard({
  viewType,
  data,
  toolName,
  callId
}: {
  viewType: string
  data: unknown
  toolName: string | undefined
  callId: string | undefined
}): ReactNode {
  const { t } = useI18n()
  const catalog = usePluginsStore((s) => s.catalog)
  const target = useMemo(
    () => (toolName === undefined ? undefined : frameCardTarget(catalog, toolName, viewType)),
    [catalog, toolName, viewType]
  )
  if (target === undefined) {
    return <p className="text-[12px] text-fg-faint">{t('chat.tool.card.unavailable')}</p>
  }
  return (
    <PluginCardFrame
      pluginId={target.pluginId}
      path={target.path}
      viewType={viewType}
      callId={callId}
      data={data}
      label={viewType}
    />
  )
}

export function CardRenderer({
  card,
  toolName,
  callId
}: {
  card: ToolCard
  /** 工具的 externalName —— frame 卡片反查 pluginId 用 */
  toolName?: string
  callId?: string
}): ReactNode {
  const catalog = usePluginsStore((s) => s.catalog)
  // 按钮动作的回传句柄:反查得到 pluginId、且有 callId 才可点。工具结束后 catalog 里
  // 仍能查到 pluginId,但主进程侧 `deliverCardAction` 的 liveToolEmits 门会把迟到的
  // 点击挡掉 —— 这里给不给 sink 只影响「看起来能不能点」,真正的安全在主进程。
  const onAction = useMemo<CardActionSink>(() => {
    if (toolName === undefined || callId === undefined) return undefined
    const pluginId = pluginIdForTool(catalog, toolName)
    if (pluginId === undefined) return undefined
    return (actionId, value) => {
      void invoke('plugins:cardAction', { pluginId, callId, actionId, value })
    }
  }, [catalog, toolName, callId])

  if (card.kind === 'frame') {
    return <FrameCard viewType={card.viewType} data={card.data} toolName={toolName} callId={callId} />
  }
  return (
    <div className="flex flex-col gap-2">
      {card.blocks.map((block, i) => (
        <Block key={i} block={block} onAction={onAction} />
      ))}
    </div>
  )
}
