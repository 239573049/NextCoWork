/**
 * 转录里文件引用的点开。
 *
 * 钉两件事:
 *
 * 1. chip 是一枚**真按钮**(键盘与鼠标走同一条路);没有工作区上下文时**干脆不画**
 *    —— 只读的子代理面板里画一枚点了没反应的 chip 比不画更难解释。
 * 2. 点下去先确认文件还在:**引用是发送那一刻的快照**,文件后来被删掉、改名是常态。
 *    那种情况下一个 Tab 都不能开(`openFile` 会留下一个只显示错误的 Tab,
 *    还要用户自己去关),失败走 toast。
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTab } from '../../../../../shared/domain/tab'

vi.mock('../../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

vi.mock('../../../services/browser', () => ({
  closeBrowserTab: vi.fn(async () => undefined)
}))

vi.mock('../../../services/terminal', () => ({
  killTerminal: vi.fn(async () => undefined)
}))

vi.mock('../../../services/workspace-files', () => ({
  workspaceFileOpenFailure: vi.fn()
}))

import { I18nProvider } from '../../../i18n'
import { workspaceFileOpenFailure } from '../../../services/workspace-files'
import { useTabsStore } from '../../../stores/tabs'
import { useToastStore } from '../../../stores/toast'
import { useWindowStore } from '../../../stores/window'
import { MessageFileRef } from '../MessageFileRef'
import { MentionText } from '../MentionText'
import { openFileReference } from '../file-reference-actions'

const probe = vi.mocked(workspaceFileOpenFailure)
const tabsInitial = useTabsStore.getState()
const windowInitial = useWindowStore.getState()
const workspaceId = 'workspace-file-ref'
const chat: InnerTab = { id: 'chat', kind: 'chat', pane: 'main', title: 'Chat', ref: { sessionId: null } }

let teardown: (() => Promise<void>) | null = null

beforeEach(() => {
  probe.mockReset()
  useTabsStore.setState(tabsInitial, true)
  useWindowStore.setState(windowInitial, true)
  useWindowStore.setState({ activeWorkspaceId: workspaceId, rightPanelOpen: false })
  useTabsStore.getState().hydrate(workspaceId, { tabs: [chat], activeTabId: chat.id })
  useToastStore.getState().clear()
})

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

async function render(children: ReactNode): Promise<HTMLElement> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const container = document.getElementById('root')!
  const root = createRoot(container)
  teardown = async () => {
    await act(async () => root.unmount())
    dom.window.close()
  }
  await act(async () => { root.render(createElement(I18nProvider, { initialLocale: 'zh-CN', children })) })
  return container
}

const chip = (container: HTMLElement, testId: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (element === null) throw new Error(`没有渲染 ${testId}`)
  return element
}

describe('转录里的文件引用 chip', () => {
  it('块状引用是一枚按钮,点击把路径交出去', async () => {
    const onOpen = vi.fn()
    const container = await render(createElement(MessageFileRef, { name: 'config.ts', path: 'src/config.ts', onOpen }))

    const button = chip(container, 'message-file-ref')
    expect(button.tagName).toBe('BUTTON')
    await act(async () => { button.click() })
    expect(onOpen).toHaveBeenCalledWith('src/config.ts')
  })

  it('行内 @ 引用同样可点', async () => {
    const onOpen = vi.fn()
    const container = await render(createElement(MentionText, { text: '先看 [配置](src/config.ts)', onOpen }))

    const button = chip(container, 'mention-chip')
    expect(button.tagName).toBe('BUTTON')
    await act(async () => { button.click() })
    expect(onOpen).toHaveBeenCalledWith('src/config.ts')
  })

  it('★ 拿不到工作区时不画按钮,只留原来那枚只读 chip', async () => {
    const message = await render(createElement(MessageFileRef, { name: 'config.ts', path: 'src/config.ts' }))
    const mention = await render(createElement(MentionText, { text: '先看 [配置](src/config.ts)' }))

    expect(chip(message, 'message-file-ref').tagName).toBe('DIV')
    expect(chip(mention, 'mention-chip').tagName).toBe('SPAN')
  })
})

describe('openFileReference', () => {
  it('文件还在时在右侧工作台开一个 Tab', async () => {
    probe.mockResolvedValue(null)
    await openFileReference(workspaceId, 'src/config.ts')

    const doc = useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.kind === 'doc')
    expect(doc?.ref).toEqual({ path: 'src/config.ts' })
    expect(doc?.pane).toBe('right')
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('★ 文件已经不在时一个 Tab 都不开,只报一条 toast', async () => {
    probe.mockResolvedValue('document.error.not-found')
    await openFileReference(workspaceId, 'src/gone.ts')

    expect(useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')).toHaveLength(0)
    expect(useToastStore.getState().toasts[0]?.message).toContain('已不存在')
  })
})
