import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { SubagentState, ToolCallState } from '../../../../shared/agent/transcript'
import { formatDuration } from '../../../../shared/agent/duration'
import type { TimelineItem } from '../../../../shared/domain/tool-timeline'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { ToolTimeline } from './ToolTimeline'

/**
 * The compact summary for a completed agent turn. The answer is rendered by
 * the caller after this block, so opening the row is always an explicit choice
 * to inspect the preceding thinking and tool activity.
 */
export function RunProcessBlock({
  items,
  tools,
  subagents,
  durationMs,
  defaultOpen = false,
  children
}: {
  items: readonly TimelineItem[]
  tools: Readonly<Record<string, ToolCallState>>
  subagents?: Readonly<Record<string, SubagentState>>
  durationMs?: number
  defaultOpen?: boolean
  /** The complete content before the final answer, including explanatory prose. */
  children?: ReactNode
}): ReactNode {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  const label = durationMs === undefined
    ? t('chat.run.process')
    : t('chat.run.elapsed', { duration: formatDuration(durationMs) })

  return (
    <div
      data-testid="run-process-block"
      data-open={open}
      className="flex flex-col"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-0 py-1.5 text-left text-[12px] text-fg-faint transition-colors hover:text-fg"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 pl-3">
          {children ?? <ToolTimeline items={items} tools={tools} subagents={subagents} />}
        </div>
      )}
    </div>
  )
}
