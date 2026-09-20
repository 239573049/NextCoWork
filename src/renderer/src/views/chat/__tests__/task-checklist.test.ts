/**
 * TaskChecklist 的 DOM 契约：真实 Todo 状态必须逐项保留，收起只改变展示，不能改写任务。
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../i18n'
import { TaskChecklist } from '../TaskChecklist'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('TaskChecklist · real task state', () => {
  it('keeps pending, running and completed rows while the panel is collapsed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    teardown = async () => {
      await act(async () => root.unmount())
      container.remove()
    }

    await act(async () => root.render(createElement(I18nProvider, {
      initialLocale: 'en-US',
      children: createElement(TaskChecklist, {
        todos: [
          { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
          { content: 'Update UI', activeForm: 'Updating UI', status: 'in_progress' },
          { content: 'Run tests', activeForm: 'Running tests', status: 'pending' }
        ]
      })
    })))

    expect([...container.querySelectorAll('[data-task-status]')].map((row) => row.getAttribute('data-task-status')))
      .toEqual(['completed', 'in_progress', 'pending'])
    expect(container.textContent).toContain('Updating UI')

    const toggle = container.querySelector<HTMLButtonElement>('[aria-controls]')
    expect(toggle).not.toBeNull()
    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    const list = document.getElementById(toggle?.getAttribute('aria-controls') ?? '')
    expect(list?.getAttribute('aria-hidden')).toBe('true')
    expect(list?.hasAttribute('inert')).toBe(true)
    expect(container.querySelectorAll('[data-task-status]')).toHaveLength(3)
  })
})
