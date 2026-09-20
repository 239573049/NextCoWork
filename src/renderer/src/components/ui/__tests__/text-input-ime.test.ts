/**
 * 输入框里那一次「组词回车」的回归 —— 钉的是「用输入法打完字按回车会变成两遍」。
 *
 * 出问题的不是某个纯函数,而是**事件本身该不该被当成提交**,所以只能在这一层测。
 * jsdom 里没有真输入法,但 `KeyboardEvent` 认 `isComposing` 这个初始化项,
 * 把那一帧事件原样递进去比开着应用切输入法手点可靠得多。
 *
 * ★ 要真 jsdom 环境,**不能照 `menu-position.test.ts` 手搓 JSDOM** —— 理由见
 *   `views/chat/__tests__/interaction-panel.test.ts` 的文件头:`react-dom` 在首次
 *   import 时就记下了「这个环境支不支持 input 事件」,手搓的 `document` 晚了一步。
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TextInput } from '../TextInput'

interface Harness {
  input: HTMLInputElement
  commit: ReturnType<typeof vi.fn>
  value: () => string
}

async function mount(): Promise<Harness> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const commit = vi.fn()
  let value = 'a'
  const render = (): void => {
    root.render(createElement(TextInput, {
      value,
      onChange: (next: string) => { value = next; render() },
      onCommit: commit,
      ariaLabel: 'field'
    }))
  }
  await act(async () => render())
  const input = container.querySelector('input')!
  // 焦点必须在,否则 `blur()` 那条路径无从观察
  await act(async () => input.focus())
  return { input, commit, value: () => value }
}

/** 往受控输入框里写字。必须绕开 React 装在实例上的值追踪器,否则它看不出变化。 */
async function setValue(h: Harness, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(h.input, text)
    h.input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 组词:先把组词串写进框里,再补一次「上屏」的输入,和真输入法一个次序。 */
async function type(h: Harness, composing: string, committed: string): Promise<void> {
  await setValue(h, composing)
  await setValue(h, committed)
}

async function pressEnter(h: Harness, isComposing: boolean): Promise<void> {
  await act(async () => {
    h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true }))
  })
}

describe('TextInput · 输入法组词期间的回车', () => {
  it('组词中的回车只上屏:不提交,也不把焦点抽走', async () => {
    const h = await mount()
    await type(h, 'ceshi', '测试')
    await pressEnter(h, true)
    expect(h.value()).toBe('测试')
    expect(h.commit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(h.input)
  })

  it('上屏之后再按一次回车才提交并失焦', async () => {
    const h = await mount()
    await type(h, 'ceshi', '测试')
    await pressEnter(h, true)
    expect(h.commit).not.toHaveBeenCalled()
    await pressEnter(h, false)
    expect(h.commit).toHaveBeenCalled()
    expect(document.activeElement).not.toBe(h.input)
  })
})
