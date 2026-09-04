import { describe, expect, it } from 'vitest'
import { findPreset } from '../presets'
import type { ModelPricing, PriceTier, TokenRates } from '../pricing'
import { findPricing, priceOf } from '../pricing'
import { NOT_SEEDED, PRICING_SEED } from '../pricing-seed'

/**
 * 种子表的结构测试 —— 方案 §4.6。
 *
 * ★ **这里测不了「价格对不对」。** 一个数字抄错了,没有任何本地断言能发现 ——
 * 唯一的防线是采集纪律(双独立来源、逐条 `source`),那发生在写这张表的时候。
 *
 * 所以这个文件测的是另外三件事,每一件都对应一种**能悄悄发生**的坏:
 *
 * 1. **形状错**会让 `priceOf` 返回 null 或选错档 —— 表现是费用列变「—」或数字偏低,
 *    两种都不会有人报 bug。
 * 2. **跨模块失约**:`providerId` 写了个 `presets.ts` 里不存在的 id,
 *    覆盖价就永远命不中,静默退回通用价(币种可能都不对)。
 * 3. **抄写笔误**:各家的费率之间有严格的代数关系(Anthropic 的 1.25×/2×、
 *    OpenAI 越档的 2×/1.5×、xAI 的一律 2×)。这些关系**不用来生成数据**
 *    (方案 §4.2 明令存绝对价),但拿来**校验**手抄的数据正合适 ——
 *    敲错一位数几乎必然破坏其中一条。
 */

const rows = PRICING_SEED
const rateOf = (t: PriceTier): TokenRates => t.rate
const numericRates = (r: TokenRates): number[] =>
  Object.values(r).filter((v): v is number => typeof v === 'number')

/** 每档都取到,包括阶梯的高档 */
const allRates = (p: ModelPricing): TokenRates[] => p.tiers.map(rateOf)

const byId = (modelId: string, providerId: string | null = null): ModelPricing => {
  const found = rows.find((p) => p.modelId === modelId && p.providerId === providerId)
  if (found === undefined) throw new Error(`种子表里没有 ${providerId ?? '通用'}/${modelId}`)
  return found
}

describe('种子表 · 基本形状', () => {
  it('非空,且规模没有意外缩水', () => {
    // 下界防的是「合并分支时整段被删掉」—— 不是精确计数,免得加一行就得改测试
    expect(rows.length).toBeGreaterThan(50)
  })

  it('每条都有 displayName 与合法币种', () => {
    for (const p of rows) {
      expect(p.displayName.trim(), p.modelId).not.toBe('')
      expect(['USD', 'CNY'], p.modelId).toContain(p.currency)
    }
  })

  it('本轮只有文本模态 —— 图像等 Tab 是占位,不该有数据混进来', () => {
    for (const p of rows) expect(p.modality, p.modelId).toBe('text')
  })

  it('fetchedAt 全表一致,且是合法的 YYYY-MM-DD', () => {
    for (const p of rows) {
      expect(p.fetchedAt, p.modelId).toBe('2026-09-04')
      expect(Number.isNaN(Date.parse(p.fetchedAt)), p.modelId).toBe(false)
    }
  })

  /** 界面上逐行显示它,点得开 —— 所以必须是个真 URL,而且不能是 http */
  it('source 是可解析的 https URL', () => {
    for (const p of rows) {
      expect(() => new URL(p.source), p.modelId).not.toThrow()
      expect(new URL(p.source).protocol, p.modelId).toBe('https:')
    }
  })
})

describe('种子表 · 阶梯结构', () => {
  it('tiers 非空', () => {
    for (const p of rows) expect(p.tiers.length, p.modelId).toBeGreaterThan(0)
  })

  /**
   * ★ **末档必须无上界。** 末档写成具体数字的话,超过它的请求一档都命不中 ——
   * `selectTier` 会退到最后一档兜底(不抛),于是**没有任何症状**,
   * 只是超长请求按了错的档算。这条断言是那个兜底分支的唯一守卫。
   */
  it('末档 upToInputTokens 为 null', () => {
    for (const p of rows) {
      expect(p.tiers[p.tiers.length - 1]?.upToInputTokens, p.modelId).toBeNull()
    }
  })

  it('非末档都有上界,且严格递增', () => {
    for (const p of rows) {
      const bounds = p.tiers.slice(0, -1).map((t) => t.upToInputTokens)
      for (const b of bounds) expect(b, p.modelId).not.toBeNull()
      const nums = bounds as number[]
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i], `${p.modelId} 第 ${i} 档`).toBeGreaterThan(nums[i - 1] as number)
      }
    }
  })

  /**
   * ★ **一个价都不能是 0。** 0 在 `costMicros` 里是个合法数字,会被当成「这项免费」
   * 算进总额;而它真正的来源几乎总是「不知道,先填个 0」。
   * 不知道的正确写法是**不写这个字段** —— 那样 `priceOf` 返回 null,界面显示「—」。
   */
  it('所有费率严格为正', () => {
    for (const p of rows) {
      for (const r of allRates(p)) {
        for (const v of numericRates(r)) expect(v, p.modelId).toBeGreaterThan(0)
      }
    }
  })

  it('每条都至少能算出「纯输入输出」这一种请求', () => {
    for (const p of rows) {
      const got = priceOf(p, { inputTokens: 1000, outputTokens: 100 }, Date.UTC(2026, 8, 4))
      expect(got, p.modelId).not.toBeNull()
      expect(got?.currency, p.modelId).toBe(p.currency)
    }
  })
})

describe('种子表 · 主键与生效区间', () => {
  it('(providerId, modelId, effectiveFrom) 无重复', () => {
    const seen = new Set<string>()
    for (const p of rows) {
      const key = `${p.providerId ?? '*'} ${p.modelId} ${p.effectiveFrom ?? ''}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('同一 (providerId, modelId) 的多行,日期区间互不重叠', () => {
    const groups = new Map<string, ModelPricing[]>()
    for (const p of rows) {
      const key = `${p.providerId ?? '*'} ${p.modelId}`
      groups.set(key, [...(groups.get(key) ?? []), p])
    }
    for (const [key, g] of groups) {
      if (g.length < 2) continue
      const sorted = [...g].sort((a, b) =>
        (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? '')
      )
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i - 1]?.effectiveUntil
        const thisStart = sorted[i]?.effectiveFrom
        // 前一行必须封口、后一行必须有起点,否则「永远生效」会盖住另一行
        expect(prevEnd, `${key} 第 ${i - 1} 行缺 effectiveUntil`).toBeDefined()
        expect(thisStart, `${key} 第 ${i} 行缺 effectiveFrom`).toBeDefined()
        expect(String(thisStart) > String(prevEnd), key).toBe(true)
      }
    }
  })

  /**
   * ★★ **每一行都必须能被查到。** 这条防的是「写了但永远用不上」——
   * 比如两行日期区间错位留了个洞、或者一行被同 key 的另一行完全遮住。
   * 没有它,一行错误的数据和一行不存在的数据看起来一模一样。
   */
  it('每一行在自己的生效期内都能被 findPricing 命中', () => {
    for (const p of rows) {
      // 取一个落在本行区间内的时刻:有起点用起点,否则用采集日
      const at = Date.parse(`${p.effectiveFrom ?? p.fetchedAt}T12:00:00Z`)
      const label = `${p.providerId ?? '*'}/${p.modelId}`
      expect(findPricing(rows, p.providerId, p.modelId, at), label).toBe(p)
    }
  })
})

/**
 * ★★ 跨模块契约:种子表的 `providerId` 必须是 `presets.ts` 里真实存在的 id。
 *
 * 对不上的后果是**静默**的:`findPricing` 查不到覆盖价就退回通用价 ——
 * 而国内几家根本没有通用价行,于是费用列变「—」;更糟的情况是退到了一条
 * **美元**的通用价上,把人民币的账算成美元的数。
 */
describe('种子表 × presets', () => {
  it('每个非空 providerId 都对应一条真实预设', () => {
    for (const p of rows) {
      if (p.providerId === null) continue
      expect(findPreset(p.providerId), `${p.providerId}/${p.modelId}`).not.toBeNull()
    }
  })

  it('用到的 providerId 就是这五个 —— 加一家要连带补 presets 和币种', () => {
    const ids = [...new Set(rows.map((p) => p.providerId).filter((x): x is string => x !== null))]
    expect(ids.sort()).toEqual(['dashscope', 'deepseek', 'moonshot', 'moonshot-global', 'zai'])
  })

  it('国内站的行记人民币,国际站的行记美元 —— 不做换算(方案 §5.3)', () => {
    const expected: Record<string, 'USD' | 'CNY'> = {
      deepseek: 'CNY',
      moonshot: 'CNY',
      dashscope: 'CNY',
      'moonshot-global': 'USD',
      zai: 'USD'
    }
    for (const p of rows) {
      if (p.providerId === null) continue
      expect(p.currency, `${p.providerId}/${p.modelId}`).toBe(expected[p.providerId])
    }
  })

  it('通用价(providerId === null)一律美元', () => {
    for (const p of rows) {
      if (p.providerId === null) expect(p.currency, p.modelId).toBe('USD')
    }
  })
})

/**
 * ─────────────────────────────────────────────────────────────
 * 抄写校验:各家费率之间的代数关系
 * ─────────────────────────────────────────────────────────────
 *
 * ★ **这些关系不是用来生成数据的**(方案 §4.2:存绝对价,不存倍率),
 * 是用来**复核手抄结果**的。敲错一位数几乎必然破坏其中一条。
 *
 * 浮点一律 `toBeCloseTo` —— `3 * 0.1 !== 0.3`,而这张表里恰好有 input=3 的行。
 */
describe('抄写校验 · Anthropic', () => {
  const anth = rows.filter((p) => p.modelId.startsWith('claude-'))

  it('13 个 SKU,全部单档(官方费率卡已无 >200K 档)', () => {
    expect(anth.length).toBe(13)
    for (const p of anth) expect(p.tiers.length, p.modelId).toBe(1)
  })

  it('缓存写 = 1.25× 输入,1h 写 = 2× 输入', () => {
    for (const p of anth) {
      const r = p.tiers[0]?.rate as TokenRates
      expect(r.cacheWrite, p.modelId).toBeCloseTo(r.input * 1.25, 6)
      expect(r.cacheWrite1h, p.modelId).toBeCloseTo(r.input * 2, 6)
    }
  })

  /**
   * ★ 「缓存读 = 0.1× 输入」有**两个真实例外** —— 正是方案 §4.2 引为
   * 「不能用公式生成种子表」证据的那两行。把它们钉死在这里,
   * 是为了让「顺手把这两个数改成 1.0 好让规律统一」这件事必须先删掉一条测试。
   */
  it('缓存读 = 0.1× 输入,除 Mythos/Fable 5.1 是 0.025×', () => {
    const exceptions = new Set(['claude-mythos-5-1', 'claude-fable-5-1'])
    for (const p of anth) {
      const r = p.tiers[0]?.rate as TokenRates
      const factor = exceptions.has(p.modelId) ? 0.025 : 0.1
      expect(r.cacheRead, p.modelId).toBeCloseTo(r.input * factor, 6)
    }
    // 上一代同价位机型确实是 0.1x($1.00)—— 证明这个例外是**代际**差异,不是笔误
    expect(byId('claude-fable-5').tiers[0]?.rate.cacheRead).toBe(1.0)
    expect(byId('claude-fable-5-1').tiers[0]?.rate.cacheRead).toBe(0.25)
  })

  it('输出 = 5× 输入(全 13 条都成立)', () => {
    for (const p of anth) {
      const r = p.tiers[0]?.rate as TokenRates
      expect(r.output, p.modelId).toBeCloseTo(r.input * 5, 6)
    }
  })
})

describe('抄写校验 · 长上下文档', () => {
  /** ★ 越档倍率**不对称**:输入/缓存 ×2,输出只 ×1.5。写反了费用会偏低 */
  const asymmetric = (p: ModelPricing, threshold: number): void => {
    expect(p.tiers.length, p.modelId).toBe(2)
    expect(p.tiers[0]?.upToInputTokens, p.modelId).toBe(threshold)
    const lo = p.tiers[0]?.rate as TokenRates
    const hi = p.tiers[1]?.rate as TokenRates
    expect(hi.input, p.modelId).toBeCloseTo(lo.input * 2, 6)
    expect(hi.output, p.modelId).toBeCloseTo(lo.output * 1.5, 6)
    if (lo.cacheRead !== undefined) expect(hi.cacheRead, p.modelId).toBeCloseTo(lo.cacheRead * 2, 6)
    if (lo.cacheWrite !== undefined)
      expect(hi.cacheWrite, p.modelId).toBeCloseTo(lo.cacheWrite * 2, 6)
  }

  it('OpenAI:阈值 272K,输入/缓存 ×2、输出 ×1.5', () => {
    const tiered = rows.filter((p) => p.modelId.startsWith('gpt-') && p.tiers.length > 1)
    expect(tiered.map((p) => p.modelId).sort()).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra'
    ])
    for (const p of tiered) asymmetric(p, 272_000)
  })

  it('Gemini:只有 Pro 两款,阈值 200K(不是 1.5 时代的 128K)', () => {
    const gem = rows.filter((p) => p.modelId.startsWith('gemini-'))
    expect(gem.map((p) => p.modelId).sort()).toEqual(['gemini-2.5-pro', 'gemini-3.1-pro-preview'])
    for (const p of gem) asymmetric(p, 200_000)
  })

  /** xAI 是唯一一家各计费项倍率统一的 —— 所以它**不**走上面那个不对称断言 */
  it('xAI:阈值 200K,所有计费项一律 ×2', () => {
    const grok = rows.filter((p) => p.modelId.startsWith('grok-'))
    expect(grok.map((p) => p.modelId).sort()).toEqual(['grok-4.3', 'grok-4.5', 'grok-4.6'])
    for (const p of grok) {
      expect(p.tiers[0]?.upToInputTokens, p.modelId).toBe(200_000)
      const lo = p.tiers[0]?.rate as TokenRates
      const hi = p.tiers[1]?.rate as TokenRates
      expect(hi.input, p.modelId).toBeCloseTo(lo.input * 2, 6)
      expect(hi.output, p.modelId).toBeCloseTo(lo.output * 2, 6)
      expect(hi.cacheRead, p.modelId).toBeCloseTo((lo.cacheRead ?? 0) * 2, 6)
    }
  })

  /**
   * ★ 反向断言:除了上面点名的九条,**别的行都必须是单档**。
   * 没有它,给某一行悄悄加个档不会被任何测试注意到。
   */
  it('其余所有行都是单档', () => {
    const tiered = rows.filter((p) => p.tiers.length > 1).map((p) => p.modelId)
    expect(tiered.sort()).toEqual([
      'gemini-2.5-pro',
      'gemini-3.1-pro-preview',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'grok-4.3',
      'grok-4.5',
      'grok-4.6'
    ])
  })
})

/**
 * ─────────────────────────────────────────────────────────────
 * ★★ DeepSeek 时段计费 —— 种子表 × `priceOf` 的联测
 * ─────────────────────────────────────────────────────────────
 *
 * 这一组不是在测 `pricing.ts` 的时段逻辑(那边有自己的测试),
 * 是在测**这张表的录入方向对不对**:基准价录的是不是空闲价、
 * `daysOfWeek` 有没有漏、UTC 那两段有没有抄错。
 *
 * 官方原文(见 `pricing-seed.ts` 的注释):高峰 = **UTC 周一至周五**
 * 01:00–04:00 与 06:00–10:00,其余(含整个周末)全是空闲。
 */
describe('DeepSeek · 时段计费', () => {
  const ds = byId('deepseek-v4-flash', 'deepseek')
  const use = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  const at = (iso: string): number => Date.parse(iso)
  const cost = (iso: string): number => {
    const got = priceOf(ds, use, at(iso))
    expect(got, iso).not.toBeNull()
    return got?.micros ?? 0
  }
  const hitWindow = (iso: string): string | undefined => priceOf(ds, use, at(iso))?.window

  // 2026-09-07 是周一,2026-09-05 是周六(与 fetchedAt 同周)
  it('周一 UTC 02:00 落在第一段高峰', () => {
    expect(hitWindow('2026-09-07T02:00:00Z')).toContain('高峰')
  })

  it('周一 UTC 07:00 落在第二段高峰', () => {
    expect(hitWindow('2026-09-07T07:00:00Z')).toContain('高峰')
  })

  it('两段之间的 UTC 05:00 是空闲', () => {
    expect(hitWindow('2026-09-07T05:00:00Z')).toBeUndefined()
  })

  /** 起点**含**、终点**不含** —— 边界读法钉死在这里 */
  it('01:00 整点已在高峰内,04:00 整点已在高峰外', () => {
    expect(hitWindow('2026-09-07T01:00:00Z')).toContain('高峰')
    expect(hitWindow('2026-09-07T04:00:00Z')).toBeUndefined()
  })

  /**
   * ★★ **周末整天空闲。** 这是 `daysOfWeek` 字段存在的唯一理由 ——
   * 漏了它,「周六凌晨 2 点」会按高峰价算,**贵一倍**,而没有任何人会发现。
   */
  it('周六 UTC 02:00 是空闲价,不是高峰', () => {
    expect(hitWindow('2026-09-05T02:00:00Z')).toBeUndefined()
    expect(cost('2026-09-05T02:00:00Z')).toBe(cost('2026-09-07T05:00:00Z'))
  })

  /**
   * ★ **录入方向**:基准 = 空闲。高峰恰好是它的两倍,而不是反过来。
   * 方向写反了,「没命中窗口」会落在**贵**的那一侧 —— 见 `pricing-seed.ts` 文件头。
   */
  it('高峰价 = 空闲价 × 2,且基准(不命中窗口时)是便宜的那一侧', () => {
    const peak = cost('2026-09-07T02:00:00Z')
    const off = cost('2026-09-07T05:00:00Z')
    expect(peak).toBe(off * 2)
    // ¥1.5/M 输入 + ¥4.5/M 输出,各一百万 token = ¥6 = 6_000_000 micros
    expect(off).toBe(6_000_000)
  })

  it('三条 DeepSeek 记录都挂了窗口', () => {
    const all = rows.filter((p) => p.providerId === 'deepseek')
    expect(all.length).toBe(3)
    for (const p of all) expect(p.windows?.length, p.modelId).toBe(2)
  })

  /** DeepSeek 没有缓存写入费 —— **缺省**,不是 0(0 会被算成「写入免费」) */
  it('无缓存写入价:写缓存的请求返回 null(无定价),而不是算成免费', () => {
    for (const p of rows.filter((x) => x.providerId === 'deepseek')) {
      expect(p.tiers[0]?.rate.cacheWrite, p.modelId).toBeUndefined()
      const got = priceOf(
        p,
        { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 50 },
        at('2026-09-07T05:00:00Z')
      )
      expect(got, p.modelId).toBeNull()
    }
  })
})

/**
 * ★ 全表唯一一处有据可查的调价:GLM-5.3-Flash 的促销于 UTC+8 的 2026-09-09 24:00 结束。
 * 两行、区间相邻不重叠 —— 到点自动切,而不是等用户某天发现统计全错。
 */
describe('GLM-5.3-Flash · 促销到期自动切换', () => {
  const at = (d: string): number => Date.parse(`${d}T12:00:00Z`)
  const inputAt = (d: string): number | undefined =>
    findPricing(rows, 'zai', 'glm-5.3-flash', at(d))?.tiers[0]?.rate.input

  it('促销期内是 $0.075', () => {
    expect(inputAt('2026-09-04')).toBe(0.075)
    expect(inputAt('2026-09-09')).toBe(0.075)
  })

  it('次日起是原价 $0.15', () => {
    expect(inputAt('2026-09-10')).toBe(0.15)
    expect(inputAt('2026-12-31')).toBe(0.15)
  })

  it('两段之间没有空档 —— 任何一天都查得到价', () => {
    for (const d of ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
      expect(findPricing(rows, 'zai', 'glm-5.3-flash', at(d)), d).not.toBeNull()
    }
  })

  it('这是全表唯一一组带日期区间的行', () => {
    const dated = rows.filter(
      (p) => p.effectiveFrom !== undefined || p.effectiveUntil !== undefined
    )
    expect(dated.map((p) => p.modelId)).toEqual(['glm-5.3-flash', 'glm-5.3-flash'])
  })
})

/**
 * ★★ `NOT_SEEDED` 的测试防的是**相反**的事:
 * 有人看见表里没有 Mistral,以为是漏了,「顺手」补回来 —— 而那批数据是单源的。
 *
 * 把排除项写成可断言的数据(而不是散落的注释),排除决定才有牙齿。
 */
describe('NOT_SEEDED · 排除项是决定,不是遗漏', () => {
  it('每条都写清了是什么、为什么', () => {
    expect(NOT_SEEDED.length).toBeGreaterThan(5)
    for (const n of NOT_SEEDED) {
      expect(n.what.trim()).not.toBe('')
      expect(n.why.length, n.what).toBeGreaterThan(20)
    }
  })

  /** 被点名排除的厂商,不能同时出现在种子表里 —— 一处改了另一处必须跟着改 */
  it('被排除的厂商确实不在表里', () => {
    const banned = ['mistral', 'magistral', 'doubao', 'minimax', 'ernie', 'hunyuan', 'step-']
    for (const p of rows) {
      for (const b of banned) {
        expect(p.modelId.toLowerCase().includes(b), `${p.modelId} 命中排除项 ${b}`).toBe(false)
      }
    }
  })

  /** Gemini 只该有 Pro:Flash 全系因摘要器混淆 + 未核实的调价公告被排除 */
  it('Gemini 的 Flash 全系不在表里', () => {
    const flash = rows.filter((p) => p.modelId.startsWith('gemini') && p.modelId.includes('flash'))
    expect(flash).toEqual([])
  })
})
