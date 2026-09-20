/**
 * 任务面板的 DOM 级回归 —— 钉的是「角标数的是此刻有几个子代理在跑」。
 *
 * 由头:面板以前只收 `background === true` 的条目。父代理同步等着的那个
 * 前台子代理,卡片上在转、面板里一条都没有 —— 于是「两个在跑,角标写 1」,
 * 点开之后也找不到另一个。外加一条:在跑的那条要排在已完成的前面,
 * 否则面板存在的唯一理由(「现在还有什么在跑」)要靠用户自己翻。
 *
 * 已汇报成功的后台任务默认归进折叠区；回传中、失败、停止或还待处理的任务
 * 不能一起藏掉，否则用户会看到任务消失，但主对话还没有拿到结果。
 *
 * 样板抄 `subagent-card.test.ts`(JSDOM 手搓,没有全局 jsdom 环境)。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { SubagentTaskCenter } from '../Thread'
import { SubagentOpenProvider } from '../subagent-open'

function subagent(callId: string, patch: Partial<SubagentState> = {}): SubagentState {
  return {
    callId,
    childRunId: `run:${callId}`,
    childSessionId: `parent:sub:${callId}`,
    status: 'running',
    description: callId,
    subagentType: 'code-reviewer',
    toolCalls: 3,
    toolErrors: 0,
    startedAt: Date.now() - 60_000,
    ...patch
  }
}

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.clearAllMocks()
})

async function renderCenter(subagents: Record<string, SubagentState>): Promise<{
  container: HTMLElement
  opened: SubagentState[]
}> {
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
  const opened: SubagentState[] = []
  await act(async () => root.render(createElement(I18nProvider, {
    initialLocale: 'zh-CN',
    children: createElement(SubagentOpenProvider, {
      open: (s: SubagentState) => { opened.push(s) },
      children: createElement(SubagentTaskCenter, { sessionId: 'session', subagents })
    })
  })))
  teardown = async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
  return { container, opened }
}

const click = async (el: Element | null): Promise<void> => {
  if (el === null) throw new Error('要点的那个节点不在 —— 断言前先确认它渲染了')
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

const rows = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="subagent-center-row"]')]

describe('子代理任务面板', () => {
  /** ★★ 这条是这次改动的由头:两个在跑,角标以前写 1 */
  it('★★ 角标把前台和后台在跑的都算上', async () => {
    const { container } = await renderCenter({
      bg: subagent('bg', { background: true }),
      fg: subagent('fg')
    })
    const toggle = container.querySelector('[aria-expanded]')
    expect(toggle?.textContent).toContain('2')
  })

  it('★ 点开之后,在跑的那个前台子代理也在列表里', async () => {
    const { container, opened } = await renderCenter({
      bg: subagent('bg', { background: true }),
      fg: subagent('fg')
    })
    await click(container.querySelector('[aria-expanded]'))
    const ids = rows(container).map((row) => row.dataset.centerCallId)
    expect(ids).toContain('fg')
    expect(ids).toContain('bg')

    await click(container.querySelector('[data-center-call-id="fg"] button'))
    expect(opened.map((item) => item.callId)).toEqual(['fg'])
  })

  it('★ 在跑和待处理的排在前面,已完成后台任务默认收起且可手动展开', async () => {
    const { container } = await renderCenter({
      done: subagent('done', { background: true, status: 'done', reportStatus: 'reported' }),
      pending: subagent('pending', { background: true, status: 'done', reportStatus: 'pending' }),
      running: subagent('running', { background: true })
    })
    await click(container.querySelector('[aria-expanded]'))
    expect(rows(container).map((row) => row.dataset.centerCallId)).toEqual(['running', 'pending'])

    const completedToggle = container.querySelector('[data-testid="subagent-center-completed-toggle"]')
    expect(completedToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(completedToggle?.textContent).toBe('已完成1')
    const completedItemsId = completedToggle?.getAttribute('aria-controls')
    expect(completedItemsId).not.toBeNull()
    expect(container.ownerDocument.getElementById(completedItemsId ?? '')).not.toBeNull()

    await click(completedToggle)
    expect(rows(container).map((row) => row.dataset.centerCallId)).toEqual(['running', 'pending', 'done'])
  })

  it('回传中、失败和停止的后台任务不进入已完成折叠区', async () => {
    const { container } = await renderCenter({
      done: subagent('done', { background: true, status: 'done', reportStatus: 'reported' }),
      injecting: subagent('injecting', { background: true, status: 'done', reportStatus: 'injecting' }),
      error: subagent('error', { background: true, status: 'error', reportStatus: 'reported' }),
      aborted: subagent('aborted', { background: true, status: 'aborted', reportStatus: 'reported' })
    })
    await click(container.querySelector('[aria-expanded]'))
    expect(rows(container).map((row) => row.dataset.centerCallId)).toEqual(['injecting', 'error', 'aborted'])
    expect(container.querySelector('[data-testid="subagent-center-completed-toggle"]')?.textContent).toBe('已完成1')
  })

  /** 前台子代理跑完就退场:它的结果已经同步回到主对话,没有「等你来收」这一步 */
  it('跑完的前台子代理不再占着列表', async () => {
    const { container } = await renderCenter({
      bg: subagent('bg', { background: true, status: 'done', reportStatus: 'reported' }),
      fg: subagent('fg', { status: 'done' })
    })
    await click(container.querySelector('[aria-expanded]'))
    await click(container.querySelector('[data-testid="subagent-center-completed-toggle"]'))
    expect(rows(container).map((row) => row.dataset.centerCallId)).toEqual(['bg'])
  })

  it('一个后台任务都没有、也没有在跑的,面板整块不画', async () => {
    const { container } = await renderCenter({ fg: subagent('fg', { status: 'done' }) })
    expect(container.querySelector('[aria-expanded]')).toBeNull()
  })
})
