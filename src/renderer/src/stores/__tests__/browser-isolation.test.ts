import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTab, OuterTab } from '../../../../shared/domain/tab'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

vi.mock('../../services/sessions', () => ({
  createSession: vi.fn(async () => undefined)
}))

vi.mock('../../services/browser', () => ({
  closeBrowserTab: vi.fn(async () => undefined)
}))

import { useTabsStore } from '../tabs'
import { useWindowStore } from '../window'

const windowInitial = useWindowStore.getState()
const tabsInitial = useTabsStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useWindowStore.setState(windowInitial, true)
  useTabsStore.setState(tabsInitial, true)
})

const workspaceTab = (id: string, workspaceId: string): OuterTab => ({
  id,
  kind: 'workspace',
  ref: { workspaceId }
})

const chatTab = (id: string): InnerTab => ({
  id,
  kind: 'chat',
  pane: 'main',
  title: 'Chat',
  ref: { sessionId: `session-${id}` }
})

describe('browser workspace isolation', () => {
  it('后台工作区请求展开右侧面板时，不改变当前工作区；切过去后恢复展开态', () => {
    useWindowStore.setState({
      outer: [workspaceTab('outer-a', 'workspace-a'), workspaceTab('outer-b', 'workspace-b')],
      activeOuterId: 'outer-a',
      activeWorkspaceId: 'workspace-a',
      rightPanelOpen: false,
      rightPanelOpenByWorkspace: {}
    })

    useWindowStore.getState().setRightPanelForWorkspace('workspace-b', true)

    expect(useWindowStore.getState().activeWorkspaceId).toBe('workspace-a')
    expect(useWindowStore.getState().rightPanelOpen).toBe(false)
    expect(useWindowStore.getState().rightPanelOpenByWorkspace['workspace-b']).toBe(true)

    useWindowStore.getState().activate('outer-b')

    expect(useWindowStore.getState().activeWorkspaceId).toBe('workspace-b')
    expect(useWindowStore.getState().rightPanelOpen).toBe(true)
  })

  it('Agent 标签只写入目标工作区，并成为该工作区右侧面板的活动标签', () => {
    const a = chatTab('chat-a')
    const b = chatTab('chat-b')
    const files: InnerTab = {
      id: 'files-b',
      kind: 'files',
      pane: 'right',
      title: 'Files',
      ref: { path: '' }
    }
    useTabsStore.getState().hydrate('workspace-a', { tabs: [a], activeTabId: a.id })
    useTabsStore.getState().hydrate('workspace-b', {
      tabs: [b, files],
      activeTabId: b.id,
      rightActiveTabId: files.id
    })

    useTabsStore.getState().syncBrowserTabs('workspace-b', [{
      id: 'remote-agent-tab',
      url: 'https://example.com/',
      title: 'Example',
      source: 'agent'
    }])

    expect(useTabsStore.getState().stateOf('workspace-a').tabs).toEqual([a])
    const target = useTabsStore.getState().stateOf('workspace-b')
    const browser = target.tabs.find((tab) => tab.kind === 'browser')
    expect(browser).toMatchObject({
      kind: 'browser',
      pane: 'right',
      ref: { browserId: 'remote-agent-tab' }
    })
    expect(target.rightActiveTabId).toBe(browser?.id)
  })
})

describe('browser tab reconciliation', () => {
  it('用 clientTabId 将主进程事件合并回原标签，不按 URL 猜测或创建副本', () => {
    const chat = chatTab('chat')
    const optimistic: InnerTab = {
      id: 'client-browser-tab',
      kind: 'browser',
      pane: 'bottom',
      title: 'New tab',
      ref: { url: '' }
    }
    useTabsStore.getState().hydrate('workspace-a', {
      tabs: [chat, optimistic],
      activeTabId: chat.id,
      bottomActiveTabId: optimistic.id
    })

    useTabsStore.getState().syncBrowserTabs('workspace-a', [{
      id: 'remote-user-tab',
      clientTabId: optimistic.id,
      url: 'https://example.com/',
      title: 'Example',
      source: 'user'
    }])

    const browserTabs = useTabsStore.getState().stateOf('workspace-a').tabs.filter(
      (tab) => tab.kind === 'browser'
    )
    expect(browserTabs).toHaveLength(1)
    expect(browserTabs[0]).toMatchObject({
      id: optimistic.id,
      pane: 'bottom',
      ref: { browserId: 'remote-user-tab', url: 'https://example.com/' }
    })
  })

  it('远端关闭活动浏览器后修复活动项，并保证主区仍有可用标签', () => {
    const browser: InnerTab = {
      id: 'browser-only',
      kind: 'browser',
      pane: 'main',
      title: 'Example',
      ref: { url: 'https://example.com/', browserId: 'remote-old' }
    }
    useTabsStore.getState().hydrate('workspace-a', {
      tabs: [browser],
      activeTabId: browser.id
    })

    useTabsStore.getState().syncBrowserTabs('workspace-a', [])

    const state = useTabsStore.getState().stateOf('workspace-a')
    expect(state.tabs.some((tab) => tab.id === browser.id)).toBe(false)
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.kind).toBe('chat')
    expect(state.activeTabId).toBe(state.tabs[0]?.id)
  })
})
