/**
 * 这组用例里第一条在抽取之前是**红的** —— 旧实现返回 `⌘+N`。
 * 所以它同时是回归测试和那个 bug 的墓志铭。
 */
import { describe, expect, it } from 'vitest'
import { acceleratorFromKeyboardEvent, matchesAccelerator, prettyAccelerator } from '../accelerator'

describe('prettyAccelerator', () => {
  it('mac 上修饰键紧贴,不留 +', () => {
    expect(prettyAccelerator('CmdOrCtrl+N', true)).toBe('⌘N')
    expect(prettyAccelerator('CmdOrCtrl+,', true)).toBe('⌘,')
    expect(prettyAccelerator('Alt+CmdOrCtrl+N', true)).toBe('⌥⌘N')
    expect(prettyAccelerator('CmdOrCtrl+Shift+P', true)).toBe('⌘⇧P')
  })

  it('非 mac 保留单词与 +', () => {
    expect(prettyAccelerator('CmdOrCtrl+N', false)).toBe('Ctrl+N')
    expect(prettyAccelerator('Alt+CmdOrCtrl+N', false)).toBe('Alt+Ctrl+N')
    expect(prettyAccelerator('CmdOrCtrl+,', false)).toBe('Ctrl+,')
  })

  it('键位本身是加号时不被 split 吃掉', () => {
    expect(prettyAccelerator('CmdOrCtrl++', true)).toBe('⌘+')
    expect(prettyAccelerator('CmdOrCtrl++', false)).toBe('Ctrl++')
  })

  it('未知词原样透传,undefined 透传', () => {
    expect(prettyAccelerator('CmdOrCtrl+Enter', true)).toBe('⌘Enter')
    expect(prettyAccelerator(undefined)).toBeUndefined()
  })
})

describe('keyboard accelerator recording', () => {
  const event = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides }) as KeyboardEvent

  it('records punctuation from the physical key code', () => {
    expect(acceleratorFromKeyboardEvent(event({ key: ',', code: 'Comma', metaKey: true }))).toBe('CmdOrCtrl+,')
    expect(acceleratorFromKeyboardEvent(event({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }))).toBe('CmdOrCtrl+Shift+,')
  })

  it('matches the saved accelerator', () => {
    expect(matchesAccelerator('CmdOrCtrl+,', event({ key: ',', code: 'Comma', ctrlKey: true }))).toBe(true)
    expect(matchesAccelerator('CmdOrCtrl+,', event({ key: '.', code: 'Period', ctrlKey: true }))).toBe(false)
  })
})
