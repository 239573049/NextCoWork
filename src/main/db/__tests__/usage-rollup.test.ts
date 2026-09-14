import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageAttemptRecord } from '../../../shared/domain/usage'
import { closeDatabase, openDatabase, stmt } from '../index'
import { recordUsageAttempt, updateUsageToolsForRun } from '../repo'
import {
  dayBoundsLocal,
  getUsageActivityStats,
  getUsageDailySeries,
  localDayOf,
  refreshUsageRollup
} from '../usage-rollup'

let directory = ''

beforeEach(() => {
  closeDatabase()
  directory = mkdtempSync(join(tmpdir(), 'nextcowork-rollup-'))
  openDatabase(directory)
})

afterEach(() => {
  closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60 * 1000

/** 固定在当天正午,避免用例在本地时间接近零点时跨到另一天。 */
function noonAgo(days: number): number {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.getTime() - days * DAY
}

function attempt(
  id: string,
  at: number,
  patch: Partial<UsageAttemptRecord> = {}
): UsageAttemptRecord {
  return {
    id,
    at,
    runId: `run-${id}`,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    attempt: 1,
    providerId: 'provider-1',
    providerName: 'Provider One',
    protocol: 'anthropic',
    endpoint: 'https://provider.example/v1/messages',
    alias: 'assistant',
    upstreamModel: 'model-a',
    responseModel: 'model-a-20260901',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 10,
    thinkingTokens: 5,
    thinkingTokensEstimated: false,
    latencyMs: 1_200,
    timeToFirstTokenMs: 250,
    ok: true,
    httpStatus: 200,
    errorKind: null,
    errorMessage: null,
    stopReason: 'end_turn',
    costMicros: 1_500_000,
    currency: 'USD',
    pricingTier: 0,
    pricingWindow: null,
    toolCalls: 2,
    toolErrors: 0,
    ...patch
  }
}

/**
 * 直接对原表做同样的聚合。**这才是被测对象的参照系** —— 汇总表的唯一正确性标准
 * 就是「和直查原表算出来的一样」。
 */
function directAggregate(day: string): Record<string, unknown>[] {
  const { from, to } = dayBoundsLocal(day)
  return stmt(
    `SELECT provider_id,
            upstream_model,
            COALESCE(currency, '') AS currency,
            COUNT(*)               AS request_count,
            SUM(ok)                AS success_count,
            SUM(input_tokens)      AS input_tokens,
            SUM(output_tokens)     AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cost_micros)       AS cost_micros,
            COUNT(cost_micros)     AS priced_count
       FROM usage_records
      WHERE at >= ? AND at < ?
      GROUP BY provider_id, upstream_model, COALESCE(currency, '')
      ORDER BY upstream_model, currency`
  ).all(from, to)
}

function bucketsOf(day: string): Record<string, unknown>[] {
  return stmt(
    `SELECT provider_id, upstream_model, currency,
            request_count, success_count,
            input_tokens, output_tokens, cache_read_tokens,
            cost_micros, priced_count
       FROM usage_daily
      WHERE day = ?
      ORDER BY upstream_model, currency`
  ).all(day)
}

describe('refreshUsageRollup', () => {
  it('汇总结果与直查原表一致', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0)))
    recordUsageAttempt(attempt('a2', noonAgo(0), { upstreamModel: 'model-b', outputTokens: 99 }))
    recordUsageAttempt(attempt('a3', noonAgo(0), { ok: false, costMicros: null, currency: null }))

    refreshUsageRollup()

    expect(bucketsOf(today)).toEqual(directAggregate(today))
  })

  it('重复刷新不改变结果(幂等)', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0)))
    recordUsageAttempt(attempt('a2', noonAgo(0)))

    refreshUsageRollup()
    const first = bucketsOf(today)
    refreshUsageRollup()
    refreshUsageRollup()

    expect(bucketsOf(today)).toEqual(first)
    expect(first[0]?.['request_count']).toBe(2)
  })

  /*
   * 这是整张表的设计前提。`usage_records.id` 是 ulid(endedAt) —— 写入时刻,
   * 而 `at` 是 startedAt。一个慢请求的 id 大于水位、at 却落在好几天前。
   * 按 `at > 水位` 取增量的实现会把这条账永久漏掉,且只表现为「那天的钱少一点」。
   */
  it('乱序到达的旧记录会被重算进正确的那一天', () => {
    const oldDay = localDayOf(noonAgo(5))
    recordUsageAttempt(attempt('a1', noonAgo(5)))
    refreshUsageRollup()
    expect(bucketsOf(oldDay)[0]?.['request_count']).toBe(1)

    // id 更大(写入更晚),at 却仍在 5 天前那一天
    recordUsageAttempt(attempt('z9', noonAgo(5) + 60_000, { outputTokens: 7 }))
    refreshUsageRollup()

    expect(bucketsOf(oldDay)).toEqual(directAggregate(oldDay))
    expect(bucketsOf(oldDay)[0]?.['request_count']).toBe(2)
  })

  it('按天分桶,不同日期互不串味', () => {
    recordUsageAttempt(attempt('a1', noonAgo(3)))
    recordUsageAttempt(attempt('a2', noonAgo(1)))
    recordUsageAttempt(attempt('a3', noonAgo(1)))
    refreshUsageRollup()

    expect(bucketsOf(localDayOf(noonAgo(3)))[0]?.['request_count']).toBe(1)
    expect(bucketsOf(localDayOf(noonAgo(1)))[0]?.['request_count']).toBe(2)
  })

  it('整桶未计价时 cost_micros 是 NULL,不是 0', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0), { costMicros: null, currency: null }))
    refreshUsageRollup()

    const row = bucketsOf(today)[0]
    expect(row?.['cost_micros']).toBeNull()
    expect(row?.['priced_count']).toBe(0)
    expect(row?.['currency']).toBe('')
  })

  it('真的免费(0)与未知(NULL)分得开', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0), { costMicros: 0, currency: 'USD' }))
    refreshUsageRollup()

    const row = bucketsOf(today)[0]
    expect(row?.['cost_micros']).toBe(0)
    expect(row?.['priced_count']).toBe(1)
  })

  it('同一桶内部分计价:金额只含已计价行,priced_count 小于 request_count', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0), { costMicros: 2_000_000 }))
    recordUsageAttempt(attempt('a2', noonAgo(0), { costMicros: null, currency: 'USD' }))
    refreshUsageRollup()

    const row = bucketsOf(today)[0]
    expect(row?.['cost_micros']).toBe(2_000_000)
    expect(row?.['priced_count']).toBe(1)
    expect(row?.['request_count']).toBe(2)
  })

  // 跨币种相加得到的是一个没有单位的数字,比不显示更糟
  it('不同币种分成不同的桶,绝不相加', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0), { costMicros: 1_000_000, currency: 'USD' }))
    recordUsageAttempt(attempt('a2', noonAgo(0), { costMicros: 7_000_000, currency: 'CNY' }))
    refreshUsageRollup()

    const rows = bucketsOf(today)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r['currency'], r['cost_micros']]).sort()).toEqual([
      ['CNY', 7_000_000],
      ['USD', 1_000_000]
    ])
  })

  /*
   * ★ 未计价行的 currency 在原表里是 NULL。汇总表用空串是因为 SQLite 主键中的
   * NULL 不参与唯一性判定 —— 若照搬 NULL,同一天同一模型的未计价行会反复插入
   * 而不是合并成一行,表会随刷新次数膨胀。
   */
  it('未计价行合并成一行而不是每次刷新多一行', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0), { costMicros: null, currency: null }))
    recordUsageAttempt(attempt('a2', noonAgo(0), { costMicros: null, currency: null }))
    refreshUsageRollup()
    refreshUsageRollup()

    const rows = bucketsOf(today)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['request_count']).toBe(2)
  })

  /*
   * 工具计数由 updateUsageToolsForRun 在 run 结束后**回写历史行**。汇总表
   * 因此刻意不存这两列 —— 存了就必然在某些刷新时机下偏小。这条用例钉住
   * 「回写之后重算,其它数字依然与直查一致」。
   */
  it('工具计数回写之后,汇总仍与直查一致', () => {
    const today = localDayOf(noonAgo(0))
    recordUsageAttempt(attempt('a1', noonAgo(0)))
    refreshUsageRollup()

    updateUsageToolsForRun('run-a1', 11, 3)
    refreshUsageRollup()

    expect(bucketsOf(today)).toEqual(directAggregate(today))
  })

  it('空库刷新不报错', () => {
    expect(() => refreshUsageRollup()).not.toThrow()
    expect(getUsageDailySeries({ to: Date.now() })).toEqual([])
  })
})

describe('getUsageDailySeries', () => {
  it('按日期升序,并受时间窗约束', () => {
    recordUsageAttempt(attempt('a1', noonAgo(10)))
    recordUsageAttempt(attempt('a2', noonAgo(3)))
    recordUsageAttempt(attempt('a3', noonAgo(0)))
    refreshUsageRollup()

    const all = getUsageDailySeries({ to: Date.now() })
    expect(all.map((b) => b.day)).toEqual([
      localDayOf(noonAgo(10)),
      localDayOf(noonAgo(3)),
      localDayOf(noonAgo(0))
    ])

    const recent = getUsageDailySeries({ from: noonAgo(4), to: Date.now() })
    expect(recent.map((b) => b.day)).toEqual([localDayOf(noonAgo(3)), localDayOf(noonAgo(0))])
  })

  it('字段完整映射到领域对象', () => {
    recordUsageAttempt(attempt('a1', noonAgo(0)))
    refreshUsageRollup()

    const [bucket] = getUsageDailySeries({ to: Date.now() })
    expect(bucket).toMatchObject({
      providerId: 'provider-1',
      providerName: 'Provider One',
      upstreamModel: 'model-a',
      alias: 'assistant',
      currency: 'USD',
      requestCount: 1,
      successCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      cacheWrite1hTokens: 10,
      thinkingTokens: 5,
      costMicros: 1_500_000,
      pricedCount: 1,
      latencySum: 1_200,
      ttftSum: 250,
      ttftCount: 1
    })
  })

  it('缺失的 ttft 不计入 count,跨桶平均才不会被稀释', () => {
    recordUsageAttempt(attempt('a1', noonAgo(0), { timeToFirstTokenMs: 400 }))
    recordUsageAttempt(attempt('a2', noonAgo(0), { timeToFirstTokenMs: null }))
    refreshUsageRollup()

    const [bucket] = getUsageDailySeries({ to: Date.now() })
    expect(bucket?.ttftSum).toBe(400)
    expect(bucket?.ttftCount).toBe(1)
  })
})

describe('getUsageActivityStats', () => {
  it('活跃日与连续天数来自汇总表', () => {
    recordUsageAttempt(attempt('a1', noonAgo(2)))
    recordUsageAttempt(attempt('a2', noonAgo(1)))
    recordUsageAttempt(attempt('a3', noonAgo(0)))
    refreshUsageRollup()

    const stats = getUsageActivityStats()
    expect(stats.activeDays).toEqual([
      localDayOf(noonAgo(2)),
      localDayOf(noonAgo(1)),
      localDayOf(noonAgo(0))
    ])
    expect(stats.currentStreak).toBe(3)
    expect(stats.longestStreak).toBe(3)
  })

  it('峰值取单日 token 总量最大的那天', () => {
    recordUsageAttempt(attempt('a1', noonAgo(2), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    recordUsageAttempt(attempt('a2', noonAgo(1), { inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    refreshUsageRollup()

    const stats = getUsageActivityStats()
    expect(stats.peakDay).toBe(localDayOf(noonAgo(1)))
    expect(stats.peakDayTokens).toBe(1000)
  })

  it('空库返回零值而不是抛错', () => {
    const stats = getUsageActivityStats()
    expect(stats).toMatchObject({
      activeDays: [],
      currentStreak: 0,
      longestStreak: 0,
      peakDayTokens: 0,
      peakDay: null,
      longestChatMs: 0
    })
  })
})
