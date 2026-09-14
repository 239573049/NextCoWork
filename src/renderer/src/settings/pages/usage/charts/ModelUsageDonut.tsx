/**
 * 模型用量环形图 + 右侧图例(参考图第二张右半)。
 *
 * 配色来自 `colors.ts` 的派生色阶,而不是一组新增的分类色 token —— 理由见那个
 * 文件的头注释。色阶按占比降序,所以**最大的一片最浓**,读图不必来回对图例。
 */
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { useI18n } from '../../../../i18n'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { formatCompactNumber, formatPercent } from '../usage-format'
import type { ModelShare } from '../usage-overview'
import { seriesColor } from './colors'

export function ModelUsageDonut({
  shares,
  totalTokens
}: {
  shares: readonly ModelShare[]
  totalTokens: number
}): React.ReactNode {
  const { t, locale } = useI18n()

  if (shares.length === 0) return <EmptyState title={t('usage.models.empty')} />

  const labelOf = (share: ModelShare): string =>
    share.key === '__others__' ? t('usage.models.others') : share.label

  return (
    <div className="flex flex-col items-center gap-4 min-[720px]:flex-row">
      <div className="relative h-[180px] w-[180px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={shares as ModelShare[]}
              dataKey="tokens"
              nameKey="label"
              innerRadius={56}
              outerRadius={82}
              paddingAngle={1.5}
              stroke="var(--color-canvas)"
              strokeWidth={1.5}
              // 进场动画在切换时间范围时会整圈重画一次,晃眼
              isAnimationActive={false}
            >
              {shares.map((share, index) => (
                <Cell key={share.key} fill={seriesColor(index, shares.length)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* 中心总量。★ 用绝对定位叠在图上而不是 recharts 的 label —— 后者在
            容器缩放时会跟着变字号 */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] text-fg-faint">{t('usage.models.total')}</span>
          <span className="text-[15px] font-semibold tabular-nums text-fg">
            {formatCompactNumber(totalTokens, locale)}
          </span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-1.5 self-stretch">
        {shares.map((share, index) => (
          <li key={share.key} className="flex items-center gap-2 text-[11px]">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: seriesColor(index, shares.length) }}
            />
            <span className="min-w-0 flex-1 truncate text-fg" title={labelOf(share)}>
              {labelOf(share)}
            </span>
            <span className="shrink-0 tabular-nums text-fg-muted">
              {formatCompactNumber(share.tokens, locale)}
            </span>
            <span className="w-11 shrink-0 text-right tabular-nums text-fg-faint">
              {formatPercent(share.share, locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
