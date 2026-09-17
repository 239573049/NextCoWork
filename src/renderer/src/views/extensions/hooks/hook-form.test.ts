import { describe, expect, it } from 'vitest'
import { draftToUpsert, emptyHookDraft, validateHook, warnHook, type HookDraft } from './hook-form'

const draft = (over: Partial<HookDraft> = {}): HookDraft => ({
  ...emptyHookDraft('PreToolUse'),
  command: 'echo hi',
  timeoutSeconds: 10,
  ...over
})

describe('validateHook', () => {
  it('命令为空拦下', () => {
    expect(validateHook(draft({ command: '   ' }))).toBe('hooks.error.emptyCommand')
  })

  it('空 matcher 合法 —— 那是「每次都触发」', () => {
    expect(validateHook(draft({ matcher: '' }))).toBeNull()
  })

  it('权限规则语法的 matcher 合法', () => {
    expect(validateHook(draft({ matcher: 'Bash' }))).toBeNull()
    expect(validateHook(draft({ matcher: 'Write(src/*.ts)' }))).toBeNull()
  })

  it('写坏的 matcher 拦下', () => {
    expect(validateHook(draft({ matcher: 'Bash((((' }))).toBe('hooks.error.badMatcher')
  })

  it('超时必须是正数且不超上限', () => {
    expect(validateHook(draft({ timeoutSeconds: 0 }))).toBe('hooks.error.badTimeout')
    expect(validateHook(draft({ timeoutSeconds: -5 }))).toBe('hooks.error.badTimeout')
    expect(validateHook(draft({ timeoutSeconds: 601 }))).toBe('hooks.error.timeoutTooLong')
    expect(validateHook(draft({ timeoutSeconds: 600 }))).toBeNull()
  })
})

describe('warnHook', () => {
  it('★ 阻断型事件配前缀 matcher 要警告 —— 那条保护是给「放行」设计的，方向反了', () => {
    expect(warnHook(draft({ event: 'PreToolUse', matcher: 'Bash(rm:*)' }))).toBe('hooks.warn.weakMatcher')
  })

  it('非阻断事件不警告 —— 它本来也拦不住什么', () => {
    expect(warnHook(draft({ event: 'PostToolUse', matcher: 'Bash(rm:*)' }))).toBeNull()
    expect(warnHook(draft({ event: 'Stop', matcher: 'Bash(rm:*)' }))).toBeNull()
  })

  it('裸工具名不警告 —— 那正是拦整类调用的正确写法', () => {
    expect(warnHook(draft({ event: 'PreToolUse', matcher: 'Bash' }))).toBeNull()
  })

  it('精确 matcher 不警告', () => {
    expect(warnHook(draft({ event: 'PreToolUse', matcher: 'Write(src/a.ts)' }))).toBeNull()
  })
})

describe('prompt 型草稿', () => {
  const promptDraft = (over: Partial<HookDraft> = {}): HookDraft =>
    draft({ type: 'prompt', prompt: '达成了吗', ...over })

  it('prompt 为空拦下（此时 command 有没有填无关紧要）', () => {
    expect(validateHook(promptDraft({ prompt: '  ', command: 'echo hi' }))).toBe('hooks.error.emptyPrompt')
  })

  it('prompt 型不检查 command —— 它根本不跑命令', () => {
    expect(validateHook(promptDraft({ command: '' }))).toBeNull()
  })

  it('★ 只取一支：prompt 型不把用户改主意之前那条命令也发上去', () => {
    const upsert = draftToUpsert(promptDraft({ command: 'echo stale' }))
    expect(upsert).not.toHaveProperty('command')
    expect(upsert.type).toBe('prompt')
  })

  it('★ 没配别名时供应商不带上去 —— 单独一个供应商 id 配不出任何绑定', () => {
    expect(draftToUpsert(promptDraft({ model: '', modelProviderId: 'p1' }))).not.toHaveProperty('modelProviderId')
    expect(draftToUpsert(promptDraft({ model: 'sonnet', modelProviderId: 'p1' }))).toHaveProperty('modelProviderId', 'p1')
  })

  it('command 型草稿不把 prompt 发上去', () => {
    expect(draftToUpsert(draft({ prompt: '写了一半又切回来了' }))).not.toHaveProperty('prompt')
  })

  it('prompt 型的默认超时是 30 秒，命令型是事件各自那条', () => {
    expect(emptyHookDraft('Stop', 'prompt').timeoutSeconds).toBe(30)
    expect(emptyHookDraft('Stop').timeoutSeconds).toBe(60)
    expect(emptyHookDraft('PreToolUse').timeoutSeconds).toBe(10)
  })
})
