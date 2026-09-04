/**
 * 定价模型与计价纯函数 —— 方案 §4。
 *
 * **计价是纯函数,时间是显式参数。** `at` 由调用方给(写入侧取 `host.clock.now()`),
 * 这样时段计价能在测试里冻结时间,不必 mock 全局 `Date`。
 *
 * 金额一律用 **micros(整数)** 表达,理由是 `SUM()` 里的浮点会漂。
 *
 * ★ 本文件里没有任何厂商数据 —— 数据在 `pricing-seed.ts`。分开是因为
 * 数字会过期、规则不会。
 */
import type { TokenUsage } from '../agent/stream'

export type Currency = 'USD' | 'CNY'

/**
 * 模态。顶部 Tab 需要它。
 *
 * ★ 使用统计**不在这里** —— 它是另一种视图,不是一种模态。混进来的话
 * 「按模态过滤定价表」这类地方就得到处特判它。
 */
export type Modality = 'text' | 'image' | 'video' | 'speech' | 'transcription'

/**
 * 一整套费率。**存绝对数字,不存倍率。**
 *
 * 「缓存读 = 输入的 0.1 倍」这条经验规律有真实的例外:Fable 5.1 / Mythos 5.1
 * 的缓存读是 $0.25(0.025×),而上一代 Fable 5 / Mythos 5 是 $1.00。
 * 用公式生成种子表会把这两行都算错。
 */
export interface TokenRates {
  /** 每百万 token,币种见 `ModelPricing.currency` */
  input: number
  output: number
  /**
   * 缓存命中的输入价。国内几家把它叫「输入(缓存命中)」,
   * 而它们的「缓存未命中」就是上面那个 `input` —— 形状是对得上的。
   */
  cacheRead?: number
  /** 5 分钟档缓存写入价 */
  cacheWrite?: number
  /** 1 小时档缓存写入价(Anthropic 是 5m 的两倍) */
  cacheWrite1h?: number
  /** 生图类按次计费。图像 Tab 本轮是占位,字段先定形状 */
  perCall?: number
}

export interface PriceTier {
  /** 该档上界(含);最后一档为 null = 无上界 */
  upToInputTokens: number | null
  rate: TokenRates
}

/**
 * 偏离基准价的时段。
 *
 * ★ **语义定死:`tiers` 里是基准价,`windows` 描述的是偏离。**
 * 录入时基准价录**便宜**的那一档(见 `pricing-seed.ts` 文件头的论证)。
 */
export interface PriceWindow {
  /** IANA 时区名。★ 判断时段必须换算到**这个**时区,不是用户本机时区 */
  timezone: string
  /**
   * ★★ **星期几生效。0=周日…6=周六。省略 = 每天。**
   *
   * 这是第一版漏掉的字段:DeepSeek 的高峰时段只在**周一至周五**,
   * 没有它的话「周六凌晨 2 点」会被算成高峰价 —— 贵一倍,而且没人会发现。
   */
  daysOfWeek?: readonly number[]
  /** 'HH:mm',**含** */
  start: string
  /** 'HH:mm',**不含**。允许 start > end 表示跨午夜 */
  end: string
  /** 与 `rates` 二选一;两个都给时 `rates` 赢(整套覆盖比一个标量更具体) */
  multiplier?: number
  rates?: TokenRates
  label: string
}

export interface ModelPricing {
  /** null = 通用基础定价(种子表);非 null = 该供应商的覆盖价 */
  providerId: string | null
  /** ★ 上游真实模型名,**不是别名** —— 抄错了就是永远命不中定价 */
  modelId: string
  displayName: string
  currency: Currency
  modality: Modality
  /** 至少一条;多于一条即阶梯 */
  tiers: readonly PriceTier[]
  windows?: readonly PriceWindow[]
  /**
   * 生效日期区间(YYYY-MM-DD,含)。**厂商会预告调价** —— Gemini 的 Flash 系列
   * 明确写着「2026-12-31 前是导入期价,2027-01-01 起翻一倍」。同一个 modelId
   * 存两行、日期区间不重叠,查找时按 `at` 落在哪一行选。
   *
   * 不做这个的话,2027-01-01 那天起所有 Gemini 的费用会**静默偏低一半**。
   * 两个都省略 = 永远生效。
   */
  effectiveFrom?: string
  effectiveUntil?: string
  /** ★ 官方定价页 URL + 抓取日期,界面直接显示 —— 价格会过期,但不会静默错 */
  source: string
  /** YYYY-MM-DD */
  fetchedAt: string
}

export interface PriceResult {
  micros: number
  currency: Currency
  /** 命中的档位下标,写进 `UsageRecord.pricingTier` 供事后对账 */
  tier: number
  /** 命中的时段 label,没命中就没有这个字段 */
  window?: string
}

/**
 * ★★★ **本文件最容易写错的一处,写在函数上面而不是藏在实现里。**
 *
 * 「阶梯」在中文和英文里都会让人想到个人所得税那种**分段累加**。厂商不是这么算的:
 * 越过阈值,**整个请求的每一个 token** 都按高档价重算。
 *
 * 两家厂商各自的原话(不同语言、彼此独立,所以这是交叉验证不是复述):
 *
 * > xAI:*"Models with long context pricing bill the long context rates for
 * > **all tokens in a request** once its prompt reaches the model's long
 * > context threshold."*
 *
 * > 阿里云百炼:「阶梯计费规则:百炼部分模型实行阶梯计费。单价取决于单次请求的
 * > 输入 Token 总量。**该请求的所有 Token 均按对应阶梯的单价结算。**」
 * > 该页还给了算例:qwen3-max 输入 40K(落在 32K–128K 档)时,**全部 40K**
 * > 按该档的 ¥4/M 结算,不是 32K 按第一档 + 8K 按第二档。
 *
 * 写成累进会让长上下文请求的费用**系统性偏低** —— 而且低得不多、不扎眼。
 * 所以这个函数里只出现**一次**档位选择,之后全用选中那一档的 `rate`。
 */
export function priceOf(p: ModelPricing, usage: TokenUsage, at: number): PriceResult | null {
  // ★ 只在这里选一次档。选两次就给了「输入用高档、输出用低档」这类错留门。
  const tierIndex = selectTier(p.tiers, billableInputTokens(usage))
  const tier = p.tiers[tierIndex]
  if (tier === undefined) return null // tiers 为空 —— 结构测试会先拦下,这里只是不装作能算

  const window = activeWindow(p.windows, at)
  const micros = costMicros(effectiveRate(tier.rate, window), usage)
  if (micros === null) return null

  return {
    micros,
    currency: p.currency,
    tier: tierIndex,
    ...(window === null ? {} : { window: window.label })
  }
}

/**
 * ★ 选档的分母是**输入侧的全部 token**,不只是新鲜输入。
 *
 * xAI 说得很明确:缓存 token 计入阈值判定,并且自己也按长上下文档的缓存价重算。
 * 缓存写入同理 —— 它一样是这次 prompt 的一部分。
 *
 * 推论是反直觉的:一个很大的缓存前缀在阈值附近是**负担**而不是优势,
 * 和「缓存能省钱」的直觉正好相反。
 */
function billableInputTokens(u: TokenUsage): number {
  return u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
}

/** 返回命中的档位下标。`upToInputTokens` 是**含**上界。 */
function selectTier(tiers: readonly PriceTier[], inputTokens: number): number {
  for (let i = 0; i < tiers.length; i++) {
    const up = tiers[i]?.upToInputTokens
    if (up === undefined) continue
    if (up === null || inputTokens <= up) return i
  }
  // 每一档都有上界且都没够着 —— 结构测试要求末档为 null,所以这里只会在
  // 种子表被改坏时到达。退到最后一档而不是抛,是因为计价不该让整条请求失败。
  return tiers.length - 1
}

function effectiveRate(base: TokenRates, w: PriceWindow | null): TokenRates {
  if (w === null) return base
  // 两个都给时整套覆盖赢 —— 它比一个标量更具体
  if (w.rates !== undefined) return w.rates
  if (w.multiplier === undefined) return base
  const m = w.multiplier
  return {
    input: base.input * m,
    output: base.output * m,
    ...(base.cacheRead === undefined ? {} : { cacheRead: base.cacheRead * m }),
    ...(base.cacheWrite === undefined ? {} : { cacheWrite: base.cacheWrite * m }),
    ...(base.cacheWrite1h === undefined ? {} : { cacheWrite1h: base.cacheWrite1h * m }),
    ...(base.perCall === undefined ? {} : { perCall: base.perCall * m })
  }
}

/**
 * 费率是「每百万 token」,金额是 micros(百万分之一货币单位)——
 * 两个百万**正好约掉**,所以这里是直接相乘,不是漏了一次换算。
 *
 * ★ 某一类 token 有数量、费率表里却没有对应的价时返回 **null**,而不是当 0 算。
 * 当 0 算的结果是一个看着很合理的、偏低的数字,没有任何人会发现;
 * 返回 null 会让界面显示「—」,而定价页顶部专门有一处列出这些 modelId。
 */
function costMicros(r: TokenRates, u: TokenUsage): number | null {
  const write1h = u.cacheCreation1hInputTokens ?? 0
  const write5m = Math.max(0, (u.cacheCreationInputTokens ?? 0) - write1h)
  const read = u.cacheReadInputTokens ?? 0

  let total = u.inputTokens * r.input + u.outputTokens * r.output

  if (read > 0) {
    if (r.cacheRead === undefined) return null
    total += read * r.cacheRead
  }
  if (write5m > 0) {
    if (r.cacheWrite === undefined) return null
    total += write5m * r.cacheWrite
  }
  if (write1h > 0) {
    // 刻意**不**退回 `cacheWrite`:1h 是 5m 的两倍价,退回去就是静默少收一半
    if (r.cacheWrite1h === undefined) return null
    total += write1h * r.cacheWrite1h
  }
  if (r.perCall !== undefined) total += r.perCall * 1_000_000

  return Math.round(total)
}

// ─── 时段判定(方案 §4.3) ───

/**
 * ★ 小时和星期**必须来自同一次时区换算**。
 *
 * 一个用目标时区、一个用本机时区是跨日边界上的经典错:
 * `2026-09-06T23:30Z` 是 UTC 的**周日**,但在 `Asia/Shanghai` 是**周一 07:30**。
 * 用 `formatToParts` 一次取全两样,这个错就结构性地不可能发生。
 *
 * 用 `hourCycle: 'h23'` 而不是 `hour12: false` 是**明确**,不是修 bug:
 * 实测本机 Node 24 的 ICU 下,两者在 en-US / ja-JP / de-DE / zh-CN 上都解析成
 * h23,午夜都是 "00"。`hour12: false` 按规范只承诺「某种 24 小时制」,
 * 而 h24 那一种把午夜写成 "24" —— 写死 h23 就不必依赖这个承诺的具体兑现方式。
 */
function zonedHourAndDay(timezone: string, at: number): { minutes: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(at))

  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? ''

  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    day: WEEKDAY[get('weekday')] ?? -1
  }
}

/** 固定用 en-US 取星期,所以这张表是够的 */
const WEEKDAY: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * 起点**含**、终点**不含**。DeepSeek 的「01:00 - 04:00」在恰好 04:00 那一刻
 * 算空闲 —— 标准读法,而且错的方向是少算(见 `pricing-seed.ts` 的论证)。
 */
export function inWindow(w: PriceWindow, at: number): boolean {
  const { minutes, day } = zonedHourAndDay(w.timezone, at)
  if (w.daysOfWeek !== undefined && !w.daysOfWeek.includes(day)) return false
  const start = toMinutes(w.start)
  const end = toMinutes(w.end)
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** 多段命中时取第一段 —— 种子表里同一模型的窗口互不重叠 */
function activeWindow(windows: readonly PriceWindow[] | undefined, at: number): PriceWindow | null {
  return windows?.find((w) => inWindow(w, at)) ?? null
}

// ─── 查表(方案 §4.1) ───

/** UTC 下的 YYYY-MM-DD。日期区间是厂商公告的调价日,按 UTC 比是够用的近似 */
const isoDate = (at: number): string => new Date(at).toISOString().slice(0, 10)

const effectiveAt = (p: ModelPricing, at: number): boolean => {
  const d = isoDate(at)
  if (p.effectiveFrom !== undefined && d < p.effectiveFrom) return false
  if (p.effectiveUntil !== undefined && d > p.effectiveUntil) return false
  return true
}

/**
 * 查找顺序:`(providerId, modelId)` → `(null, modelId)` → null。
 *
 * ★ 主键必须带 providerId:**同一个 modelId 在不同平台是不同的价**
 * (OpenAI 直连 vs Azure、Anthropic 全球 vs 仅美国 +10%),而且调研在
 * OpenRouter 一家上就抓到三个独立的价格错。
 *
 * 返回 null = **没有定价**,调用方记 `costMicros: null`、界面显示「—」。
 * 不要在这里编一个 0 —— `¥0.00` 看着像「这次免费」,而实际是「我们不知道」。
 */
export function findPricing(
  table: readonly ModelPricing[],
  providerId: string | null,
  modelId: string,
  at: number
): ModelPricing | null {
  const rows = table.filter((p) => p.modelId === modelId && effectiveAt(p, at))
  if (providerId !== null) {
    const override = rows.find((p) => p.providerId === providerId)
    if (override !== undefined) return override
  }
  return rows.find((p) => p.providerId === null) ?? null
}
