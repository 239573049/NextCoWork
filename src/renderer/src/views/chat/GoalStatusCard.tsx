/**
 * 转录里那张目标状态卡片 —— `{ type: 'goal_status' }` 的渲染。
 *
 * ★ 单独一个文件，不塞进 `Thread.tsx`：那个文件已经很长，而这张卡片有四种形态
 *   （已设立 / 已达成 / 判为不可能 / 已清除），塞进去会让 `PartBlock` 那个
 *   一眼看完的 switch 变成一屏。
 *
 * ★ **条件原文和判定理由不翻译**（AGENTS.md 那条）：它们是用户/模型产出的内容，
 *   不是 UI 文案 —— 翻译它们等于篡改证据。只有周围的标题、字段名走 i18n。
 */
import { CircleCheck, CircleSlash, Target, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ContentPart } from '../../../../shared/agent/message'
import { formatDuration } from '../../../../shared/agent/duration'
import { formatTokenCount } from '../../../../shared/agent/tokens'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type GoalStatus = Extract<ContentPart, { type: 'goal_status' }>

export function GoalStatusCard({ part }: { part: GoalStatus }): ReactNode {
  const { t } = useI18n()
  /*
    ★ 四种形态的判别顺序即语义：`cleared` 压过 `failed` 压过 `met` ——
      一条「已清除」的标记上 `met` 是 false，不先判它就会渲染成「未达成」，
      而用户看到的是一条他刚刚亲手清掉的目标在报告失败。
  */
  const shape = part.cleared === true
    ? 'cleared'
    : part.failed === true
      ? 'impossible'
      : part.met
        ? 'met'
        : part.set === true ? 'set' : 'pending'

  const icon = shape === 'met'
    ? <CircleCheck size={13} />
    : shape === 'impossible'
      ? <XCircle size={13} />
      : shape === 'cleared'
        ? <CircleSlash size={13} />
        : <Target size={13} />

  const title = shape === 'met'
    ? t('goal.card.met')
    : shape === 'impossible'
      ? t('goal.card.impossible')
      : shape === 'cleared'
        ? t('goal.card.cleared')
        : t(shape === 'set' ? 'goal.card.set' : 'goal.card.pending')

  return (
    <div
      className={cn(
        'selectable flex flex-col gap-1 rounded-lg border border-hairline px-3 py-2 text-[12.5px]',
        shape === 'met' && 'text-success',
        shape === 'impossible' && 'text-danger',
        (shape === 'cleared' || shape === 'pending' || shape === 'set') && 'text-fg-muted'
      )}
      data-testid="goal-status-card"
    >
      <span className="flex items-center gap-1.5 font-medium">
        {icon}
        {title}
        {part.iterations !== undefined && part.iterations > 0 && (
          <span className="text-fg-faint">· {t('goal.card.iterations', { count: part.iterations })}</span>
        )}
      </span>
      {/* 条件原文 —— 领域值，原样显示 */}
      <span className="break-words text-fg">{part.condition}</span>
      {shape === 'set' && part.origin === 'proposal_direct' && (
        <span className="text-[11.5px] text-fg-faint">{t('goal.notice.directSet')}</span>
      )}
      {(part.durationMs !== undefined || part.tokens !== undefined) && <span className="text-[11.5px] text-fg-faint">
        {part.durationMs !== undefined && `${t('goal.panel.elapsed')}: ${formatDuration(part.durationMs)}`}
        {part.tokens !== undefined && ` · ${t('goal.panel.tokens')}: ${formatTokenCount(part.tokens)}`}
      </span>}
      {part.reason !== undefined && part.reason !== '' && (
        <span className="break-words text-[11.5px] text-fg-faint">
          {t('goal.card.reason')}: {part.reason}
        </span>
      )}
    </div>
  )
}
