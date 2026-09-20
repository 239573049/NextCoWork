/**
 * 输入框上方的 agent 任务清单。
 *
 * 需求：把 TodoWrite 的真实状态画成紧凑的 Task Rows；这里故意不自带演示计时器，
 * 状态只能由转录数据驱动，否则失败或完成会在界面上被动画伪造。
 */
import { Check, ChevronDown } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Spinner } from '../../components/ui/Spinner'
import { cn } from '../../lib/cn'

type TaskChecklistItem = {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

export function TaskChecklist({
  todos
}: {
  /** TodoWrite 的当前完整快照；顺序由 agent 决定，组件只负责展示。 */
  todos: readonly TaskChecklistItem[]
}): ReactNode {
  const { t } = useI18n()
  const listId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const done = todos.filter((item) => item.status === 'completed').length
  const active = todos.find((item) => item.status === 'in_progress')
  const progress = todos.length === 0 ? 0 : done / todos.length
  const circumference = 2 * Math.PI * 9

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-2" data-testid="task-checklist">
      <div className="overflow-hidden rounded-card border border-stroke bg-surface-raised/70">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          className="flex h-11 w-full min-w-0 items-center gap-2.5 px-2.5 text-left"
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden className="relative flex size-6 shrink-0 items-center justify-center">
            <svg className="absolute inset-0 -rotate-90" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-stroke)" strokeWidth="2" />
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - progress)}
                className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
              />
            </svg>
            <span className="relative text-[9px] font-semibold tabular-nums text-fg">{done}</span>
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">
              {t('chat.taskChecklist', { done, total: todos.length })}
            </span>
            {active !== undefined && (
              <span className="mt-0.5 block truncate text-[11px] text-fg-muted">{active.activeForm}</span>
            )}
          </span>

          <span aria-hidden className="shrink-0 text-[10.5px] tabular-nums text-fg-faint">{Math.round(progress * 100)}%</span>
          <ChevronDown
            aria-hidden
            size={14}
            className={cn(
              'shrink-0 text-fg-faint transition-transform duration-200 motion-reduce:transition-none',
              collapsed && '-rotate-90'
            )}
          />
        </button>

        <div
          id={listId}
          aria-hidden={collapsed}
          inert={collapsed}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <ul className="scroll-thin max-h-40 overflow-y-auto border-t border-hairline px-1 py-1">
              {todos.map((item, index) => {
                const label = item.status === 'in_progress' ? item.activeForm : item.content
                const statusLabel = item.status === 'completed'
                  ? t('chat.status.done')
                  : item.status === 'in_progress'
                    ? t('chat.taskChecklistRunning')
                    : t('chat.tool.waitingStatus')
                return (
                  <li
                    key={`${String(index)}:${item.content}`}
                    data-task-status={item.status}
                    className={cn(
                      'flex min-h-8 items-center gap-2 rounded-[7px] px-1.5 py-1 text-[12px]',
                      item.status === 'in_progress' && 'bg-accent/[0.045]'
                    )}
                  >
                    <span className="relative flex size-5 shrink-0 items-center justify-center" aria-hidden>
                      {item.status === 'completed' ? (
                        <span className="flex size-5 items-center justify-center rounded-pill bg-accent text-accent-fg">
                          <Check size={11} strokeWidth={3} />
                        </span>
                      ) : item.status === 'in_progress' ? (
                        // Spinner 负责应用内“减弱/关闭动效”两档，不能退回裸 CSS 旋转。
                        <Spinner size="sm" className="text-accent" />
                      ) : (
                        <span className="flex size-5 items-center justify-center rounded-pill border border-stroke text-[9px] tabular-nums text-fg-faint">
                          {index + 1}
                        </span>
                      )}
                    </span>
                    <span className={cn(
                      'min-w-0 flex-1 break-words leading-relaxed',
                      item.status === 'completed' ? 'text-fg-faint' : item.status === 'in_progress' ? 'text-fg' : 'text-fg-muted'
                    )}>
                      {label}
                    </span>
                    <span className="sr-only">{statusLabel}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
