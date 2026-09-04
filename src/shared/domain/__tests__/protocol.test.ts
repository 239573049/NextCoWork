/**
 * 协议三态 ↔ 两个界面控件 —— 方案 §1.1。
 *
 * 这一对函数存在的全部理由是「不加字段」:多存一个 `family` 就多了一个
 * 会和 `protocol` 漂移的值。所以这里最该测的是**往返**,不是逐个分支。
 */
import { describe, expect, it } from 'vitest'
import type { UpstreamProtocol } from '../provider'
import { joinProtocol, splitProtocol } from '../provider'

const ALL: readonly UpstreamProtocol[] = ['anthropic', 'openai-chat', 'openai-responses']

describe('splitProtocol / joinProtocol', () => {
  /** ★ 三个值都能原样绕回来 —— 少一个值就是界面上翻个开关配置就丢了 */
  it('join(split(p)) === p,三个值都成立', () => {
    for (const p of ALL) {
      const { family, responses } = splitProtocol(p)
      expect(joinProtocol(family, responses), p).toBe(p)
    }
  })

  it('投影本身', () => {
    expect(splitProtocol('anthropic')).toEqual({ family: 'anthropic', responses: false })
    expect(splitProtocol('openai-chat')).toEqual({ family: 'openai', responses: false })
    expect(splitProtocol('openai-responses')).toEqual({ family: 'openai', responses: true })
  })

  /**
   * ★ 界面上那个 Responses 开关在切到 Anthropic 时藏起来但**状态还留着**
   * (用户切回 OpenAI 希望它还是原样),所以这个组合是正常交互的中间态,
   * 不是非法输入。返回 `anthropic` 而不是抛错。
   */
  it('family=anthropic 时忽略 responses,不抛错', () => {
    expect(joinProtocol('anthropic', true)).toBe('anthropic')
    expect(joinProtocol('anthropic', false)).toBe('anthropic')
  })

  it('翻一圈开关能回到原点(藏起来的状态没被清掉)', () => {
    // openai-responses → 切到 anthropic → 再切回 openai
    const start: UpstreamProtocol = 'openai-responses'
    const { responses } = splitProtocol(start)
    const parked = joinProtocol('anthropic', responses)
    expect(parked).toBe('anthropic')
    expect(joinProtocol('openai', responses)).toBe(start)
  })
})
