import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../agent/event'
import {
  envelopeFirstSeq,
  hasSeqGap,
  isEventChannel,
  isInvokeChannel,
  isSendChannel,
  type AgentEventEnvelope
} from '../ipc/contract'

/**
 * 这一组测的是**两处代码之间的约定**,而不是某一处的行为:
 * 合批泵造信封时写 `seq: 最后一个事件的 seq`,session store 读信封时反推第一个。
 * 一个 ±1 的分歧不会让任何一边单独出错 —— 症状是每收一批就 attach 一次,
 * 看起来像网络抖动。
 */

const ev = (text: string): AgentEvent => ({
  type: 'stream',
  delta: { type: 'text_delta', index: 0, text }
})

/** 按合批泵的规则造信封:seq 是本批**最后一个**事件的序号。 */
const envelope = (lastSeq: number, count: number): AgentEventEnvelope => ({
  runId: 'r1',
  seq: lastSeq,
  events: Array.from({ length: count }, (_, i) => ev(String(lastSeq - count + 1 + i)))
})

describe('envelopeFirstSeq', () => {
  it('单事件批的首尾是同一个 seq', () => {
    expect(envelopeFirstSeq(envelope(1, 1))).toBe(1)
  })

  it('多事件批往回数', () => {
    // seq 5 结尾、3 个事件 → 3、4、5
    expect(envelopeFirstSeq(envelope(5, 3))).toBe(3)
  })
})

describe('hasSeqGap', () => {
  it('run 刚起步的第一批(lastSeq=0)不算缺口', () => {
    expect(hasSeqGap(envelope(3, 3), 0)).toBe(false)
  })

  it('紧接着的下一批不算缺口', () => {
    expect(hasSeqGap(envelope(5, 2), 3)).toBe(false)
  })

  it('★ 单事件批 —— off-by-one 最容易在这里现形', () => {
    // 非合批事件(工具起止、run_end)都是单独一批,所以这是最高频的形状。
    // 写成 `env.seq - env.events.length` 的话这里就会误报缺口,
    // 而多事件批反而看着正常 —— 于是「只有工具调用时才卡一下」。
    expect(hasSeqGap(envelope(1, 1), 0)).toBe(false)
    expect(hasSeqGap(envelope(2, 1), 1)).toBe(false)
  })

  it('中间少了一批 → 报缺口', () => {
    // 收到 1–3,然后直接来了 8:4–7 丢了(窗口曾无订阅者)
    expect(hasSeqGap(envelope(8, 1), 3)).toBe(true)
  })

  it('重复的批也报缺口 —— 这是故意的', () => {
    // attach 重放是幂等的,宁可多补一次也不要漏。
    // 想在这里分辨「重复」与「丢失」得维护一个已见 seq 集合,不值当。
    expect(hasSeqGap(envelope(5, 1), 5)).toBe(true)
  })

  it('★ 任意切分方式下都不该报缺口 —— 这才是与合批泵的真正契约', () => {
    // 泵按时间窗和块边界切批,批长完全不可预测。
    // 只要 seq 从 1 连续到 10,无论怎么切,渲染层都不该触发一次 attach。
    for (const sizes of [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [10], [1, 9], [3, 4, 2, 1], [5, 5]]) {
      let lastSeq = 0
      for (const n of sizes) {
        const env = envelope(lastSeq + n, n)
        expect(hasSeqGap(env, lastSeq), `切分 ${sizes.join('/')} 在 seq=${env.seq} 处误报`).toBe(
          false
        )
        lastSeq = env.seq
      }
      expect(lastSeq).toBe(10)
    }
  })
})

describe('频道白名单 —— preload 的运行时防线(方案 §3 规则 6)', () => {
  it('契约里的频道通过', () => {
    expect(isInvokeChannel('agent:run')).toBe(true)
    expect(isSendChannel('terminal:write')).toBe(true)
    expect(isEventChannel('agent:event')).toBe(true)
  })

  it('不在契约里的频道被拒', () => {
    expect(isInvokeChannel('agent:run ')).toBe(false)
    expect(isInvokeChannel('terminal:write')).toBe(false) // send 频道不能当 invoke 用
    expect(isSendChannel('agent:run')).toBe(false)
  })

  it('★ 原型链上的属性不算白名单 —— 用 in 写就会在这里破防', () => {
    // `'toString' in INVOKE_CHANNELS` 是 true。被攻破的渲染层
    // invoke('toString') 就能绕过校验;而在本架构里,绕过 preload
    // 等价于经工具层拿到任意文件系统访问。
    for (const proto of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(isInvokeChannel(proto), `${proto} 不该通过`).toBe(false)
      expect(isSendChannel(proto), `${proto} 不该通过`).toBe(false)
      expect(isEventChannel(proto), `${proto} 不该通过`).toBe(false)
    }
  })
})
