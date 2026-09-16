/**
 * 消息流里标记「上下文在这里被压缩过」的一条线。
 *
 * ★ **它标的是位置,不是一条消息。** 所以做成一条贯穿的细线加一枚居中的药丸,
 * 而不是又一个气泡 —— 气泡会被读成「有人说了句话」,而这里发生的事情是
 * 更早的历史从此不再原样发给模型。
 *
 * ★ 只复用已有的 token 和结构:线是 `h-px bg-stroke`(装饰性收边,不是控件轮廓 ——
 *   见 `theme.css` 里 `--color-stroke` 那段),药丸是 `rounded-pill bg-tint`,
 *   展开区走公共的 `Surface`。不为这一处新起一套设计语言。
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, Pencil, Save } from 'lucide-react'
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'
import { useI18n } from '../../i18n'
import { Surface, SurfaceReveal } from '../../components/ui/Surface'
import { updateContextCheckpoint } from '../../services/context'
import { cn } from '../../lib/cn'

export function CompactionDivider({
  checkpoint,
  foldedCount,
  onRefresh
}: {
  checkpoint: ContextCheckpoint
  foldedCount: number
  onRefresh?: (checkpoint: ContextCheckpoint) => void
}): ReactNode {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(checkpoint.note)
  const [saving, setSaving] = useState(false)
  // `'auto'` 是机械压缩的旧写法,和 `'mechanical'` 同义 —— 与顶部面板保持一致。
  const sourceKey = checkpoint.source === 'auto' ? 'mechanical' : checkpoint.source
  const source = t(`chat.contextSource.${sourceKey}` as 'chat.contextSource.model' | 'chat.contextSource.mechanical' | 'chat.contextSource.manual')
  /*
    ★ 机械压缩的 note 是**按规则算出来的事实**,不是笔记:下一次压缩会原样重算。
    放出编辑框只会让用户以为改了有用,而改动会无声蒸发。
  */
  const editable = sourceKey !== 'mechanical'

  async function save(): Promise<void> {
    setSaving(true)
    try {
      onRefresh?.(await updateContextCheckpoint(checkpoint.id, note, checkpoint.revision))
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="compaction-divider" data-source={sourceKey}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={t('chat.compaction.toggle')}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-tint px-2.5 py-1 text-[11px] text-fg-faint transition hover:text-fg"
        >
          <ChevronDown size={12} aria-hidden className={cn('transition-transform', !open && '-rotate-90')} />
          <span>{t('chat.compaction.label')}</span>
          <span aria-hidden className="text-fg-faint/50">·</span>
          <span>{source}</span>
          {foldedCount > 0 && (
            <>
              <span aria-hidden className="text-fg-faint/50">·</span>
              <span>{t('chat.compaction.folded', { count: foldedCount })}</span>
            </>
          )}
        </button>
        <span aria-hidden className="h-px flex-1 bg-stroke" />
      </div>

      <SurfaceReveal open={open} divider={false}>
        <Surface className="px-3 py-2">
          <TokenDelta before={checkpoint.inputTokensBefore} after={checkpoint.inputTokensAfter} />
          {editing ? (
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="min-h-28 w-full resize-y rounded border border-border bg-surface-input p-2 text-[12px] text-fg outline-none focus:border-accent"
              aria-label={t('chat.contextNote')}
            />
          ) : (
            <p className="scroll-thin max-h-[min(40vh,320px)] overflow-y-auto break-words pr-1 whitespace-pre-wrap text-[12px] leading-[1.5] text-fg-muted">{checkpoint.note}</p>
          )}
          <div className="mt-2 flex items-center justify-end gap-1.5">
            {!editable ? (
              <span className="text-[11px] text-fg-faint">{t('chat.compaction.readOnly')}</span>
            ) : editing ? (
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-accent" onClick={() => void save()} disabled={saving}>
                <Save size={12} aria-hidden />{t('chat.contextSave')}
              </button>
            ) : (
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg" onClick={() => setEditing(true)}>
                <Pencil size={12} aria-hidden />{t('chat.contextEdit')}
              </button>
            )}
          </div>
        </Surface>
      </SurfaceReveal>
    </div>
  )
}

/**
 * 压缩前后的 token 对比。
 *
 * ★ **缺一边就整块不画。** 检查点刚建出来时只有 `before`,`after` 要等下一次
 * 组装回填;这时候单独显示一个数字会被读成「压缩后就这么多」,而它恰恰是压缩**前**的。
 */
function TokenDelta({ before, after }: { before?: number; after?: number }): ReactNode {
  const { t } = useI18n()
  if (before === undefined || after === undefined || before <= 0) return null
  const ratio = Math.min(1, Math.max(0, after / before))
  return (
    <div className="mb-2 flex items-center gap-2 text-[11px] text-fg-faint">
      <span>{t('chat.compaction.tokens', { before, after })}</span>
      <div className="h-[3px] w-16 overflow-hidden rounded-pill bg-tint">
        <div className="h-full rounded-pill bg-fg-faint" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}
