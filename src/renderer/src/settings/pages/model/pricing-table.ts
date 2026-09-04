/**
 * 「定价配置」那张表的取数与格式化。
 *
 * ★ **抽成 `.ts` 是为了能被执行**(同 `tabs.ts`):`vitest.config.ts` 是 node 环境、
 * `include` 只收 `.test.ts`,写在 `.tsx` 里的判断一行都不会跑。而下面每个函数
 * 都在决定**屏幕上那个数字长什么样**,其中两处的错法是静默的:
 *
 * - `formatRate` 把「没有这项费率」显示成 `0` —— 那是「免费」,不是「不知道」。
 *   `pricing-seed.test.ts` 花了一整条断言禁止 0 进种子表,显示层再把 undefined
 *   变回 0,那条断言就白写了。
 * - `tierLabel` 把档位边界标错 —— 数字全对、归属错了,而阶梯是**整单重定价**
 *   (`pricing.ts` §4.2),读者照着标签去核对只会更确信。
 */
import type {
  Currency,
  ModelPricing,
  PriceTier,
  PriceWindow
} from '../../../../../shared/domain/pricing'
import { findPreset } from '../../../../../shared/domain/presets'

const SYMBOL: Readonly<Record<Currency, string>> = { USD: '$', CNY: '¥' }

/**
 * 每百万 token 的费率。
 *
 * ★ **`undefined` 一律 `—`,永远不写 0。** 这张表里 `cacheWrite` 缺省是常态
 * (DeepSeek 没有缓存写入费这一项),而 0 会被读成「写缓存不要钱」——
 * `priceOf` 在这种请求上返回的是 null(整条无定价),两者差着天。
 * 这条和 `format.ts` 的 `formatBytes(undefined) === '—'` 是同一个约定。
 *
 * 小数位:至少两位、最多四位、去掉尾零。种子表里 $0.075(GLM 促销价)和
 * $3(Fable 5.1 输入价)要同时能读,固定两位会把前者截成 $0.08 —— 差 7%。
 */
export function formatRate(v: number | undefined, currency: Currency): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  const [int, frac = ''] = v.toFixed(4).split('.')
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0')
  return `${SYMBOL[currency]}${int}.${trimmed}`
}

/** 272000 → `272K`。档位边界只有 200K / 272K 两种量级,不做通用单位换算 */
export function compactTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`
  return String(n)
}

/**
 * 第 `i` 档在界面上的名字。单档返回空串 —— 单档模型不该有「第 1 档」这种噪音。
 *
 * ★ 末档的标签由**前一档的上界**推出(`>272K`),因为末档自己的 `upToInputTokens`
 * 恒为 null(种子表有断言守着)。读前一档而不是硬写一个数,是为了让阈值只存在一处。
 */
export function tierLabel(tiers: readonly PriceTier[], i: number): string {
  if (tiers.length <= 1) return ''
  const bound = tiers[i]?.upToInputTokens
  if (bound !== null && bound !== undefined) return `≤${compactTokens(bound)}`
  const prev = tiers[i - 1]?.upToInputTokens
  return prev === null || prev === undefined ? '其余' : `>${compactTokens(prev)}`
}

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export interface PricingDaysParts {
  kind: 'all' | 'list' | 'range'
  days: readonly number[]
}

export function describeDaysParts(days: readonly number[] | undefined): PricingDaysParts {
  if (days === undefined || days.length === 0) return { kind: 'all', days: [] }
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  if (sorted.length === 7) return { kind: 'all', days: sorted }
  const contiguous = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] as number) + 1)
  return { kind: contiguous && sorted.length > 2 ? 'range' : 'list', days: sorted }
}

/**
 * `daysOfWeek` 的人话。**省略 = 每天**,不是「没有」——
 * 这个字段的默认值本身就是 `pricing.ts` 里点名过的坑(漏了它周六会按高峰价算)。
 */
export function describeDays(days: readonly number[] | undefined): string {
  const parts = describeDaysParts(days)
  if (parts.kind === 'all') return '每天'
  const names = parts.days.map((d) => DAY_NAMES[d] ?? `周${d}`)
  return parts.kind === 'range' ? `${names[0]} 至 ${names[names.length - 1]}` : names.join('、')
}

export interface PricingWindowParts {
  label: string
  days: PricingDaysParts
  start: string
  end: string
  timezone: string
  detail: 'rates' | 'multiplier' | 'none'
  multiplier?: number
}

export function describeWindowParts(w: PriceWindow): PricingWindowParts {
  return {
    label: w.label,
    days: describeDaysParts(w.daysOfWeek),
    start: w.start,
    end: w.end,
    timezone: w.timezone,
    detail: w.rates !== undefined ? 'rates' : w.multiplier !== undefined ? 'multiplier' : 'none',
    multiplier: w.multiplier
  }
}

/**
 * 一条时段规则的整行说明。
 *
 * ★ **时区名照原样写出来,不换算到用户本机。** `inWindow` 判断用的就是
 * `w.timezone`(`pricing.ts` 那条注释:「必须换算到**这个**时区,不是用户本机时区」),
 * 显示时替用户换算成本地时间会让界面和实际计费规则对不上 ——
 * 而对不上的时候,用户信的是界面。
 */
export function describeWindow(w: PriceWindow): string {
  const parts = describeWindowParts(w)
  const when = `${describeDays(w.daysOfWeek)} ${parts.start}–${parts.end} ${parts.timezone}`
  // `rates` 赢 —— 和 `priceOf` 的优先级一致(整套覆盖比一个标量更具体)
  if (parts.detail === 'rates') return `${parts.label} · ${when} · 整套费率覆盖`
  if (parts.detail === 'multiplier') return `${parts.label} · ${when} · ×${parts.multiplier}`
  return `${parts.label} · ${when}`
}

export interface PricingEffectiveParts {
  from?: string
  until?: string
}

export function describeEffectiveParts(p: ModelPricing): PricingEffectiveParts | null {
  const { effectiveFrom: from, effectiveUntil: until } = p
  return from === undefined && until === undefined ? null : { from, until }
}

/**
 * 生效区间那句小字。**两个都省略 = 永远生效,返回空串**(不写「长期有效」——
 * 那是句废话,73 行里 71 行都会顶着它)。
 *
 * ★ 有区间的行必须把它显示出来:`glm-5.3-flash` 在表里是**两行**
 * (促销价与到期后的原价),不写日期的话就是同名同厂商、价格却差一倍的两行,
 * 读者只会当成数据错了。
 */
export function describeEffective(p: ModelPricing): string {
  const parts = describeEffectiveParts(p)
  if (parts === null) return ''
  const { from, until } = parts
  if (from !== undefined && until !== undefined) return `${from} 至 ${until} 生效`
  return from !== undefined ? `${from} 起生效` : `${until} 前有效`
}

export interface PricingGroup {
  key: string
  title: string
  /** 组下那句小字。通用价和覆盖价的查找语义不同。 */
  hint: string
  rows: readonly ModelPricing[]
}

/**
 * 分组:通用基础定价一组,每个 `providerId` 各一组。
 *
 * ★★ **刻意不按「厂商」分组,因为这张表里没有厂商这个字段。**
 * 试过的两条路都会静默出错:
 *
 * - 按 `source` 的主机名分 —— Gemini 与 xAI 的 source **都是** LiteLLM 那份
 *   价目 JSON(`cdn.jsdelivr.net`),两家会被并成一组。
 * - 按 `modelId` 前缀猜(`claude-` / `gpt-`)—— 新厂商加进来时不报错,
 *   只是悄悄落进「其他」。
 *
 * 而 `providerId` 是**真字段**,还正好是 `findPricing` 的查找键之一,
 * 分组轴和查找轴一致,读者看到的分组就是运行时实际的匹配顺序。
 * 至于「同一厂商的模型挨在一起」——`PRICING_SEED` 的数组顺序本身就是按厂商聚簇的
 * (那边文件头写明了「顺序 = 界面默认顺序」),这里**保持原序**即可,不用再推一次。
 */
export function groupPricing(rows: readonly ModelPricing[]): PricingGroup[] {
  const generic = rows.filter((p) => p.providerId === null)
  const out: PricingGroup[] = []
  if (generic.length > 0) {
    out.push({
      key: '*',
      title: '通用基础定价',
      hint: '没有配到具体供应商时用这一档。查价顺序是「先找该供应商的覆盖价,没有才回落到这里」。',
      rows: generic
    })
  }
  const seen = new Set<string>()
  for (const p of rows) {
    if (p.providerId === null || seen.has(p.providerId)) continue
    seen.add(p.providerId)
    const id = p.providerId
    out.push({
      key: id,
      title: findPreset(id)?.name ?? id,
      hint: `只对 ${id} 这家生效,盖过上面的通用价。同一个模型在不同平台是不同的价,这是覆盖价存在的理由。`,
      rows: rows.filter((r) => r.providerId === id)
    })
  }
  return out
}

/**
 * 搜索框。**空查询返回全表**(和 `matchRows` 的「空查询返回空」相反)——
 * 那边空查询意味着「用户没在搜」,该显示正常页面;这里表本身就是页面内容。
 */
export function matchPricing(rows: readonly ModelPricing[], query: string): ModelPricing[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  return rows.filter(
    (p) =>
      p.modelId.toLowerCase().includes(q) ||
      p.displayName.toLowerCase().includes(q) ||
      (p.providerId ?? '').toLowerCase().includes(q)
  )
}
