import { RefreshCw, ChevronDown } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { CompactionDetail } from './CompactionDetail'

export function ContextCheckpointPanel({
  checkpoints,
  onRefresh
}: {
  checkpoints: readonly ContextCheckpoint[]
  onRefresh?: (checkpoint: ContextCheckpoint) => void
}): ReactNode {
  const { t } = useI18n()
  const [items, setItems] = useState<readonly ContextCheckpoint[]>(checkpoints)
  useEffect(() => setItems(checkpoints), [checkpoints])
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="context-checkpoints">
      {items.map((checkpoint) => (
        <CheckpointRow key={checkpoint.id} checkpoint={checkpoint} onRefresh={(next) => {
          setItems((current) => current.map((item) => item.id === next.id ? next : item))
          onRefresh?.(next)
        }} />
      ))}
      <span className="text-[11px] text-fg-faint">{t('chat.contextCheckpointHint')}</span>
    </div>
  )
}

function CheckpointRow({ checkpoint, onRefresh }: { checkpoint: ContextCheckpoint; onRefresh?: (checkpoint: ContextCheckpoint) => void }): ReactNode {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const sourceKey = checkpoint.source === 'auto' ? 'mechanical' : checkpoint.source
  const source = t(`chat.contextSource.${sourceKey}` as 'chat.contextSource.model' | 'chat.contextSource.mechanical' | 'chat.contextSource.manual')

  return (
    <div className="rounded-card border border-hairline bg-surface-raised/40 px-3 py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left text-[12px] text-fg-faint" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ChevronDown size={13} className={cn('transition-transform', !open && '-rotate-90')} aria-hidden />
        <span className="flex-1">{t('chat.contextCheckpoint', { window: checkpoint.windowIndex })}</span>
        <span>{source}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {/* 详情与分隔线共用一份 —— 两处各写一遍必然分头演化,见 `CompactionDetail`。 */}
          <CompactionDetail
            checkpoint={checkpoint}
            editable={sourceKey !== 'mechanical'}
            {...(onRefresh === undefined ? {} : { onRefresh })}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg" onClick={() => onRefresh?.(checkpoint)}><RefreshCw size={12} aria-hidden />{t('chat.contextRebuild')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
