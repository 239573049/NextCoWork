import { describe, expect, it } from 'vitest'
import { decideAfterHooks, decideBeforeHooks, type GateOutcome } from '../permission-decision'

/**
 * 权限判定的**顺序**。
 *
 * ★ 这个文件里最重要的一条是「deny 压得过 hook 的 allow」——
 *   钩子是这次改动里**唯一能把权限模型放宽**的路径，而放宽得不对
 *   不会报错、不会崩，只会在某一天变成一次本不该发生的执行。
 */

const ALLOW: GateOutcome = { kind: 'allow' }
const ASK: GateOutcome = { kind: 'ask' }
const NET_DENY: GateOutcome = { kind: 'deny', reason: '联网被关掉了' }
const NO_HOOK = { allow: false, ask: false }

describe('decideBeforeHooks · 钩子跑之前', () => {
  it('联网开关排第一 —— 一条 allow 规则也不该把用户关掉的开关重新打开', () => {
    expect(decideBeforeHooks(NET_DENY, null)).toEqual({ kind: 'deny', reason: '联网被关掉了' })
  })

  it('★ deny 桶命中直接拒绝，于是钩子根本不会被执行', () => {
    // 这一条的「证明」在类型里：调用方拿到 deny 就 return 了，物理上到不了跑钩子那步。
    const out = decideBeforeHooks(ALLOW, 'Bash(rm:*)')
    expect(out.kind).toBe('deny')
    expect(out.kind === 'deny' && out.reason).toContain('Bash(rm:*)')
  })

  it('都没命中就继续往下走', () => {
    expect(decideBeforeHooks(ALLOW, null)).toEqual({ kind: 'continue' })
    expect(decideBeforeHooks(ASK, null)).toEqual({ kind: 'continue' })
  })
})

describe('decideAfterHooks · 钩子跑之后', () => {
  const decide = (over: Partial<Parameters<typeof decideAfterHooks>[0]> = {}) =>
    decideAfterHooks({ gate: ASK, hook: NO_HOOK, askRule: null, allowRule: null, autoReview: false, ...over })

  it('钩子 deny 拒绝，并带上它给的理由', () => {
    expect(decide({ hook: { deny: '碰了生产库', allow: false, ask: false } }))
      .toEqual({ kind: 'deny', reason: '碰了生产库' })
  })

  it('★★ 钩子的 deny 压得过 allow 桶 —— 否则点过一次「以后都允许」就永久绕开了安全钩子', () => {
    expect(decide({ hook: { deny: '拦下', allow: false, ask: false }, allowRule: 'Bash(git status:*)' }))
      .toEqual({ kind: 'deny', reason: '拦下' })
  })

  it('★ 钩子的 deny 压得过档位放行', () => {
    expect(decide({ gate: ALLOW, hook: { deny: '拦下', allow: false, ask: false } }).kind).toBe('deny')
  })

  it('ask 桶压过钩子的 allow —— 它的用处正是把静默放行的操作捞回人眼前', () => {
    expect(decide({ hook: { allow: true, ask: false }, askRule: 'Bash' })).toEqual({ kind: 'prompt' })
  })

  it('ask 桶压过 allow 桶和档位', () => {
    expect(decide({ gate: ALLOW, askRule: 'Bash', allowRule: 'Bash' })).toEqual({ kind: 'prompt' })
  })

  it('钩子要求 ask 时，即使档位放行也要问人', () => {
    expect(decide({ gate: ALLOW, hook: { allow: false, ask: true } })).toEqual({ kind: 'prompt' })
  })

  it('钩子 allow 能放行一个本来要问的调用', () => {
    expect(decide({ gate: ASK, hook: { allow: true, ask: false } })).toEqual({ kind: 'allow' })
  })

  it('没有钩子时，档位放行就放行', () => {
    expect(decide({ gate: ALLOW })).toEqual({ kind: 'allow' })
  })

  it('没有钩子时，allow 桶命中就放行', () => {
    expect(decide({ allowRule: 'Bash(git status:*)' })).toEqual({ kind: 'allow' })
  })

  it('auto 档 + 破坏性 → 交给 AI 审核', () => {
    expect(decide({ autoReview: true })).toEqual({ kind: 'review' })
  })

  it('★ 强制问人时跳过 AI 审核 —— 用户明确要求看一眼，不该由模型代劳', () => {
    expect(decide({ autoReview: true, askRule: 'Bash' })).toEqual({ kind: 'prompt' })
    expect(decide({ autoReview: true, hook: { allow: false, ask: true } })).toEqual({ kind: 'prompt' })
  })

  it('什么都没命中 → 问人', () => {
    expect(decide()).toEqual({ kind: 'prompt' })
  })
})
