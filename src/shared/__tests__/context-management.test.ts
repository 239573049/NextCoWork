/**
 * 有效窗口这一层原本**零覆盖** —— 它之前不存在,`contextWindow` 一个数同时回答
 * 三个问题。这组用例钉住的是「哪个数在管压缩」这件事,不是锦上添花。
 */
import { describe, expect, it } from 'vitest'
import {
  effectiveContextWindow,
  formatContextWindow,
  longContextTickRatio,
  supportsMaxContext,
  FALLBACK_CONTEXT_WINDOW,
  LONG_CONTEXT_THRESHOLD
} from '../agent/context-management'
import { findPricing, longContextSurcharge } from '../domain/pricing'
import { PRICING_SEED } from '../domain/pricing-seed'

const SOL = 1_050_000

describe('effectiveContextWindow', () => {
  it('关着开关时把超大窗口夹到计费分界 —— 整个方案的核心不变式', () => {
    expect(effectiveContextWindow(SOL, false)).toBe(LONG_CONTEXT_THRESHOLD)
  })

  it('开着开关时放开到模型的协议窗口', () => {
    expect(effectiveContextWindow(SOL, true)).toBe(SOL)
  })

  it('本来就比分界小的窗口不受影响', () => {
    expect(effectiveContextWindow(200_000, false)).toBe(200_000)
  })

  /*
    ★ 这一条是「切模型时不 normalize maxContext」那条设计的安全性依据:
    开关留着 true 切到一个小窗口模型,得到的仍然是 200K,而不是被放大。
    如果这条挂了,那个设计就必须改成切模型时抹掉开关。
  */
  it('开着开关也不会把小窗口放大', () => {
    expect(effectiveContextWindow(200_000, true)).toBe(200_000)
  })

  it('缺失 / 非法的协议窗口一律落到保守兜底', () => {
    expect(effectiveContextWindow(undefined, false)).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(effectiveContextWindow(0, true)).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(effectiveContextWindow(Number.NaN, false)).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(effectiveContextWindow(-1, true)).toBe(FALLBACK_CONTEXT_WINDOW)
  })

  it('默认参数等价于关着开关', () => {
    expect(effectiveContextWindow(SOL)).toBe(LONG_CONTEXT_THRESHOLD)
  })
})

describe('supportsMaxContext', () => {
  it('协议窗口大于分界才有得开', () => {
    expect(supportsMaxContext(SOL)).toBe(true)
    expect(supportsMaxContext(400_000)).toBe(true)
  })

  it('恰好等于分界算不支持 —— 开了也不会多出一个 token', () => {
    expect(supportsMaxContext(LONG_CONTEXT_THRESHOLD)).toBe(false)
  })

  it('小窗口和未知模型都不支持', () => {
    expect(supportsMaxContext(200_000)).toBe(false)
    expect(supportsMaxContext(undefined)).toBe(false)
  })
})

describe('longContextTickRatio', () => {
  it('开着开关时给出 272K 在环上的位置', () => {
    expect(longContextTickRatio(SOL, true)).toBeCloseTo(272_000 / 1_050_000, 4)
  })

  it('关着开关时没有刻度 —— 分母就是分界本身,刻度会落在终点', () => {
    expect(longContextTickRatio(SOL, false)).toBeUndefined()
    expect(longContextTickRatio(LONG_CONTEXT_THRESHOLD, true)).toBeUndefined()
    expect(longContextTickRatio(200_000, true)).toBeUndefined()
  })
})

describe('formatContextWindow', () => {
  it('K / M 两档,且不要求整除', () => {
    expect(formatContextWindow(272_000)).toBe('272K')
    expect(formatContextWindow(1_050_000)).toBe('1.05M')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(200_000)).toBe('200K')
  })

  it('非法值给一个破折号,不给 0', () => {
    expect(formatContextWindow(0)).toBe('—')
    expect(formatContextWindow(Number.NaN)).toBe('—')
  })
})

describe('计费分界常量', () => {
  /*
    ★ 两个数分开维护迟早分叉,而分叉的表现是「圆环刻度画错了地方」——
    没有任何人会发现。这条用例是它们之间唯一的连接。
  */
  it('LONG_CONTEXT_THRESHOLD 与种子表里 OpenAI 现代四款的第一档上界一致', () => {
    const sol = findPricing(PRICING_SEED, null, 'gpt-5.6-sol', Date.parse('2026-01-01T00:00:00Z'))
    expect(sol?.tiers[0]?.upToInputTokens).toBe(LONG_CONTEXT_THRESHOLD)
  })

  it('倍率不对称:输入 ×2、输出 ×1.5 —— 界面文案不能写死一个数', () => {
    const s = longContextSurcharge(PRICING_SEED, null, 'gpt-5.6-terra', Date.parse('2026-01-01T00:00:00Z'))
    expect(s?.threshold).toBe(LONG_CONTEXT_THRESHOLD)
    expect(s?.inputMultiplier).toBeCloseTo(2, 5)
    expect(s?.outputMultiplier).toBeCloseTo(1.5, 5)
  })

  it('查不到的模型返回 undefined,不编一个 1', () => {
    expect(longContextSurcharge(PRICING_SEED, null, 'not-a-real-model', Date.now())).toBeUndefined()
  })
})
