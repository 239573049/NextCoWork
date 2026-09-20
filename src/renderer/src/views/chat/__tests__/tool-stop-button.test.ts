/**
 * 工具卡片上那颗停止按钮的边界。
 *
 * 它钉的不是长相,是**什么时候不该出现**:画一颗按下去没反应的停止按钮,
 * 比没有按钮难解释得多 —— 用户会以为命令停了,然后等一个永远不会来的结果。
 * 三个条件缺一不可:这个工具真的能被停(presenter 的能力声明)、它此刻在跑、
 * 而且这棵树里真的接得到停止动作(只读面板没有 provider)。
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { ToolCallCard } from '../parts'
import { ToolStopProvider, type StopToolCall } from '../tool-stop'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

function mount(): { container: HTMLElement; render: (children: ReactNode) => Promise<void> } {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })

  const container = document.getElementById('root')!
  const root = createRoot(container)
  teardown = async () => {
    await act(async () => root.unmount())
    dom.window.close()
  }
  return {
    container,
    render: async (children) => {
      await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'zh-CN', children })))
    }
  }
}

const running = (name: string): ToolCallState => ({
  callId: 'call-1',
  name,
  input: { command: 'npm test' },
  status: 'running'
})

function card(name: string, call: ToolCallState, stop?: StopToolCall): ReactNode {
  const node = createElement(ToolCallCard, { call, name, input: call.input })
  return stop === undefined ? node : createElement(ToolStopProvider, { stop, children: node })
}

describe('ToolCallCard · 停止按钮', () => {
  it('运行中的 Bash 给出停止按钮,点击把 callId 交出去', async () => {
    const { container, render } = mount()
    const stop = vi.fn()
    await render(card('Bash', running('Bash'), stop))

    const button = container.querySelector<HTMLButtonElement>('[data-testid="tool-stop"]')
    if (button === null) throw new Error('停止按钮没有渲染')
    await act(async () => button.click())
    expect(stop).toHaveBeenCalledWith('call-1')
  })

  it('★ 点停止不会顺带展开卡片 —— 它是标题行的兄弟,不是它的子节点', async () => {
    const { container, render } = mount()
    await render(card('Bash', running('Bash'), vi.fn()))
    const button = container.querySelector<HTMLButtonElement>('[data-testid="tool-stop"]')!
    await act(async () => button.click())
    const header = container.querySelector<HTMLButtonElement>('[aria-expanded]')
    expect(header?.getAttribute('aria-expanded')).toBe('false')
  })

  it('★ 没有 provider(只读面板)时不画 —— 画了也停不掉', async () => {
    const { container, render } = mount()
    await render(card('Bash', running('Bash')))
    expect(container.querySelector('[data-testid="tool-stop"]')).toBeNull()
  })

  it('★ 停不掉的工具不画 —— 主进程只为 Bash 寄存停止句柄', async () => {
    const { container, render } = mount()
    await render(card('Read', { ...running('Read'), input: { file_path: 'a.ts' } }, vi.fn()))
    expect(container.querySelector('[data-testid="tool-stop"]')).toBeNull()
  })

  it('已经跑完的不画', async () => {
    const { container, render } = mount()
    await render(card('Bash', { ...running('Bash'), status: 'ok', output: { content: 'done' } }, vi.fn()))
    expect(container.querySelector('[data-testid="tool-stop"]')).toBeNull()
  })
})
