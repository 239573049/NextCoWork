/**
 * `priceOf` 的测试 —— 方案 §4.4。
 *
 * 这一组里的每一条都对应一种**算得出数字、但数字是错的**的失败:
 * 阶梯写成累进、缓存 token 没算进阈值、时段用了本机时区、星期维度漏掉。
 * 它们的共同点是**不会抛错、不会为 0、看着很合理** —— 用户不会发现,
 * 所以只有测试能发现。覆盖率不是这里的目标。
 *
 * 时间一律是显式的 `at` 参数,不 mock 全局 `Date`。
 */
import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '../../agent/stream'
import type { ModelPricing } from '../pricing'
import { findPricing, inWindow, priceOf } from '../pricing'

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  ...u
})

/** `tiers` 有默认值:查表那一组只关心选到哪一行,费率是什么无所谓 */
const pricing = (p: Partial<ModelPricing> = {}): ModelPricing => ({
  providerId: null,
  modelId: 'm',
  displayName: 'M',
  currency: 'USD',
  modality: 'text',
  tiers: [{ upToInputTokens: null, rate: { input: 1, output: 1 } }],
  source: 'https://example.invalid/pricing',
  fetchedAt: '2026-09-04',
  ...p
})

/** 单档:输入 $3/M、输出 $15/M */
const FLAT = pricing({ tiers: [{ upToInputTokens: null, rate: { input: 3, output: 15 } }] })

/**
 * 双档,200K 阈值,**倍率不对称** —— 照 OpenAI 越过 272K 的形状
 * (输入 ×2、输出 ×1.5)。对称倍率会让「输出没跟着换档」这个 bug 藏起来。
 */
const TIERED = pricing({
  tiers: [
    { upToInputTokens: 200_000, rate: { input: 3, output: 15, cacheRead: 0.3 } },
    { upToInputTokens: null, rate: { input: 6, output: 22.5, cacheRead: 0.6 } }
  ]
})

describe('priceOf · 基本换算', () => {
  /**
   * 费率是「每百万」,金额是 micros —— 两个百万约掉,所以 1M token × $3
   * 正好是 3_000_000 micros($3.00)。这条钉住那个「看起来像漏了换算」的乘法。
   */
  it('1M 输入 × $3/M = $3.00', () => {
    expect(priceOf(FLAT, usage({ inputTokens: 1_000_000 }), 0)?.micros).toBe(3_000_000)
  })

  it('输入和输出各算各的', () => {
    const r = priceOf(FLAT, usage({ inputTokens: 500_000, outputTokens: 100_000 }), 0)
    // 0.5M × 3 + 0.1M × 15 = 1.5 + 1.5 = $3.00
    expect(r?.micros).toBe(3_000_000)
    expect(r?.currency).toBe('USD')
    expect(r?.tier).toBe(0)
    expect(r?.window).toBeUndefined()
  })

  it('零用量是 0,不是 null —— 「算出来是 0」和「不知道多少钱」是两回事', () => {
    expect(priceOf(FLAT, usage({}), 0)?.micros).toBe(0)
  })
})

describe('★ 阶梯:选档,以及选完之后整单重算', () => {
  it('恰好等于上界仍在低档(upToInputTokens 是含的)', () => {
    expect(priceOf(TIERED, usage({ inputTokens: 200_000 }), 0)?.tier).toBe(0)
  })

  it('多一个 token 就进高档', () => {
    expect(priceOf(TIERED, usage({ inputTokens: 200_001 }), 0)?.tier).toBe(1)
  })

  /**
   * ★★ **这条是全文件最重要的一条。**
   *
   * 300K 输入的费用 = 300K × 高档价,**不是** 200K × 低档 + 100K × 高档。
   * 累进算法算出来是 200_000×3 + 100_000×6 = 1_200_000 micros,
   * 正确答案是 300_000×6 = 1_800_000 —— 差 33%,不扎眼,而且方向是偏低。
   */
  it('不是累进制:整个请求按高档价重算', () => {
    const r = priceOf(TIERED, usage({ inputTokens: 300_000 }), 0)
    expect(r?.micros).toBe(1_800_000)
    expect(r?.micros).not.toBe(1_200_000) // 累进算法会给出这个数
  })

  /**
   * ★ 越档换的是**一整套**费率,不只是输入那一项。
   * 只换输入是很自然的手滑,而输出通常是费用的大头。
   */
  it('越档时输出也按高档价重算', () => {
    // 300K 输入(进高档)+ 10K 输出:300_000×6 + 10_000×22.5 = 2_025_000
    expect(priceOf(TIERED, usage({ inputTokens: 300_000, outputTokens: 10_000 }), 0)?.micros).toBe(
      2_025_000
    )
    // 用低档的输出价算会得到 1_950_000
    expect(
      priceOf(TIERED, usage({ inputTokens: 300_000, outputTokens: 10_000 }), 0)?.micros
    ).not.toBe(1_950_000)
  })

  /**
   * ★ 选档的分母含缓存读。190K 新鲜 + 20K 缓存读 = 210K > 200K → 高档。
   * 只看 `inputTokens` 的实现会判成低档,而这是**反直觉**的一条:
   * 大缓存前缀在阈值附近是负担,不是优势。
   */
  it('缓存读 token 计入档位阈值', () => {
    const u = usage({ inputTokens: 190_000, cacheReadInputTokens: 20_000 })
    expect(priceOf(TIERED, u, 0)?.tier).toBe(1)
    // 而且缓存读本身也按高档的缓存价算:190_000×6 + 20_000×0.6 = 1_152_000
    expect(priceOf(TIERED, u, 0)?.micros).toBe(1_152_000)
  })

  it('缓存写 token 同样计入阈值 —— 它一样是这次 prompt 的一部分', () => {
    const tiered = pricing({
      tiers: [
        { upToInputTokens: 200_000, rate: { input: 3, output: 15, cacheWrite: 3.75 } },
        { upToInputTokens: null, rate: { input: 6, output: 22.5, cacheWrite: 7.5 } }
      ]
    })
    const u = usage({ inputTokens: 190_000, cacheCreationInputTokens: 20_000 })
    expect(priceOf(tiered, u, 0)?.tier).toBe(1)
  })

  it('末档无上界:再大的输入也落在它身上', () => {
    expect(priceOf(TIERED, usage({ inputTokens: 50_000_000 }), 0)?.tier).toBe(1)
  })
})

describe('缓存三项分别计价', () => {
  const CACHED = pricing({
    tiers: [
      {
        upToInputTokens: null,
        rate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 }
      }
    ]
  })

  it('缓存读走 cacheRead 价', () => {
    expect(priceOf(CACHED, usage({ cacheReadInputTokens: 1_000_000 }), 0)?.micros).toBe(300_000)
  })

  it('缓存写默认全按 5m 档', () => {
    expect(priceOf(CACHED, usage({ cacheCreationInputTokens: 1_000_000 }), 0)?.micros).toBe(
      3_750_000
    )
  })

  /**
   * ★ 上游给了 1h 明细时,那部分要从总写入里**扣掉**再按 1h 价算 ——
   * 否则同一批 token 被算两次。
   */
  it('给了 1h 明细时,5m 与 1h 分开计价且不重复计算', () => {
    const u = usage({ cacheCreationInputTokens: 1_000_000, cacheCreation1hInputTokens: 400_000 })
    // 600_000×3.75 + 400_000×6 = 2_250_000 + 2_400_000
    expect(priceOf(CACHED, u, 0)?.micros).toBe(4_650_000)
  })

  /**
   * ★ 有 token、没费率 → **null**,不是当 0 算。
   * 当 0 算会给出一个偏低但看着合理的数字,没有任何人会发现。
   */
  it('有缓存读 token 但费率表没有 cacheRead → null', () => {
    expect(priceOf(FLAT, usage({ cacheReadInputTokens: 1_000 }), 0)).toBeNull()
  })

  it('有缓存写 token 但费率表没有 cacheWrite → null', () => {
    expect(priceOf(FLAT, usage({ cacheCreationInputTokens: 1_000 }), 0)).toBeNull()
  })

  it('1h 写入**不**退回 5m 价 —— 退回去就是静默少收一半', () => {
    const only5m = pricing({
      tiers: [{ upToInputTokens: null, rate: { input: 3, output: 15, cacheWrite: 3.75 } }]
    })
    const u = usage({ cacheCreationInputTokens: 1_000, cacheCreation1hInputTokens: 1_000 })
    expect(priceOf(only5m, u, 0)).toBeNull()
  })

  it('费率缺席但那类 token 也是 0 时,照常算 —— 缺席本身不是错', () => {
    expect(priceOf(FLAT, usage({ inputTokens: 1_000, cacheReadInputTokens: 0 }), 0)?.micros).toBe(
      3_000
    )
  })
})

// ─── 时段(方案 §4.3) ───

/**
 * DeepSeek 的真实形状。**原文照抄在这里,因为下一个人也会想当然:**
 *
 * > "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 * > 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 *
 * > 「空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五
 * > 9:00 - 12:00、14:00 - 18:00(其余为空闲时段)。」
 *
 * 照 §4.3 的决定:**基准价录空闲价,窗口录高峰 `multiplier: 2`**。
 * 这样万一星期/时区判断有 bug,错的方向是少算而不是多算用户的钱。
 */
const DEEPSEEK = pricing({
  modelId: 'deepseek-v4-flash',
  tiers: [{ upToInputTokens: null, rate: { input: 0.22, output: 0.66 } }],
  windows: [
    {
      timezone: 'UTC',
      daysOfWeek: [1, 2, 3, 4, 5],
      start: '01:00',
      end: '04:00',
      multiplier: 2,
      label: '高峰时段'
    },
    {
      timezone: 'UTC',
      daysOfWeek: [1, 2, 3, 4, 5],
      start: '06:00',
      end: '10:00',
      multiplier: 2,
      label: '高峰时段'
    }
  ]
})

const AT = (iso: string): number => Date.parse(iso)

describe('★ 时段 · 时区', () => {
  it('周三 UTC 02:00 命中高峰,价格翻倍', () => {
    const r = priceOf(DEEPSEEK, usage({ inputTokens: 1_000_000 }), AT('2026-09-02T02:00:00Z'))
    expect(r?.window).toBe('高峰时段')
    expect(r?.micros).toBe(440_000) // 0.22 × 2
  })

  it('周三 UTC 05:00 落在两段高峰之间,是空闲价', () => {
    const r = priceOf(DEEPSEEK, usage({ inputTokens: 1_000_000 }), AT('2026-09-02T05:00:00Z'))
    expect(r?.window).toBeUndefined()
    expect(r?.micros).toBe(220_000)
  })

  /**
   * ★ 窗口写的是 UTC,而北京时间 09:00 是 UTC 01:00 —— 那**才是**高峰。
   * 拿本机时区去比的实现会在这里判反(它会以为 09:00 在 06:00–10:00 里)。
   */
  it('UTC 的时段不能拿别的时区的钟去比', () => {
    // 2026-09-02T09:00Z = 北京 17:00。UTC 09:00 在 06:00–10:00 里 → 高峰
    expect(priceOf(DEEPSEEK, usage({}), AT('2026-09-02T09:00:00Z'))?.window).toBe('高峰时段')
    // 北京 09:00 = UTC 01:00 → 也是高峰,但走的是**第一段**
    expect(priceOf(DEEPSEEK, usage({}), AT('2026-09-02T01:00:00Z'))?.window).toBe('高峰时段')
    // 北京 17:00 那一刻若被误当成「17:00 不在任何窗口」就会漏判 —— 上面第一条守着
  })

  it('起点含、终点不含', () => {
    expect(priceOf(DEEPSEEK, usage({}), AT('2026-09-02T01:00:00Z'))?.window).toBe('高峰时段')
    expect(priceOf(DEEPSEEK, usage({}), AT('2026-09-02T04:00:00Z'))?.window).toBeUndefined()
  })

  /**
   * 午夜是每天头一个小时,任何 `%12`、`|| 12`、或者把 24 小时制写成
   * 「1..24」的手写实现都会在这里错,而且只在这一个小时里错。
   *
   * ★ 说明白:当前实现换成 `hour12: false` 这条**也过** —— 实测本机 ICU 下
   * 两者等价(见 pricing.ts 里那段)。所以这一条守的是**行为**,
   * 不是那两个选项之间的差别,别拿它当「h23 必要性」的证据。
   */
  it('午夜按 00 计,不是 24', () => {
    const midnight = pricing({
      tiers: [{ upToInputTokens: null, rate: { input: 1, output: 1 } }],
      windows: [{ timezone: 'UTC', start: '00:00', end: '01:00', multiplier: 3, label: '零点档' }]
    })
    expect(priceOf(midnight, usage({}), AT('2026-09-02T00:30:00Z'))?.window).toBe('零点档')
  })

  it('跨午夜的时段', () => {
    const night = pricing({
      tiers: [{ upToInputTokens: null, rate: { input: 1, output: 1 } }],
      windows: [{ timezone: 'UTC', start: '22:00', end: '02:00', multiplier: 0.5, label: '夜间' }]
    })
    expect(priceOf(night, usage({}), AT('2026-09-02T23:00:00Z'))?.window).toBe('夜间')
    expect(priceOf(night, usage({}), AT('2026-09-02T01:00:00Z'))?.window).toBe('夜间')
    expect(priceOf(night, usage({}), AT('2026-09-02T12:00:00Z'))?.window).toBeUndefined()
  })
})

describe('★ 时段 · 星期', () => {
  /**
   * ★ 这是第一版漏掉的字段。DeepSeek 的高峰只在周一至周五,
   * 没有 `daysOfWeek` 的话周六凌晨 2 点会被算成高峰 —— **贵一倍,没人会发现**。
   */
  it('周六 UTC 02:00 是空闲价,不是高峰', () => {
    // 2026-09-05 是周六
    const r = priceOf(DEEPSEEK, usage({ inputTokens: 1_000_000 }), AT('2026-09-05T02:00:00Z'))
    expect(r?.window).toBeUndefined()
    expect(r?.micros).toBe(220_000)
  })

  it('周日 UTC 02:00 同样是空闲价', () => {
    expect(priceOf(DEEPSEEK, usage({}), AT('2026-09-06T02:00:00Z'))?.window).toBeUndefined()
  })

  it('省略 daysOfWeek = 每天都生效', () => {
    const daily = pricing({
      tiers: [{ upToInputTokens: null, rate: { input: 1, output: 1 } }],
      windows: [{ timezone: 'UTC', start: '01:00', end: '04:00', multiplier: 2, label: '每天' }]
    })
    expect(priceOf(daily, usage({}), AT('2026-09-05T02:00:00Z'))?.window).toBe('每天')
  })
})

describe('★★ 时段 · 星期和小时必须来自同一次换算', () => {
  /**
   * `2026-09-06T23:30Z` 在 UTC 是**周日 23:30**,在 `Asia/Shanghai` 是**周一 07:30**。
   *
   * 一个「小时用目标时区、星期用本机时区」的实现会在这里判错 ——
   * 而这正是跨日边界上的经典错。两条断言从两个方向钉住它。
   */
  const SHANGHAI = pricing({
    tiers: [{ upToInputTokens: null, rate: { input: 1, output: 1 } }],
    windows: [
      {
        timezone: 'Asia/Shanghai',
        daysOfWeek: [1, 2, 3, 4, 5],
        start: '07:00',
        end: '09:00',
        multiplier: 2,
        label: '早高峰'
      }
    ]
  })

  it('UTC 周日 23:30 在上海是周一 07:30 —— 命中周一的早高峰', () => {
    expect(priceOf(SHANGHAI, usage({}), AT('2026-09-06T23:30:00Z'))?.window).toBe('早高峰')
  })

  it('UTC 周五 23:30 在上海是周六 07:30 —— 不命中', () => {
    expect(priceOf(SHANGHAI, usage({}), AT('2026-09-04T23:30:00Z'))?.window).toBeUndefined()
  })

  it('inWindow 自己也守着这条(供其它调用点复用)', () => {
    const w = {
      timezone: 'Asia/Shanghai',
      daysOfWeek: [1],
      start: '07:00',
      end: '09:00',
      label: 'x'
    }
    expect(inWindow(w, AT('2026-09-06T23:30:00Z'))).toBe(true)
    expect(inWindow(w, AT('2026-09-06T22:30:00Z'))).toBe(false) // 上海周一 06:30,还没到
  })
})

describe('时段 · multiplier 与 rates', () => {
  const BOTH = pricing({
    tiers: [{ upToInputTokens: null, rate: { input: 10, output: 10 } }],
    windows: [
      {
        timezone: 'UTC',
        start: '00:00',
        end: '23:59',
        multiplier: 2,
        rates: { input: 1, output: 1 },
        label: '两个都给'
      }
    ]
  })

  it('两个都给时整套 rates 赢 —— 它比一个标量更具体', () => {
    expect(
      priceOf(BOTH, usage({ inputTokens: 1_000_000 }), AT('2026-09-02T12:00:00Z'))?.micros
    ).toBe(1_000_000)
  })

  it('multiplier 会等比缩放缓存价,不只是输入输出', () => {
    const p = pricing({
      tiers: [{ upToInputTokens: null, rate: { input: 3, output: 15, cacheRead: 0.3 } }],
      windows: [{ timezone: 'UTC', start: '00:00', end: '23:59', multiplier: 2, label: 'x' }]
    })
    expect(
      priceOf(p, usage({ cacheReadInputTokens: 1_000_000 }), AT('2026-09-02T12:00:00Z'))?.micros
    ).toBe(600_000)
  })
})

// ─── 查表(方案 §4.1) ───

describe('findPricing', () => {
  const seed = pricing({ providerId: null, modelId: 'gpt-x', displayName: '种子' })
  const override = pricing({ providerId: 'p1', modelId: 'gpt-x', displayName: '覆盖' })
  const table = [seed, override]

  it('供应商覆盖价优先于种子价', () => {
    expect(findPricing(table, 'p1', 'gpt-x', 0)?.displayName).toBe('覆盖')
  })

  it('没有覆盖价时退到种子价', () => {
    expect(findPricing(table, 'p2', 'gpt-x', 0)?.displayName).toBe('种子')
  })

  it('查不到返回 null,不是一个 0 价的行', () => {
    expect(findPricing(table, 'p1', '不存在的模型', 0)).toBeNull()
  })

  /**
   * ★ 厂商会**预告**调价(Gemini Flash 系列写明 2027-01-01 起翻倍)。
   * 不按日期选行的话,那天起所有费用静默偏低一半。
   */
  it('按 effectiveFrom / effectiveUntil 选行', () => {
    const old = pricing({ modelId: 'g', displayName: '导入期价', effectiveUntil: '2026-12-31' })
    const nw = pricing({ modelId: 'g', displayName: '正式价', effectiveFrom: '2027-01-01' })
    const t = [old, nw]
    expect(findPricing(t, null, 'g', AT('2026-12-31T23:00:00Z'))?.displayName).toBe('导入期价')
    expect(findPricing(t, null, 'g', AT('2027-01-01T00:00:00Z'))?.displayName).toBe('正式价')
  })

  it('两行日期都不覆盖当前时刻时返回 null', () => {
    const t = [pricing({ modelId: 'g', effectiveUntil: '2020-01-01' })]
    expect(findPricing(t, null, 'g', AT('2026-09-04T00:00:00Z'))).toBeNull()
  })
})
