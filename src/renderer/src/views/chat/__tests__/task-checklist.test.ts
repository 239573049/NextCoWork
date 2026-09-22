/**
 * TaskChecklist 的 DOM 契约：真实 Todo 状态必须逐项保留，收起只改变展示，不能改写任务。
 *
 * 同一份转录数据会被两个位置渲染（输入框上方 / 工具卡片的历史快照），所以这里同时
 * 钉住 `execution` 三档的差别：只有 `running` 才允许出现 activeForm、Spinner 与高亮，
 * 而任务本身的 status 与完成百分比在任何一档下都不许被改写。
 *
 * 默认折叠态也在这里钉住：展开/收起只改怎么画，`defaultCollapsed` 是挂载初值而不是
 * 受控值。（消息里那张 TodoWrite 卡片自带标题行与增量，用例在
 * `todo-write-checklist.test.ts`；它复用的行渲染仍由这个文件覆盖。）
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../i18n'
import { TaskChecklist, type TaskChecklistItem, type TaskChecklistExecution as Execution } from '../TaskChecklist'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

/**
 * 挂一份清单，并给出「换档重渲」的把手 —— 这一组用例要验的正是**同一份 todos**
 * 在两个档位之间的展示差，重渲必须走同一棵树（`root.render` 复用同一个实例）。
 */
async function mountChecklist(props: {
  todos: readonly TaskChecklistItem[]
  execution?: Execution
  defaultCollapsed?: boolean
}): Promise<{ container: HTMLElement; show: (next: { todos: readonly TaskChecklistItem[]; execution?: Execution }) => Promise<void> }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const show = async (next: { todos: readonly TaskChecklistItem[]; execution?: Execution }): Promise<void> => {
    await act(async () => root.render(createElement(I18nProvider, {
      initialLocale: 'en-US',
      children: createElement(TaskChecklist, {
        todos: next.todos,
        ...(props.defaultCollapsed === undefined ? {} : { defaultCollapsed: props.defaultCollapsed }),
        ...(next.execution === undefined ? {} : { execution: next.execution })
      })
    })))
  }
  teardown = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await show(props)
  return { container, show }
}

const TODOS: readonly TaskChecklistItem[] = [
  { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
  { content: 'Update UI', activeForm: 'Updating UI', status: 'in_progress' },
  { content: 'Run tests', activeForm: 'Running tests', status: 'pending' }
]

/** Spinner 只由这一个字形画出来（lucide 自己挂的类名），与动效档位无关。 */
function spinnerCount(container: HTMLElement): number {
  return container.querySelectorAll('.lucide-loader-circle').length
}

function rowStatuses(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-task-status]')].map((row) => row.getAttribute('data-task-status'))
}

/** 列表容器的展开态由 `aria-hidden` 表态，比读 grid 行高稳。 */
function listExpanded(container: HTMLElement): boolean {
  const toggle = container.querySelector('[aria-controls]')
  const list = document.getElementById(toggle?.getAttribute('aria-controls') ?? '')
  return list?.getAttribute('aria-hidden') === 'false'
}

describe('TaskChecklist · default collapsed', () => {
  it('starts collapsed and keeps the row count, statuses and progress readable from the header', async () => {
    const { container } = await mountChecklist({ todos: TODOS, execution: 'running' })

    expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(listExpanded(container)).toBe(false)
    // 收起的只是列表：报数、百分比、状态序列都还在，不必展开就能读
    expect(container.textContent).toContain('Task checklist · 1/3 completed')
    expect(container.textContent).toContain('33%')
    expect(rowStatuses(container)).toEqual(['completed', 'in_progress', 'pending'])
    // 标题行那行 activeForm 不属于列表，收起时照旧显示
    expect(container.textContent).toContain('Updating UI')
  })

  it('lets a click open the list instead of springing back to the default on the next render', async () => {
    const { container, show } = await mountChecklist({ todos: TODOS, execution: 'running' })

    const toggle = container.querySelector<HTMLButtonElement>('[aria-controls]')
    await act(async () => toggle?.click())
    expect(listExpanded(container)).toBe(true)

    /*
      需求：`defaultCollapsed` 是挂载初值而非受控值。流式运行里 ChatView 会不停重渲，
      受控写法会把用户刚展开的列表按回收起态 —— 表现为「点了没反应」。
    */
    await show({ todos: TODOS, execution: 'running' })
    expect(listExpanded(container)).toBe(true)
  })

  it('honours defaultCollapsed={false} for callers that open it deliberately', async () => {
    const { container } = await mountChecklist({ todos: TODOS, defaultCollapsed: false })

    expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(listExpanded(container)).toBe(true)
  })
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
        execution: 'running',
        defaultCollapsed: false,
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

  it('drops the spinner and activeForm, keeps every status and count, and reports unfinished items once the run stops', async () => {
    const { container, show } = await mountChecklist({ todos: TODOS, execution: 'running' })

    expect(container.querySelector('[data-testid="task-checklist"]')?.getAttribute('data-execution-state')).toBe('running')
    expect(container.textContent).toContain('Task checklist · 1/3 completed')
    expect(container.textContent).toContain('33%')
    expect(container.textContent).toContain('Updating UI')
    expect(spinnerCount(container)).toBe(1)
    expect(container.querySelector('[data-task-status="in_progress"]')?.className).toContain('bg-accent')

    await show({ todos: TODOS, execution: 'stopped' })

    expect(container.querySelector('[data-testid="task-checklist"]')?.getAttribute('data-execution-state')).toBe('stopped')
    // 清单本体一个字段都没被改写:status 序列、完成计数、百分比都是原值
    expect(rowStatuses(container)).toEqual(['completed', 'in_progress', 'pending'])
    expect(container.textContent).toContain('Task checklist · 1/3 completed')
    expect(container.textContent).toContain('33%')
    expect(spinnerCount(container)).toBe(0)
    expect(container.textContent).not.toContain('Updating UI')
    expect(container.textContent).toContain('Update UI')
    expect(container.textContent).toContain('Run ended with 2 unfinished task(s)')
    expect(container.querySelector('[data-task-status="in_progress"] .sr-only')?.textContent).toBe('Unfinished')
  })

  it('stays quiet when a stopped checklist has nothing left to finish', async () => {
    const { container } = await mountChecklist({
      execution: 'stopped',
      todos: [{ content: 'Run tests', activeForm: 'Running tests', status: 'completed' }]
    })

    expect(container.textContent).toContain('Task checklist · 1/1 completed')
    expect(container.textContent).not.toContain('Run ended with')
    expect(spinnerCount(container)).toBe(0)
  })

  it('labels an unattached checklist as a snapshot instead of showing work in progress', async () => {
    const { container } = await mountChecklist({ todos: TODOS })

    expect(container.querySelector('[data-testid="task-checklist"]')?.getAttribute('data-execution-state')).toBe('snapshot')
    expect(container.textContent).toContain('Checklist snapshot')
    expect(spinnerCount(container)).toBe(0)
    expect(container.textContent).not.toContain('Updating UI')
    expect(container.textContent).toContain('Update UI')
    expect(rowStatuses(container)).toEqual(['completed', 'in_progress', 'pending'])
    expect(container.textContent).toContain('Task checklist · 1/3 completed')
    expect(container.querySelector('[data-task-status="in_progress"] .sr-only')?.textContent).toBe('Unfinished')
    expect(container.querySelector('[data-task-status="pending"] .sr-only')?.textContent).toBe('Waiting')
  })
})
