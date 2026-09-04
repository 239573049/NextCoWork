/**
 * L2:运行中的分组折叠时间线。
 *
 * ★ 它**只负责一段连续的过程块**(`segmentize` 切出来的一个 `process` 段),
 * 不知道自己上方或下方有没有正文,也不知道 run 有没有结束 ——
 * 后者由 `running` 入参告知,前者根本不该由它关心。
 * 这条边界让同一个组件能同时服务于「已提交消息」和「还在流的块」两条路径。
 */
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { formatDuration } from '../../../../shared/agent/duration'
import type { ToolCallState } from '../../../../shared/agent/transcript'
import {
  computeAutoCollapsed,
  groupDuration,
  groupItems,
  groupKey,
  groupTitle,
  shapeOfItem,
  statusOfItem,
  type TimelineItem
} from '../../../../shared/domain/tool-timeline'
import { cn } from '../../lib/cn'
import { SubagentNode, ThinkingBlock, ToolCallCard } from './parts'
import { ShapeStrip } from './ToolIcon'
import { useGroupCollapse } from './useGroupCollapse'

export function ToolTimeline({
  items,
  tools,
  running,
  focusCallId
}: {
  items: readonly TimelineItem[]
  tools: Readonly<Record<string, ToolCallState>>
  running: boolean
  /** 从文件审查回跳时定位到的那一行;所在组强制展开并滚入视口 */
  focusCallId?: string | undefined
}): ReactNode {
  if (items.length === 0) return null

  const groups = groupItems(items, tools)
  const autoCollapsed = computeAutoCollapsed({ groups, tools, running })

  return (
    <div className="flex flex-col gap-2" data-testid="tool-timeline">
      {groups.map((g, i) => (
        <ToolGroup
          // ★ key 用**首项**的 key,不用下标。理由见 tool-timeline.ts 的 groupKey:
          // 下标会让「用户展开过第 2 组」的意图在重新分组后漂到别的组身上。
          key={groupKey(g)}
          items={g}
          tools={tools}
          autoCollapsed={autoCollapsed[i] ?? false}
          focusCallId={focusCallId}
        />
      ))}
    </div>
  )
}

function ToolGroup({
  items,
  tools,
  autoCollapsed,
  focusCallId
}: {
  items: readonly TimelineItem[]
  tools: Readonly<Record<string, ToolCallState>>
  autoCollapsed: boolean
  focusCallId: string | undefined
}): ReactNode {
  const hasError = items.some((it) => statusOfItem(it, tools) === 'error')
  const hasFocus =
    focusCallId !== undefined &&
    items.some((it) => it.kind === 'tool' && it.callId === focusCallId)

  const { collapsed, toggle } = useGroupCollapse(autoCollapsed, hasError || hasFocus)
  const ref = useRef<HTMLDivElement>(null)

  /**
   * 回跳定位。用 `nearest` 而不是 `center` —— `center` 会让**已经在视口里**的
   * 目标行也发生滚动,看起来像界面自己抖了一下。
   */
  useEffect(() => {
    if (!hasFocus) return
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [hasFocus])

  // 单项组不套折叠外壳:一行内容加一个「1 项」的标题是纯粹的噪音
  if (items.length === 1 && !collapsed) {
    return (
      <div ref={ref}>
        <TimelineRow item={items[0]!} tools={tools} />
      </div>
    )
  }

  if (collapsed) {
    return (
      <div ref={ref}>
        <CollapsedGroupBar items={items} tools={tools} onExpand={toggle} />
      </div>
    )
  }

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      <GroupHeader items={items} tools={tools} collapsed={false} onToggle={toggle} />
      <div className="flex flex-col gap-1.5 pl-2">
        {items.map((it) => (
          <TimelineRow key={it.key} item={it} tools={tools} />
        ))}
      </div>
    </div>
  )
}

/** 坍缩态:一行标题,点开即展开。**无动画** —— 理由见设计文档 §2.3。 */
function CollapsedGroupBar({
  items,
  tools,
  onExpand
}: {
  items: readonly TimelineItem[]
  tools: Readonly<Record<string, ToolCallState>>
  onExpand: () => void
}): ReactNode {
  return (
    <GroupHeader
      items={items}
      tools={tools}
      collapsed
      onToggle={onExpand}
    />
  )
}

function GroupHeader({
  items,
  tools,
  collapsed,
  onToggle
}: {
  items: readonly TimelineItem[]
  tools: Readonly<Record<string, ToolCallState>>
  collapsed: boolean
  onToggle: () => void
}): ReactNode {
  const ms = groupDuration(items, tools)
  const shapes = [...new Set(items.map((it) => shapeOfItem(it, tools)))]
  const errorCount = items.filter((it) => statusOfItem(it, tools) === 'error').length
  const runningCount = items.filter((it) => statusOfItem(it, tools) === 'running').length

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-testid="tool-group"
      data-collapsed={collapsed}
      className="flex w-full items-center gap-2 rounded-[7px] px-3 py-1.5 text-left text-[11.5px] text-fg-faint transition-colors hover:bg-tint-hover/40"
    >
      <ChevronRight
        size={12}
        className={cn('shrink-0 transition-transform', !collapsed && 'rotate-90')}
      />
      <ShapeStrip shapes={shapes} />
      <span className="min-w-0 truncate">{groupTitle(items, tools)}</span>
      {runningCount > 0 && <span className="shrink-0 text-accent">执行中</span>}
      {ms > 0 && <span className="shrink-0 font-mono">{formatDuration(ms)}</span>}
      {/* 失败标记即使在收起态也必须可见 —— 「这里有个失败被我收起来了」 */}
      {errorCount > 0 && (
        <span className="shrink-0 text-danger">{errorCount} 个失败</span>
      )}
    </button>
  )
}

/** 三种块的分派。与改造前 `Thread.tsx` 的 PartBlock 保持同构。 */
function TimelineRow({
  item,
  tools
}: {
  item: TimelineItem
  tools: Readonly<Record<string, ToolCallState>>
}): ReactNode {
  switch (item.kind) {
    case 'thinking':
      return <ThinkingBlock text={item.text} streaming={item.streaming} />
    case 'subagent':
      return <SubagentNode summary={item.summary} />
    case 'tool':
      return (
        <ToolCallCard
          call={item.callId === undefined ? undefined : tools[item.callId]}
          name={item.name}
          input={item.input}
        />
      )
  }
}
