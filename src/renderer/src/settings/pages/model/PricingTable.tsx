import { ExternalLink, Search } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Currency, ModelPricing } from '../../../../../shared/domain/pricing'
import { PRICING_SEED } from '../../../../../shared/domain/pricing-seed'
import { findPreset } from '../../../../../shared/domain/presets'
import { EmptyState } from '../../../components/ui/EmptyState'
import { TextInput } from '../../../components/ui/TextInput'
import { cn } from '../../../lib/cn'
import { openExternal } from '../../../services/app'
import { SettingGroup, TodoRow } from '../../Row'
import {
  describeEffectiveParts,
  describeWindowParts,
  formatRate,
  groupPricing,
  matchPricing,
  tierLabel
} from './pricing-table'
import { useI18n } from '../../../i18n'

/**
 * 「模型定价」表 —— 方案 §4 的种子表在界面上的样子。
 *
 * ★ **这一页现在是只读的,而且是唯一一段不靠 IPC 就能真跑起来的内容。**
 * `PRICING_SEED` 是 `src/shared/` 下的纯数据,渲染层直接 import 得到 ——
 * 供应商那一整套要等 `provider:*` 的写入面(步骤 4),这张表不用等。
 * 手工覆盖要等 `pricing:upsert`,所以顶上留了一条 `TodoRow` 说清楚缺的是写入。
 *
 * ★★ **每一行都带来源链接和录入日期,这不是装饰。**`pricing.ts` 那句
 * 「价格会过期,但不会静默错」就落在这里:表里的数字迟早会旧,而用户点一下
 * 就能去官方页核对。没有这一列,一张过期的价目表和一张正确的长得一模一样。
 *
 * 布局沿用设置浮层已经量准的那套(13px 标题 / 12px `fg-muted` 描述 /
 * `border-hairline` 分隔),**没有新造间距体系** —— 这一页没有参考截图可量。
 */
export function PricingTable(): ReactNode {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupPricing(matchPricing(PRICING_SEED, query)), [query])

  return (
    <>
      <SettingGroup title={t('models.pricingTitle')}>
        <div className="flex items-center gap-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-fg">{t('models.pricingBuiltIn')}</p>
            <p className="mt-1 text-[12px] leading-[1.5] text-fg-muted">
              {t('models.pricingSummary', { count: PRICING_SEED.length })}，{fetchedLabel(t)}。{t('models.pricingSnapshotHint')}
              <span className="text-fg">{t('models.pricingFinalBilling')}</span>。{t('models.pricingCurrencyHint')}
            </p>
          </div>
          <div className="w-[220px] shrink-0">
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder={t('models.pricingSearch')}
              ariaLabel={t('models.pricingSearchLabel')}
              icon={<Search size={13} className="text-icon" />}
            />
          </div>
        </div>
        <TodoRow
          title={t('models.pricingManualTitle')}
          description={t('models.pricingManualHint')}
          step={t('models.pricingStep')}
        />
        <TodoRow
          title={t('models.pricingUnknownTitle')}
          description={t('models.pricingUnknownHint')}
          step={t('models.usageLogsStep')}
          last
        />
      </SettingGroup>

      {groups.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<Search size={22} />}
          title={t('models.pricingNoMatch')}
          hint={t('models.pricingNoMatchHint', { query: query.trim(), count: PRICING_SEED.length })}
        />
      ) : (
        groups.map((g) => (
          <section key={g.key} className="pt-5">
            <h4 className="px-1 text-[12.5px] text-fg">
              {g.key === '*' ? t('models.pricingGroupGeneric') : findPreset(g.key)?.name ?? g.key}
            </h4>
            <p className="mt-1 px-1 text-[12px] leading-[1.5] text-fg-muted">
              {g.key === '*'
                ? t('models.pricingGroupGenericHint')
                : t('models.pricingGroupProviderHint', { provider: findPreset(g.key)?.name ?? g.key })}
            </p>
            <PriceRows rows={g.rows} t={t} />
          </section>
        ))
      )}
    </>
  )
}

/** 全表的采集日期。种子表的测试保证它一致,不一致时**说出来**而不是挑一个显示 */
function fetchedLabel(t: ReturnType<typeof useI18n>['t']): string {
  const dates = [...new Set(PRICING_SEED.map((p) => p.fetchedAt))]
  return dates.length === 1
    ? t('models.pricingFetchedAt', { date: dates[0]! })
    : t('models.pricingFetchedInconsistent', { count: dates.length })
}

const HEAD = [
  'models.columns.input',
  'models.columns.output',
  'models.pricingHeaderCacheRead',
  'models.pricingHeaderCacheWrite5m',
  'models.pricingHeaderCacheWrite1h'
] as const

function PriceRows({ rows, t }: { rows: readonly ModelPricing[]; t: ReturnType<typeof useI18n>['t'] }): ReactNode {
  return (
    <table className="mt-2 w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-hairline text-fg-faint">
          <th className="py-2 pl-1 text-left font-normal">{t('models.columns.model')}</th>
          <th className="w-[68px] py-2 text-left font-normal">{t('models.pricingHeaderTier')}</th>
          {HEAD.map((h) => (
            <th key={h} className="w-[76px] py-2 pr-1 text-right font-normal">
              {t(h)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) =>
          p.tiers.map((tier, i) => (
            <tr
              key={`${p.modelId}@${p.effectiveFrom ?? ''}#${i}`}
              className={cn(i === p.tiers.length - 1 && 'border-b border-hairline')}
            >
              {i === 0 && (
                <td className="py-2.5 pr-4 pl-1 align-top" rowSpan={p.tiers.length}>
                  <ModelCell p={p} />
                </td>
              )}
              <td className="py-2.5 align-top text-fg-muted">{tierLabel(p.tiers, i) || t('models.pricingNotApplicable')}</td>
              {rateCells(p.currency).map(({ key, pick }) => (
                <td key={key} className="py-2.5 pr-1 text-right align-top tabular-nums text-fg">
                  {pick(tier.rate)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

/**
 * ★ 五列的取值顺序必须和 `HEAD` 一一对应。写成一张表而不是五段 JSX,
 * 是为了让「多一列少一列」在类型上就对不齐,而不是靠肉眼数。
 */
function rateCells(
  currency: Currency
): { key: string; pick: (r: ModelPricing['tiers'][number]['rate']) => string }[] {
  const f = (v: number | undefined): string => formatRate(v, currency)
  return [
    { key: 'input', pick: (r) => f(r.input) },
    { key: 'output', pick: (r) => f(r.output) },
    { key: 'cacheRead', pick: (r) => f(r.cacheRead) },
    { key: 'cacheWrite', pick: (r) => f(r.cacheWrite) },
    { key: 'cacheWrite1h', pick: (r) => f(r.cacheWrite1h) }
  ]
}

function ModelCell({ p }: { p: ModelPricing }): ReactNode {
  const { t } = useI18n()
  const effectiveParts = describeEffectiveParts(p)
  const host = hostOf(p.source)
  return (
    <>
      <p className="text-[12.5px] text-fg">{p.displayName}</p>
      <p className="mt-0.5 font-mono text-[11.5px] text-fg-muted">{p.modelId}</p>
      {effectiveParts !== null && (
        <p className="mt-1 text-[11.5px] text-fg-faint">{formatEffective(effectiveParts, t)}</p>
      )}
      {/*
        ★ 时段计费逐条写出来,包括星期和时区。`inWindow` 判断用的就是 `w.timezone`,
        这里替用户换算成本机时间会让界面和实际计费规则对不上 —— 而对不上的时候,
        用户信的是界面。
      */}
      {p.windows?.map((w) => (
        <p key={w.label + w.start} className="mt-1 text-[11.5px] text-fg-faint">
          {formatWindow(describeWindowParts(w), t)}
        </p>
      ))}
      <button
        type="button"
        onClick={() => void openExternal(p.source)}
        title={p.source}
        className={cn(
          'app-no-drag mt-1.5 inline-flex items-center gap-1 rounded-[5px] px-1 py-0.5',
          '-ml-1 text-[11.5px] text-fg-faint hover:bg-tint-hover hover:text-fg-muted'
        )}
      >
        {host}
        <ExternalLink size={10} />
      </button>
    </>
  )
}

function formatEffective(
  parts: NonNullable<ReturnType<typeof describeEffectiveParts>>,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (parts.from !== undefined && parts.until !== undefined) return t('models.pricingEffectiveRange', { from: parts.from, until: parts.until })
  if (parts.from !== undefined) return t('models.pricingEffectiveFrom', { from: parts.from })
  return t('models.pricingEffectiveUntil', { until: parts.until ?? '' })
}

function formatWindow(
  parts: ReturnType<typeof describeWindowParts>,
  t: ReturnType<typeof useI18n>['t']
): string {
  const dayNames = parts.days.days.map((day) => t('models.pricingDay', { day }))
  const days = parts.days.kind === 'all'
    ? t('models.pricingEveryDay')
    : parts.days.kind === 'range'
      ? t('models.pricingDayRange', { from: dayNames[0] ?? '', to: dayNames[dayNames.length - 1] ?? '' })
      : dayNames.join(t('models.pricingDayListSeparator'))
  const detail = parts.detail === 'rates'
    ? t('models.pricingWindowRates')
    : parts.detail === 'multiplier'
      ? t('models.pricingWindowMultiplier', { value: parts.multiplier ?? '' })
      : null
  return [parts.label, `${days} ${parts.start}–${parts.end} ${parts.timezone}`, detail].filter(Boolean).join(' · ')
}

/** 来源主机名。解析不了就原样显示 —— 种子表的测试保证它是 https URL,这里只是不炸 */
function hostOf(source: string): string {
  try {
    return new URL(source).hostname
  } catch {
    return source
  }
}
