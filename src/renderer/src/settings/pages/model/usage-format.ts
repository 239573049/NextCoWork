/**
 * 使用统计的格式化。从 `UsageTab.tsx` 抽出来 —— 这些函数原先埋在 .tsx 里,
 * **一条测试都没有**,而它们决定了页面上每一个数字长什么样。
 *
 * vitest 是 `environment: 'node'` + `include: ['src/**\/*.test.ts']`,`.test.tsx`
 * 根本不会被收。所以仓库的既定结构就是「`.tsx` 负责标记,同名 `.ts` 负责逻辑」
 * (`pricing-table.ts` / `tabs.ts` / `enabled-models.ts` 都是这个形状),纯函数
 * 放这里才测得到。
 *
 * 一律走 `Intl`,不手搓。zh-CN 下 compact 记法自动出「4109万」,与参考图一致;
 * 手写的 K/M/B 在中文界面上是错的。
 */
import type { Locale, Translate } from '../../../i18n'
import type { UsageWindow } from '../../../../../shared/domain/usage'

export type UsageRange = '24h' | '7d' | '30d' | 'all'

export const USAGE_RANGES: readonly UsageRange[] = ['24h', '7d', '30d', 'all']

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * 范围 → 查询时间窗。
 *
 * ★ 上界取 `now + 1` 而不是 `now`:`UsageWindow` 的上界是**开区间**
 * (`at < to`),取 `now` 会漏掉恰好落在这一毫秒的记录。刚发完一条请求就刷新
 * 统计页时,那条会看不见 —— 而下一次刷新它又出现了,像是数据在闪。
 */
export function windowFor(range: UsageRange, now: number = Date.now()): UsageWindow {
  const to = now + 1
  const duration =
    range === '24h' ? 24 * HOUR : range === '7d' ? 7 * DAY : range === '30d' ? 30 * DAY : null
  return duration === null ? { to } : { from: to - duration, to }
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** 紧凑记法。zh-CN 出「4109万」,en-US 出「41M」—— 这正是不手写单位的理由。 */
export function formatCompactNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0
  }).format(value)
}

export function formatPercent(value: number | null, locale: Locale): string {
  if (value === null) return '—'
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

/**
 * 单一币种金额。micros → 主单位。
 *
 * ★ 小于 1 分的金额放宽到 6 位小数。单次请求常常是 0.0003 美元,按 2 位显示
 * 全是「$0.00」—— 一页的 0.00 加起来却是真金白银,这种表格看着像坏了。
 */
export function formatCostMicros(micros: number, currency: string, locale: Locale): string {
  const value = micros / 1_000_000
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2
  }).format(value)
}

/**
 * 多币种金额。★ 用 `+` 连接而**不是**相加:美元和人民币加起来的那个数字
 * 没有单位,比不显示更糟。
 */
export function formatCosts(
  values: readonly { currency: string; micros: number }[],
  locale: Locale
): string {
  if (values.length === 0) return '—'
  return values.map(({ currency, micros }) => formatCostMicros(micros, currency, locale)).join(' + ')
}

export function formatLatency(value: number | null, locale: Locale, t: Translate): string {
  if (value === null) return '—'
  if (value >= 1000) {
    return t('usage.seconds', {
      value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1000)
    })
  }
  return t('usage.milliseconds', { value: formatNumber(Math.round(value), locale) })
}

/**
 * 时长(最长聊天时长那张卡)。取「小时+分」或「分+秒」两档,不显示三级。
 *
 * ★ 不满一分钟时显示秒而不是「0 分钟」。真有过只发一句就关掉的会话,
 * 而「最长聊天 0 分钟」读起来像功能坏了。
 */
export function formatDuration(ms: number, locale: Locale, t: Translate): string {
  if (ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return t('usage.duration.hm', {
      hours: formatNumber(hours, locale),
      minutes: formatNumber(minutes, locale)
    })
  }
  if (totalMinutes > 0) return t('usage.duration.m', { minutes: formatNumber(totalMinutes, locale) })
  return t('usage.duration.s', { seconds: formatNumber(Math.max(1, Math.round(ms / 1000)), locale) })
}

/**
 * `YYYY-MM-DD` → 完整日期,用于热力图 tooltip(参考图的「2026年9月14日」)。
 *
 * ★ 按 **UTC** 解析并按 UTC 格式化。`new Date('2026-09-14')` 得到的是 UTC 午夜,
 * 若再按本地时区格式化,东八区以西的用户会看到前一天 —— 方块的日期和 tooltip
 * 的日期差一天,而两边各自看都像对的。
 */
export function formatDayLong(day: string, locale: Locale): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

/** `YYYY-MM-DD` → 短日期,用于趋势图横轴。同样按 UTC 解析(理由见 `formatDayLong`)。 */
export function formatDayShort(day: string, locale: Locale): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}
