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
 *
 * ★ 展开区的**内容**住在 `CompactionDetail`,和顶部那个检查点面板共用一份:
 *   两处各写一遍的结果是「分隔线里看得到丢弃统计、顶部面板里看不到」,
 *   而这种差异不会报错。这里只负责那条线、那枚药丸和 token 对比。
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'
import { useI18n } from '../../i18n'
import { Surface, SurfaceReveal } from '../../components/ui/Surface'
import { cn } from '../../lib/cn'
import { CompactionDetail } from './CompactionDetail'

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
  // `'auto'` 是机械压缩的旧写法,和 `'mechanical'` 同义 —— 与顶部面板保持一致。
  const sourceKey = checkpoint.source === 'auto' ? 'mechanical' : checkpoint.source
  const source = t(`chat.contextSource.${sourceKey}` as 'chat.contextSource.model' | 'chat.contextSource.mechanical' | 'chat.contextSource.manual')
  /*
    ★ 机械压缩的 note 是**按规则算出来的事实**,不是笔记:下一次压缩会原样重算。
    放出编辑框只会让用户以为改了有用,而改动会无声蒸发。
  */
  const editable = sourceKey !== 'mechanical'

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

      <SurfaceReveal open={open}>
        <Surface>
          <TokenDelta before={checkpoint.inputTokensBefore} after={checkpoint.inputTokensAfter} />
          <CompactionDetail
            checkpoint={checkpoint}
            editable={editable}
            {...(onRefresh === undefined ? {} : { onRefresh })}
          />
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
