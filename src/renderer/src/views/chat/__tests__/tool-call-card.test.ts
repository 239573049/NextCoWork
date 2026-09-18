/**
 * 工具卡片的流式参数回归。
 *
 * 上游参数在 `tool_call_end` 前只是 JSON 前缀；这条用例钉住卡片会随前缀增长
 * 立即更新标题，而不是一直显示无参数兜底、等工具真正开始后才突然跳变。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { MAX_PARTIAL_JSON_CHARS } from '../partial-json'
import { ToolCallCard } from '../parts'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('ToolCallCard · 流式参数', () => {
  it('JSON 字符串尚未闭合时就用已到达字段实时更新标题', async () => {
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
    const render = async (input: string, call?: ToolCallState): Promise<void> => {
      await act(async () => root.render(createElement(I18nProvider, {
        initialLocale: 'zh-CN',
        children: createElement(ToolCallCard, { call, name: 'Read', input })
      })))
    }
    const cardText = (): string => {
      const card = container.querySelector('[data-testid="tool-call"]')
      if (card === null) throw new Error('工具卡片没有渲染')
      return card.textContent ?? ''
    }
    teardown = async () => {
      await act(async () => root.unmount())
      dom.window.close()
    }

    await render('{"file_path":"src/ren')
    expect(cardText()).toContain('读取 ren')
    const trigger = container.querySelector<HTMLButtonElement>('button')
    if (trigger === null) throw new Error('工具卡片按钮没有渲染')
    await act(async () => trigger.click())
    expect(cardText()).toContain('src/ren')

    await render('{"file_path":"src/renderer/src/App.ts')
    expect(cardText()).toContain('读取 App.ts')
    expect(cardText()).toContain('src/renderer/src/App.ts')

    await render('{"file_path":"src/orphan.ts', {
      callId: 'call-orphan',
      name: 'Read',
      input: undefined,
      status: 'running'
    })
    expect(cardText()).toContain('读取 orphan.ts')

    await render(`{"padding":"${'x'.repeat(MAX_PARTIAL_JSON_CHARS)}","file_path":"late.ts`)
    expect(cardText()).not.toContain('late.ts')

    await render('{"file_path":"src/other.ts', {
      callId: 'call-1',
      name: 'Read',
      input: { file_path: 'src/real.ts' },
      status: 'running'
    })
    expect(cardText()).toContain('读取 real.ts')
    expect(cardText()).not.toContain('other.ts')
  })
})
