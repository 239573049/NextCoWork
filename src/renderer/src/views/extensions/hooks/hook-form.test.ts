import { describe, expect, it } from 'vitest'
import { validateHook, warnHook, type HookDraft } from './hook-form'

const draft = (over: Partial<HookDraft> = {}): HookDraft => ({
  event: 'PreToolUse',
  matcher: '',
  command: 'echo hi',
  timeoutSeconds: 10,
  description: '',
  enabled: true,
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
