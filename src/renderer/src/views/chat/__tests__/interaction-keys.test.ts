import { describe, expect, it } from 'vitest'
import { isEditableTarget, isSelfHandlingButton, resolveRowKey } from '../interaction-keys'

const base = { count: 3, active: 0, inEditable: false, expanded: false }

describe('resolveRowKey', () => {
  it('数字键点名对应的行', () => {
    expect(resolveRowKey({ key: '2' }, base)).toEqual({ kind: 'activate', index: 1 })
  })

  it('越界的数字什么都不做,而不是退到最后一行', () => {
    // 退到最后一行意味着按错一个键就执行了另一个动作,而用户看不出发生过什么。
    expect(resolveRowKey({ key: '4' }, base)).toBeNull()
    expect(resolveRowKey({ key: '9' }, base)).toBeNull()
  })

  it('焦点在输入框里时数字还是数字', () => {
    expect(resolveRowKey({ key: '3' }, { ...base, inEditable: true })).toBeNull()
    expect(resolveRowKey({ key: 'ArrowDown' }, { ...base, inEditable: true })).toBeNull()
  })

  it('Cmd+数字留给外面的标签页切换', () => {
    expect(resolveRowKey({ key: '1', metaKey: true }, base)).toBeNull()
    expect(resolveRowKey({ key: '1', ctrlKey: true }, base)).toBeNull()
  })

  it('方向键在首尾绕圈', () => {
    expect(resolveRowKey({ key: 'ArrowDown' }, { ...base, active: 2 })).toEqual({ kind: 'activate', index: 0 })
    expect(resolveRowKey({ key: 'ArrowUp' }, { ...base, active: 0 })).toEqual({ kind: 'activate', index: 2 })
  })

  it('没有行可点名时导航键放行,但 Enter 照常执行', () => {
    // 纯问答题就是这个形状:一个输入框,零个选项行。
    const none = { ...base, count: 0 }
    expect(resolveRowKey({ key: '1' }, none)).toBeNull()
    expect(resolveRowKey({ key: 'ArrowDown' }, none)).toBeNull()
    expect(resolveRowKey({ key: 'Enter' }, none)).toEqual({ kind: 'run' })
  })

  describe('Enter', () => {
    it('行上的裸 Enter 执行高亮那一行', () => {
      expect(resolveRowKey({ key: 'Enter' }, base)).toEqual({ kind: 'run' })
    })

    it('输入框里的裸 Enter 是换行,Cmd/Ctrl+Enter 才提交', () => {
      const typing = { ...base, inEditable: true }
      expect(resolveRowKey({ key: 'Enter' }, typing)).toBeNull()
      expect(resolveRowKey({ key: 'Enter', metaKey: true }, typing)).toEqual({ kind: 'run' })
      expect(resolveRowKey({ key: 'Enter', ctrlKey: true }, typing)).toEqual({ kind: 'run' })
    })

    it('Shift+Enter 永远放行', () => {
      expect(resolveRowKey({ key: 'Enter', shiftKey: true }, base)).toBeNull()
      expect(resolveRowKey({ key: 'Enter', shiftKey: true, metaKey: true }, { ...base, inEditable: true })).toBeNull()
    })

    it('焦点在「取消」这类按钮上时让给那颗按钮', () => {
      expect(resolveRowKey({ key: 'Enter' }, { ...base, onOtherButton: true })).toBeNull()
    })
  })

  describe('Escape', () => {
    it('只在有展开区时收起', () => {
      expect(resolveRowKey({ key: 'Escape' }, { ...base, expanded: true })).toEqual({ kind: 'collapse' })
      // 没展开的时候不吞 Esc —— 外面可能还有个浮层等着它。
      expect(resolveRowKey({ key: 'Escape' }, base)).toBeNull()
    })

    it('输入框里的 Esc 也收起', () => {
      expect(resolveRowKey({ key: 'Escape' }, { ...base, inEditable: true, expanded: true }))
        .toEqual({ kind: 'collapse' })
    })
  })
})

describe('isEditableTarget', () => {
  it('认出输入类元素与 contenteditable', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'input' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('isSelfHandlingButton', () => {
  it('行自己的按钮不算 —— Enter 打在它们身上本来就是执行', () => {
    expect(isSelfHandlingButton({ tagName: 'BUTTON', dataset: { rowValue: 'approve_current' } })).toBe(false)
  })

  it('别的按钮和链接算', () => {
    expect(isSelfHandlingButton({ tagName: 'BUTTON', dataset: {} })).toBe(true)
    expect(isSelfHandlingButton({ tagName: 'A', dataset: {} })).toBe(true)
    expect(isSelfHandlingButton({ tagName: 'DIV', dataset: {} })).toBe(false)
  })
})
