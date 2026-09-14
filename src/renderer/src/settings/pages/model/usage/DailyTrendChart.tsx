/**
 * 每日 Token 趋势(参考图第二张)。
 *
 * ★ 配色一律传 `var(--color-*)` 字符串。recharts 把 `stroke` / `fill` 原样落成
 * SVG 属性,浏览器自己解析变量 —— 所以切主题时颜色自动跟着走,不需要
 * `getComputedStyle`,也不需要订阅主题变化。改成在 JS 里算色值就得自己订阅,
 * 而漏订阅的表现是「切主题后图表颜色不动」,只有肉眼能发现。
 *
 * ★ 默认的 `<Tooltip>` 背景是写死的白色,深色主题下是一块刺眼的白斑。
 * 所以这里给 `content` 传自定义节点 —— 不是为了好看,是为了它在深色下能读。
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useI18n, type Locale, type Translate } from '../../../../i18n'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { formatCompactNumber, formatDayLong, formatDayShort, formatNumber } from '../usage-format'
import type { DayTotal } from '../usage-overview'

interface Point {
  day: string
  tokens: number
  requests: number
}

function TrendTooltip({
  active,
  payload,
  locale,
  t
}: {
  active?: boolean
  payload?: { payload: Point }[]
  locale: Locale
  t: Translate
}): React.ReactNode {
  if (active !== true || payload === undefined || payload.length === 0) return null
  const point = payload[0]!.payload
  return (
    <div className="rounded-[10px] border border-border bg-surface-raised px-2.5 py-1.5 shadow-lg">
      <p className="text-[11px] text-fg">{formatDayLong(point.day, locale)}</p>
      <p className="mt-0.5 text-[10.5px] tabular-nums text-fg-muted">
        {t('usage.activity.tooltip', {
          tokens: formatCompactNumber(point.tokens, locale),
          turns: formatNumber(point.requests, locale)
        })}
      </p>
    </div>
  )
}

export function DailyTrendChart({ totals }: { totals: readonly DayTotal[] }): React.ReactNode {
  const { t, locale } = useI18n()

  if (totals.length === 0) return <EmptyState title={t('usage.trend.empty')} />

  const data: Point[] = totals.map((total) => ({
    day: total.day,
    tokens: total.tokens,
    requests: total.requests
  }))

  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="usageTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={(day: string) => formatDayShort(day, locale)}
            tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            width={44}
            tickFormatter={(value: number) => formatCompactNumber(value, locale)}
            tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ stroke: 'var(--color-border)' }}
            content={<TrendTooltip locale={locale} t={t} />}
          />
          <Area
            type="monotone"
            dataKey="tokens"
            stroke="var(--color-accent)"
            strokeWidth={1.8}
            fill="url(#usageTrendFill)"
            // 每日一个点、53 周就是 371 个点 —— 画出来是一条毛毛虫
            dot={false}
            activeDot={{ r: 3, fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
