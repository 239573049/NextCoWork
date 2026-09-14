/**
 * 概览区的装配层 —— 拉数据、管状态,图表本身一概不画。
 *
 * ## 为什么拉两次
 *
 * 热力图固定看最近 53 周,和顶部的时间范围**不联动**(范围选「近 24 小时」时
 * 一张只有一格的热力图毫无意义)。其余四块图跟随范围。所以:
 *
 * - `allBuckets`:全历史,喂热力图
 * - `buckets`:窗口内,喂指标卡 / 趋势图 / 环形图 / 费用表
 *
 * 窗口那份**不是**在前端从全量里切出来的。窗口边界是毫秒,而桶的 `day` 是本地
 * 日期字符串,在前端切就等于把主进程的分桶口径再实现一遍 —— 两处实现一旦有出入,
 * 同一天的数字会在概览和日志表之间对不上。让主进程切,前端只负责画。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  UsageActivityStats,
  UsageDailyBucket,
  UsageWindow
} from '../../../../../../shared/domain/usage'
import { localDayOf } from '../../../../../../shared/domain/usage-activity'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Segmented } from '../../../../components/ui/Segmented'
import { useI18n } from '../../../../i18n'
import { getUsageActivityStats, getUsageDailySeries } from '../../../../services/usage'
import { formatCompactNumber } from '../usage-format'
import {
  applyGranularity,
  buildHeatmap,
  fillDayGaps,
  toCostBreakdown,
  toDayTotals,
  toModelShares,
  totalsOf,
  type UsageGranularity
} from '../usage-overview'
import { ActivityHeatmap } from './ActivityHeatmap'
import { CostByModel } from './CostByModel'
import { DailyTrendChart } from './DailyTrendChart'
import { ModelUsageDonut } from './ModelUsageDonut'
import { OverviewCards } from './OverviewCards'

const GRANULARITIES: readonly UsageGranularity[] = ['daily', 'weekly', 'cumulative']

function Panel({
  title,
  actions,
  children
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section className="min-w-0 rounded-[18px] bg-surface p-4">
      <header className="mb-3 flex min-h-7 items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium text-fg">{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  )
}

export function UsageOverview({ usageWindow }: { usageWindow: UsageWindow }): React.ReactNode {
  const { t, locale } = useI18n()
  const [buckets, setBuckets] = useState<UsageDailyBucket[]>([])
  const [allBuckets, setAllBuckets] = useState<UsageDailyBucket[]>([])
  const [activity, setActivity] = useState<UsageActivityStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [granularity, setGranularity] = useState<UsageGranularity>('daily')

  useEffect(() => {
    let active = true
    setLoading(true)
    void Promise.all([
      getUsageDailySeries(usageWindow),
      getUsageDailySeries({ to: usageWindow.to }),
      getUsageActivityStats()
    ])
      .then(([windowed, all, stats]) => {
        if (!active) return
        setBuckets(windowed)
        setAllBuckets(all)
        setActivity(stats)
      })
      .catch((error: unknown) => {
        if (!active) return
        console.error('[usage] failed to load overview series', error)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [usageWindow])

  const totals = useMemo(() => totalsOf(buckets), [buckets])
  const shares = useMemo(() => toModelShares(buckets), [buckets])
  const costs = useMemo(() => toCostBreakdown(buckets), [buckets])

  // 趋势图先补空洞再按粒度再聚合:没有用量的日子必须是一个 0 点,否则折线会从
  // 前一天直接斜到后一天,把「歇了三天」画成「缓慢下降」。
  const trend = useMemo(() => {
    const days = toDayTotals(buckets)
    if (days.length === 0) return []
    const filled = fillDayGaps(days, days[0]!.day, days[days.length - 1]!.day)
    return applyGranularity(filled, granularity)
  }, [buckets, granularity])

  const heatmap = useMemo(
    () => buildHeatmap(toDayTotals(allBuckets), localDayOf(usageWindow.to - 1)),
    [allBuckets, usageWindow.to]
  )

  const empty = !loading && buckets.length === 0

  return (
    <div className="space-y-3">
      <OverviewCards totals={totals} activity={activity} loading={loading} />

      <Panel
        title={t('usage.activity.title')}
        actions={
          <Segmented
            value={granularity}
            options={GRANULARITIES.map((item) => ({
              value: item,
              label: t(`usage.granularity.${item}` as never)
            }))}
            onChange={setGranularity}
            size="sm"
            shape="pill"
            label={t('usage.granularityLabel')}
          />
        }
      >
        <ActivityHeatmap grid={heatmap} />
      </Panel>

      {empty ? (
        <Panel title={t('usage.overview.title')}>
          <EmptyState title={t('usage.overview.empty')} />
        </Panel>
      ) : (
        <>
          <Panel
            title={t('usage.trend.title')}
            actions={
              <span className="text-[10.5px] tabular-nums text-fg-faint">
                {formatCompactNumber(totals.tokens, locale)}
              </span>
            }
          >
            <DailyTrendChart totals={trend} />
          </Panel>

          <div className="grid gap-3 min-[900px]:grid-cols-2">
            <Panel title={t('usage.models.title')}>
              <ModelUsageDonut shares={shares} totalTokens={totals.tokens} />
            </Panel>
            <Panel title={t('usage.cost.title')}>
              <CostByModel breakdown={costs} />
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
