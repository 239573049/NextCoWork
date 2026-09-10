import { describe, expect, it } from 'vitest'
import {
  durationOf,
  elapsedOf,
  formatCallDuration,
  formatDuration,
  formatTokensPerSecond,
  runDurationOf,
  tokensPerSecond,
  totalDuration
} from '../agent/duration'
import type { AgentEvent } from '../agent/event'
import { applyEvents, emptyTranscript } from '../agent/transcript'

/**
 * 耗时这一层的 bug 全是「显示出来才发现」的那种:`1m60s`、`0.0s`、
 * 运行中的工具右边闪出一个耗时。它们都不会让任何东西崩溃,
 * 所以只能靠单测在合入前拦住。
 */

describe('durationOf', () => {
  it('两头齐全时是差值', () => {
    expect(durationOf({ startedAt: 1000, endedAt: 3400 })).toBe(2400)
  })

  it('★ 只有 startedAt(还在跑)返回 undefined,不是 0', () => {
    // 返回 0 会让运行中的工具右侧显示 "<0.1s",看着像已经跑完
    expect(durationOf({ startedAt: 1000 })).toBeUndefined()
  })

  it('★ 旧转录两个字段都没有 → undefined,UI 据此不显示耗时', () => {
    expect(durationOf({})).toBeUndefined()
  })

  it('只有 endedAt(start 事件丢了)也返回 undefined', () => {
    expect(durationOf({ endedAt: 3400 })).toBeUndefined()
  })

  it('时钟回拨算出负数时夹到 0,而不是显示 -3.2s', () => {
    expect(durationOf({ startedAt: 5000, endedAt: 1800 })).toBe(0)
  })
})

describe('elapsedOf', () => {
  it('运行中按传入的 now 算,不读系统时钟', () => {
    expect(elapsedOf({ startedAt: 1000 }, 4000)).toBe(3000)
  })

  it('已结束时忽略 now,回落到 durationOf', () => {
    expect(elapsedOf({ startedAt: 1000, endedAt: 2000 }, 999_999)).toBe(1000)
  })

  it('没有 startedAt 时无从计算', () => {
    expect(elapsedOf({}, 4000)).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('★ 亚 100ms 显示 <0.1s —— 不是 0.0s', () => {
    expect(formatDuration(0)).toBe('<0.1s')
    expect(formatDuration(99)).toBe('<0.1s')
  })

  it('10s 以内保留一位小数', () => {
    expect(formatDuration(900)).toBe('0.9s')
    expect(formatDuration(1240)).toBe('1.2s')
    expect(formatDuration(9949)).toBe('9.9s')
  })

  it('10s 以上取整', () => {
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(45_600)).toBe('46s')
  })

  it('★ 59_990ms 进位成 1m0s,不显示 "60s"', () => {
    expect(formatDuration(59_990)).toBe('1m0s')
  })

  it('分钟档', () => {
    expect(formatDuration(65_000)).toBe('1m5s')
    expect(formatDuration(600_000)).toBe('10m0s')
  })

  it('★ 119_500ms 进位成 2m0s,不显示 "1m60s"', () => {
    expect(formatDuration(119_500)).toBe('2m0s')
  })

  it('超过一小时降级成 h/m', () => {
    expect(formatDuration(3_600_000)).toBe('1h0m')
    expect(formatDuration(7_930_000)).toBe('2h12m')
  })

  it('非法输入不抛异常', () => {
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('totalDuration', () => {
  it('累计各段,算不出的按 0 计入', () => {
    const total = totalDuration([
      { startedAt: 0, endedAt: 1000 },
      { startedAt: 5, endedAt: 2005 },
      { startedAt: 100 }, // 还在跑
      {} // 旧数据
    ])
    expect(total).toBe(3000)
  })

  it('空组是 0', () => {
    expect(totalDuration([])).toBe(0)
  })
})

describe('runDurationOf', () => {
  it('prefers explicit run bounds, including time spent thinking or waiting', () => {
    expect(runDurationOf({ runStartedAt: 1_000, runEndedAt: 12_000 }, [
      { startedAt: 2_000, endedAt: 3_000 }
    ])).toBe(11_000)
  })

  it('falls back to the first and last completed tool timestamps', () => {
    expect(runDurationOf({}, [
      { startedAt: 2_000, endedAt: 3_000 },
      { startedAt: 4_000, endedAt: 8_500 }
    ])).toBe(6_500)
  })

  it('returns undefined when an old run has no usable timing data', () => {
    expect(runDurationOf({}, [{ startedAt: 2_000 }])).toBeUndefined()
  })
})

describe('tokensPerSecond', () => {
  it('总输出除以 Σ 上游耗时 —— 按 token 加权,不是把每次请求的 TPS 再平均', () => {
    // 两次请求:800 token / 4s 与 5 token / 1s。逐次平均是 (200+5)/2 = 102.5,
    // 那个数被那句「好的」整个带偏了;真实速度是 805/5s = 161。
    expect(tokensPerSecond(805, 5_000)).toBeCloseTo(161, 5)
  })

  it('分母只含等模型的时间,所以跑了半分钟工具的一轮不会显示成模型变慢了', () => {
    // 同样是 701 token:整轮墙钟 8.1s 会算出 86.5,而模型实际只说了 5.46s 的话
    expect(tokensPerSecond(701, 5_460)).toBeCloseTo(128.4, 1)
  })

  it('缺耗时、耗时为 0、没产出 token 都算不出速度,一律 undefined', () => {
    expect(tokensPerSecond(100, undefined)).toBeUndefined()
    expect(tokensPerSecond(100, 0)).toBeUndefined()
    expect(tokensPerSecond(0, 5_000)).toBeUndefined()
    expect(tokensPerSecond(100, Number.NaN)).toBeUndefined()
  })
})

describe('formatTokensPerSecond', () => {
  it('三位数取整,两位数以下留一位小数', () => {
    expect(formatTokensPerSecond(128.44)).toBe('128')
    expect(formatTokensPerSecond(99.94)).toBe('99.9')
    expect(formatTokensPerSecond(3.25)).toBe('3.3')
  })
})

describe('transcript 打戳', () => {
  const start = (at?: number): AgentEvent => ({
    type: 'tool_start',
    callId: 'c1',
    toolName: 'read_file',
    input: { path: 'a.ts' },
    ...(at === undefined ? {} : { at })
  })
  const end = (at?: number): AgentEvent => ({
    type: 'tool_end',
    callId: 'c1',
    output: { content: 'ok' },
    isError: false,
    ...(at === undefined ? {} : { at })
  })

  it('★ start → end 之后能算出耗时', () => {
    const s = applyEvents(emptyTranscript(), [start(1_000), end(3_500)])
    const call = s.tools['c1']
    expect(call).toBeDefined()
    expect(durationOf(call!)).toBe(2500)
    expect(formatCallDuration(call!)).toBe('2.5s')
  })

  it('事件不带 at 时退化到 Date.now(),仍能算出一个非负耗时', () => {
    const s = applyEvents(emptyTranscript(), [start(), end()])
    const call = s.tools['c1']!
    expect(call.startedAt).toBeTypeOf('number')
    expect(call.endedAt).toBeTypeOf('number')
    expect(durationOf(call)).toBeGreaterThanOrEqual(0)
  })

  it('★ 只有 start 时 durationOf 是 undefined —— 运行中不显示耗时', () => {
    const s = applyEvents(emptyTranscript(), [start(1_000)])
    expect(durationOf(s.tools['c1']!)).toBeUndefined()
  })

  it('★ tool_end 先于 tool_start 到达时,补出的 base 没有 startedAt → 不显示耗时', () => {
    // reducer 里那条 `prev ?? {...}` 兜底路径:不能因为缺 start 就算出一个假耗时
    const s = applyEvents(emptyTranscript(), [end(3_500)])
    const call = s.tools['c1']!
    expect(call.name).toBe('(unknown)')
    expect(call.endedAt).toBe(3_500)
    expect(durationOf(call)).toBeUndefined()
  })

  it('tool_progress 不影响已打的 startedAt', () => {
    const s = applyEvents(emptyTranscript(), [
      start(1_000),
      { type: 'tool_progress', callId: 'c1', progress: { callId: 'c1', message: '读取中' } },
      end(2_000)
    ])
    expect(durationOf(s.tools['c1']!)).toBe(1000)
  })
})
