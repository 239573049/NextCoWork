import { Pencil, RefreshCw, Save, ChevronDown } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'
import { useI18n } from '../../i18n'
import { updateContextCheckpoint } from '../../services/context'
import { cn } from '../../lib/cn'

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
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(checkpoint.note)
  const [saving, setSaving] = useState(false)
  const sourceKey = checkpoint.source === 'auto' ? 'mechanical' : checkpoint.source
  const source = t(`chat.contextSource.${sourceKey}` as 'chat.contextSource.model' | 'chat.contextSource.mechanical' | 'chat.contextSource.manual')

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const next = await updateContextCheckpoint(checkpoint.id, note, checkpoint.revision)
      onRefresh?.(next)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-card border border-hairline bg-surface-raised/40 px-3 py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left text-[12px] text-fg-faint" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ChevronDown size={13} className={cn('transition-transform', !open && '-rotate-90')} aria-hidden />
        <span className="flex-1">{t('chat.contextCheckpoint', { window: checkpoint.windowIndex })}</span>
        <span>{source}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {editing ? (
            <textarea value={note} onChange={(event) => setNote(event.target.value)} className="min-h-28 w-full resize-y rounded border border-border bg-surface-input p-2 text-[12px] text-fg outline-none focus:border-accent" aria-label={t('chat.contextNote')} />
          ) : <p className="whitespace-pre-wrap text-[12px] leading-[1.5] text-fg-muted">{checkpoint.note}</p>}
          <div className="flex items-center justify-end gap-1.5">
            {editing ? (
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-accent" onClick={() => void save()} disabled={saving}><Save size={12} aria-hidden />{t('chat.contextSave')}</button>
            ) : (
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg" onClick={() => setEditing(true)}><Pencil size={12} aria-hidden />{t('chat.contextEdit')}</button>
            )}
            <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg" onClick={() => onRefresh?.(checkpoint)}><RefreshCw size={12} aria-hidden />{t('chat.contextRebuild')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
