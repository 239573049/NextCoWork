import { act, createElement, useRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../../../../shared/agent/message'
import { I18nProvider } from '../../../i18n'
import { TurnNavigationRail } from '../TurnNavigationRail'
import type { ThreadRow } from '../thread-content'
import {
  threadTurnGroups,
  truncateTurnPreview,
  turnNavigationItems,
  type TurnNavigationItem
} from '../turn-navigation'

function textBlock(key: string, text: string): Extract<ThreadRow, { kind: 'assistant' }> {
  return {
    kind: 'assistant',
    key,
    blocks: [{
      key: `${key}:text`,
      part: { type: 'text', text },
      streaming: false,
      cursor: false
    }]
  }
}

describe('turn navigation projection', () => {
  it('maps one user prompt and all following output rows to one navigation item', () => {
    const first = userMessage('u1', [{ type: 'text', text: 'Inspect the navigation' }], 1)
    const second = userMessage('u2', [{ type: 'text', text: 'Then test it' }], 4)
    const rows: ThreadRow[] = [
      textBlock('welcome', 'Welcome'),
      { kind: 'user', key: first.id, message: first },
      textBlock('a1', 'The first answer'),
      textBlock('a1-after-tool', 'continues after a tool'),
      { kind: 'user', key: second.id, message: second },
      textBlock('a2', 'The second answer')
    ]

    const groups = threadTurnGroups(rows)
    const items = turnNavigationItems(groups, 'Attachment message')

    expect(groups).toHaveLength(3)
    expect(groups.flatMap((group) => group.rows.map((entry) => entry.row.key)))
      .toEqual(rows.map((row) => row.key))
    expect(items).toEqual([
      { id: 'u1', label: 'Inspect the navigation', description: 'The first answer continues after a tool' },
      { id: 'u2', label: 'Then test it', description: 'The second answer' }
    ])
  })

  it('uses file names or the localized fallback for prompts without text', () => {
    const file = userMessage('file', [{ type: 'file_ref', path: '/tmp/spec.md', name: 'spec.md' }], 1)
    const image = userMessage('image', [{ type: 'image', mime: 'image/png', dataRef: 'image' }], 2)
    const groups = threadTurnGroups([
      { kind: 'user', key: file.id, message: file },
      { kind: 'user', key: image.id, message: image }
    ])

    expect(turnNavigationItems(groups, 'Attachment message').map((item) => item.label))
      .toEqual(['spec.md', 'Attachment message'])
  })

  it('truncates Unicode previews without splitting a character', () => {
    expect(truncateTurnPreview('一二三四五六', 4)).toBe('一二三四…')
  })
})

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    toJSON: () => ({})
  }
}

function RailFixture({ items }: { items: readonly TurnNavigationItem[] }): ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  return createElement('div', { className: 'relative' },
    createElement('div', { ref: viewportRef, 'data-testid': 'viewport' },
      createElement('div', { ref: contentRef },
        ...items.map((item) => createElement('section', {
          key: item.id,
          'data-turn-navigation-id': item.id
        }, item.label))
      )
    ),
    createElement(TurnNavigationRail, { items, viewportRef, contentRef })
  )
}

describe('turn navigation rail', () => {
  it('previews a turn and scrolls its target to the viewport center', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    const resizeCallbacks: Array<() => void> = []
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

    const items: TurnNavigationItem[] = [
      { id: 'one', label: 'Question one', description: 'Answer one' },
      { id: 'two', label: 'Question two', description: 'Answer two' },
      { id: 'three', label: 'Question three', description: 'Answer three' }
    ]
    const container = document.getElementById('root')!
    const root = createRoot(container)

    try {
      await act(async () => root.render(createElement(I18nProvider, {
        initialLocale: 'en-US',
        children: createElement(RailFixture, { items })
      })))
      const viewport = container.querySelector<HTMLElement>('[data-testid="viewport"]')!
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 })
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 })
      Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 })
      viewport.getBoundingClientRect = () => rect(100, 300)
      const targets = container.querySelectorAll<HTMLElement>('[data-turn-navigation-id]')
      const targetRects = Array.from(targets, (target, index) => {
        const readRect = vi.fn(() => rect(100 + index * 400, 100))
        target.getBoundingClientRect = readRect
        return readRect
      })
      const scrollTo = vi.fn()
      Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })

      await act(async () => resizeCallbacks.forEach((callback) => callback()))
      const buttons = container.querySelectorAll<HTMLButtonElement>('[data-testid="turn-navigation-item"]')
      expect(buttons).toHaveLength(3)

      targetRects.forEach((readRect) => readRect.mockClear())
      await act(async () => {
        viewport.scrollTop = 350
        viewport.dispatchEvent(new dom.window.Event('scroll'))
      })
      expect(buttons[1]?.getAttribute('aria-current')).toBe('location')
      expect(targetRects.every((readRect) => readRect.mock.calls.length === 0)).toBe(true)
      viewport.scrollTop = 0

      await act(async () => buttons[1]?.focus())
      expect(document.querySelector('[data-testid="turn-navigation-preview"]')?.textContent)
        .toContain('Question two')
      expect(document.querySelector('[data-testid="turn-navigation-preview"]')?.textContent)
        .toContain('Answer two')

      await act(async () => buttons[1]?.click())
      expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'smooth' })
      expect(buttons[1]?.getAttribute('aria-current')).toBe('location')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})
