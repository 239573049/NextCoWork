import { describe, expect, it } from 'vitest'
import type { UsageDailyBucket } from '../../../../../../shared/domain/usage'
import {
  applyGranularity,
  buildHeatmap,
  fillDayGaps,
  heatLevel,
  heatThresholds,
  toCostBreakdown,
  toDayTotals,
  toModelShares,
  totalsOf
} from '../usage-overview'

function bucket(patch: Partial<UsageDailyBucket> = {}): UsageDailyBucket {
  return {
    day: '2026-09-14',
    providerId: 'p1',
    providerName: 'Provider One',
    upstreamModel: 'model-a',
    alias: 'alias-a',
    currency: 'USD',
    requestCount: 10,
    successCount: 10,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 400,
    cacheWrite1hTokens: 0,
    thinkingTokens: 0,
    costMicros: 1_000_000,
    pricedCount: 10,
    latencySum: 1_000,
    ttftSum: 200,
    ttftCount: 10,
    ...patch
  }
}

describe('toDayTotals', () => {
  it('同一天的多个模型合并成一行', () => {
    const totals = toDayTotals([bucket(), bucket({ upstreamModel: 'model-b' })])
    expect(totals).toHaveLength(1)
    expect(totals[0]?.tokens).toBe(2 * 1000)
    expect(totals[0]?.requests).toBe(20)
  })

  it('按日期升序', () => {
    const totals = toDayTotals([
      bucket({ day: '2026-09-14' }),
      bucket({ day: '2026-09-12' }),
      bucket({ day: '2026-09-13' })
    ])
    expect(totals.map((t) => t.day)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14'])
  })

  it('token 总量 = 输入 + 输出 + 缓存读 + 缓存写', () => {
    const totals = toDayTotals([bucket()])
    expect(totals[0]?.tokens).toBe(1000)
  })

  // 跨币种相加得到的数没有单位
  it('不同币种分别记账,不相加', () => {
    const totals = toDayTotals([
      bucket({ currency: 'USD', costMicros: 1_000_000 }),
      bucket({ currency: 'CNY', costMicros: 7_000_000, upstreamModel: 'model-b' })
    ])
    expect(totals[0]?.costs).toEqual([
      { currency: 'CNY', micros: 7_000_000 },
      { currency: 'USD', micros: 1_000_000 }
    ])
  })

  // 未计价 ≠ 免费
  it('未计价的桶不进费用,只进未计价请求数', () => {
    const totals = toDayTotals([bucket({ costMicros: null, currency: '', pricedCount: 0 })])
    expect(totals[0]?.costs).toEqual([])
    expect(totals[0]?.unpricedRequests).toBe(10)
  })

  it('部分计价时未计价数是差额', () => {
    const totals = toDayTotals([bucket({ requestCount: 10, pricedCount: 7 })])
    expect(totals[0]?.unpricedRequests).toBe(3)
  })

  it('空输入返回空数组', () => {
    expect(toDayTotals([])).toEqual([])
  })
})

describe('fillDayGaps', () => {
  /*
   * ★ 不补洞的话,断更三天会被折线图画成一条直接连过去的斜线 —— 看起来像
   * 那三天有稳定的中等用量,而实际是零。
   */
  it('缺失的日期补成零值行', () => {
    const filled = fillDayGaps(
      toDayTotals([bucket({ day: '2026-09-14' })]),
      '2026-09-12',
      '2026-09-14'
    )
    expect(filled.map((t) => t.day)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14'])
    expect(filled[0]?.tokens).toBe(0)
    expect(filled[0]?.requests).toBe(0)
    expect(filled[2]?.tokens).toBe(1000)
  })

  it('全空区间也返回完整日期序列', () => {
    expect(fillDayGaps([], '2026-09-12', '2026-09-14')).toHaveLength(3)
  })

  it('区间外的数据被排除', () => {
    const filled = fillDayGaps(
      toDayTotals([bucket({ day: '2026-08-01' })]),
      '2026-09-12',
      '2026-09-13'
    )
    expect(filled).toHaveLength(2)
    expect(filled.every((t) => t.tokens === 0)).toBe(true)
  })
})

describe('applyGranularity', () => {
  const week = fillDayGaps(
    toDayTotals([
      bucket({ day: '2026-09-13' }), // 周日
      bucket({ day: '2026-09-14' }),
      bucket({ day: '2026-09-20' }) // 下一个周日
    ]),
    '2026-09-13',
    '2026-09-20'
  )

  it('daily 原样返回', () => {
    expect(applyGranularity(week, 'daily').map((t) => t.day)).toEqual(week.map((t) => t.day))
  })

  // 周起点必须与热力图的列一致(weekdayOf 里 0 = 周日),否则两张图分界错开一格
  it('weekly 按周日起分组,标签取该周第一天', () => {
    const weekly = applyGranularity(week, 'weekly')
    expect(weekly.map((t) => t.day)).toEqual(['2026-09-13', '2026-09-20'])
    expect(weekly[0]?.tokens).toBe(2000)
    expect(weekly[1]?.tokens).toBe(1000)
  })

  it('cumulative 逐日累加且单调不减', () => {
    const cumulative = applyGranularity(week, 'cumulative')
    expect(cumulative).toHaveLength(week.length)
    expect(cumulative[cumulative.length - 1]?.tokens).toBe(3000)
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i]!.tokens).toBeGreaterThanOrEqual(cumulative[i - 1]!.tokens)
    }
  })

  it('cumulative 的费用也按币种累加', () => {
    const days = fillDayGaps(
      toDayTotals([
        bucket({ day: '2026-09-13', costMicros: 1_000_000 }),
        bucket({ day: '2026-09-14', costMicros: 2_000_000 })
      ]),
      '2026-09-13',
      '2026-09-14'
    )
    const cumulative = applyGranularity(days, 'cumulative')
    expect(cumulative[1]?.costs).toEqual([{ currency: 'USD', micros: 3_000_000 }])
  })

  it('不修改输入', () => {
    const before = JSON.stringify(week)
    applyGranularity(week, 'cumulative')
    applyGranularity(week, 'weekly')
    expect(JSON.stringify(week)).toBe(before)
  })

  it('空输入各档都返回空', () => {
    for (const g of ['daily', 'weekly', 'cumulative'] as const) {
      expect(applyGranularity([], g)).toEqual([])
    }
  })
})

describe('热力图着色', () => {
  /*
   * ★ 这是分位数而不是 max/4 的理由。用量极度长尾:一天 4000 万,其余一两百万。
   * 按最大值等分的话,除那一天外全落到第 1 档,整张图一片同色 ——
   * 而它看起来只是「用得少」,不像着色算法失效。
   */
  it('长尾分布下仍能分出多个档位', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 40_000_000]
    const thresholds = heatThresholds(values)
    const levels = new Set(values.map((v) => heatLevel(v, thresholds)))
    expect(levels.size).toBeGreaterThanOrEqual(4)
  })

  it('零永远是第 0 档', () => {
    expect(heatLevel(0, heatThresholds([5, 10, 15]))).toBe(0)
  })

  it('任何正数至少是第 1 档', () => {
    expect(heatLevel(1, heatThresholds([1_000_000, 2_000_000]))).toBeGreaterThanOrEqual(1)
  })

  it('最大值是第 4 档', () => {
    const values = [10, 20, 30, 40, 50]
    expect(heatLevel(50, heatThresholds(values))).toBe(4)
  })

  // 小样本下三个分位会取到同一个值,档位重合就只剩两种颜色
  it('小样本下三档仍严格递增', () => {
    const [a, b, c] = heatThresholds([7, 7])
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('全零输入不抛错', () => {
    expect(() => heatThresholds([0, 0, 0])).not.toThrow()
    expect(heatLevel(0, heatThresholds([0, 0]))).toBe(0)
  })
})

describe('buildHeatmap', () => {
  const totals = toDayTotals([
    bucket({ day: '2026-09-14' }),
    bucket({ day: '2026-09-10', inputTokens: 5000 })
  ])

  it('网格是 weeks 列 × 每列 7 格', () => {
    const grid = buildHeatmap(totals, '2026-09-14', 53)
    expect(grid.weeks).toHaveLength(53)
    expect(grid.weeks.every((column) => column.length === 7)).toBe(true)
  })

  /*
   * 最后一列里「今天之后」的那几天还没发生。画成零活动格是在陈述一件没发生的事,
   * 所以给 null 让组件留白。
   */
  it('今天之后的格子是 null 而不是零值格', () => {
    const grid = buildHeatmap(totals, '2026-09-14', 4)
    const last = grid.weeks[grid.weeks.length - 1]!
    // 2026-09-14 是周一 → 列内索引 1,其后应全为 null
    expect(last[1]).not.toBeNull()
    expect(last.slice(2).every((cell) => cell === null)).toBe(true)
  })

  it('endDay 落在最后一列内', () => {
    const grid = buildHeatmap(totals, '2026-09-14', 4)
    const days = grid.weeks[grid.weeks.length - 1]!.map((c) => c?.day)
    expect(days).toContain('2026-09-14')
  })

  it('活跃天数只数有 token 的日子', () => {
    expect(buildHeatmap(totals, '2026-09-14', 53).activeDays).toBe(2)
  })

  it('无数据时网格仍然完整,只是全零', () => {
    const grid = buildHeatmap([], '2026-09-14', 8)
    expect(grid.weeks).toHaveLength(8)
    expect(grid.activeDays).toBe(0)
    expect(grid.maxTokens).toBe(0)
  })

  it('月份标签在每月第一次出现的列上,不重复', () => {
    const grid = buildHeatmap(totals, '2026-09-14', 53)
    const months = grid.months.map((m) => m.day.slice(0, 7))
    expect(new Set(months).size).toBe(months.length)
  })

  it('非法 endDay 返回空网格而不是抛错', () => {
    expect(buildHeatmap(totals, 'nope', 53).weeks).toEqual([])
  })
})

describe('toModelShares', () => {
  it('按 token 降序,占比加起来是 1', () => {
    const shares = toModelShares([
      bucket({
        upstreamModel: 'small',
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }),
      bucket({
        upstreamModel: 'big',
        inputTokens: 90,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      })
    ])
    expect(shares.map((s) => s.label)).toEqual(['alias-a · big', 'alias-a · small'])
    expect(shares[0]?.tokens).toBe(90)
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1)
  })

  it('别名为空时回退到上游模型名', () => {
    const [share] = toModelShares([bucket({ alias: '' })])
    expect(share?.label).toBe('model-a')
  })

  /*
   * ★ 尾部必须合并而不是截断:直接丢掉会让占比加起来不到 100%,
   * 而少的那部分去哪了没人看得出来。
   */
  it('超出上限的尾部合并成「其他」,占比仍是 1', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      bucket({
        upstreamModel: `m${i}`,
        inputTokens: 12 - i,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      })
    )
    const shares = toModelShares(many, 5)
    expect(shares).toHaveLength(6)
    expect(shares[shares.length - 1]?.key).toBe('__others__')
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1)
  })

  it('恰好等于上限时不产生「其他」', () => {
    const many = Array.from({ length: 5 }, (_, i) => bucket({ upstreamModel: `m${i}` }))
    expect(toModelShares(many, 5).some((s) => s.key === '__others__')).toBe(false)
  })

  it('同名模型跨供应商不合并,且标签补上供应商区分得开', () => {
    const shares = toModelShares([
      bucket({ providerId: 'p1', providerName: '甲' }),
      bucket({ providerId: 'p2', providerName: '乙' })
    ])
    expect(shares).toHaveLength(2)
    expect(shares.map((s) => s.label).sort()).toEqual(['alias-a · 乙', 'alias-a · 甲'])
  })

  it('没撞名就不补后缀', () => {
    const shares = toModelShares([bucket(), bucket({ upstreamModel: 'm2', alias: 'alias-b' })])
    expect(shares.map((s) => s.label).sort()).toEqual(['alias-a', 'alias-b'])
  })

  it('供应商名为空时退回供应商 id', () => {
    const shares = toModelShares([
      bucket({ providerId: 'p1', providerName: '' }),
      bucket({ providerId: 'p2', providerName: '' })
    ])
    expect(shares.map((s) => s.label).sort()).toEqual(['alias-a · p1', 'alias-a · p2'])
  })

  it('总量为零时占比是 0 而不是 NaN', () => {
    const shares = toModelShares([
      bucket({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    ])
    expect(shares[0]?.share).toBe(0)
  })

  it('空输入返回空数组', () => {
    expect(toModelShares([])).toEqual([])
  })
})

describe('toCostBreakdown', () => {
  it('按币种分组,组内占比各自加到 1', () => {
    const { groups } = toCostBreakdown([
      bucket({ currency: 'USD', costMicros: 3_000_000, upstreamModel: 'a' }),
      bucket({ currency: 'USD', costMicros: 1_000_000, upstreamModel: 'b' }),
      bucket({ currency: 'CNY', costMicros: 5_000_000, upstreamModel: 'c' })
    ])
    expect(groups.map((g) => g.currency).sort()).toEqual(['CNY', 'USD'])
    for (const group of groups) {
      expect(group.rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1)
    }
  })

  it('组内按金额降序', () => {
    const { groups } = toCostBreakdown([
      bucket({ costMicros: 1_000_000, upstreamModel: 'cheap' }),
      bucket({ costMicros: 9_000_000, upstreamModel: 'pricey' })
    ])
    expect(groups[0]?.rows[0]?.micros).toBe(9_000_000)
  })

  it('未计价的桶不进任何分组,但计入未计价请求数', () => {
    const result = toCostBreakdown([
      bucket({ costMicros: null, currency: '', pricedCount: 0, requestCount: 4 })
    ])
    expect(result.groups).toEqual([])
    expect(result.unpricedRequests).toBe(4)
  })

  it('部分计价时金额只含已计价行,差额进未计价数', () => {
    const result = toCostBreakdown([
      bucket({ costMicros: 2_000_000, requestCount: 10, pricedCount: 6 })
    ])
    expect(result.groups[0]?.totalMicros).toBe(2_000_000)
    expect(result.groups[0]?.rows[0]?.requests).toBe(6)
    expect(result.unpricedRequests).toBe(4)
  })

  it('合计等于组内各行之和', () => {
    const { groups } = toCostBreakdown([
      bucket({ costMicros: 1_500_000, upstreamModel: 'a' }),
      bucket({ costMicros: 2_500_000, upstreamModel: 'b' })
    ])
    expect(groups[0]?.totalMicros).toBe(4_000_000)
  })

  /*
   * ★ 三行同名不同数看起来像同一行被列重了,或者像哪儿算重了 ——
   * 本机库里 `gpt-6-astra` 就同时来自三个供应商。
   */
  it('跨供应商同名的费用行各自补上供应商', () => {
    const { groups } = toCostBreakdown([
      bucket({ providerId: 'p1', providerName: '甲', costMicros: 3_000_000 }),
      bucket({ providerId: 'p2', providerName: '乙', costMicros: 1_000_000 })
    ])
    expect(groups[0]?.rows.map((r) => r.label)).toEqual(['alias-a · 甲', 'alias-a · 乙'])
  })

  it('空输入返回空分组与零未计价', () => {
    expect(toCostBreakdown([])).toEqual({ groups: [], unpricedRequests: 0 })
  })
})

describe('totalsOf', () => {
  it('汇总各项并去重模型数', () => {
    const totals = totalsOf([
      bucket({ day: '2026-09-13' }),
      bucket({ day: '2026-09-14' }),
      bucket({ day: '2026-09-14', upstreamModel: 'model-b' })
    ])
    expect(totals.tokens).toBe(3000)
    expect(totals.requests).toBe(30)
    expect(totals.modelCount).toBe(2)
    expect(totals.costs).toEqual([{ currency: 'USD', micros: 3_000_000 }])
  })

  it('未计价请求数单独累计', () => {
    const totals = totalsOf([bucket({ requestCount: 10, pricedCount: 3 })])
    expect(totals.unpricedRequests).toBe(7)
  })

  it('空输入全零', () => {
    expect(totalsOf([])).toMatchObject({
      tokens: 0,
      requests: 0,
      costs: [],
      unpricedRequests: 0,
      modelCount: 0
    })
  })
})
