import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTab } from '../../../../shared/domain/tab'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

vi.mock('../../services/browser', () => ({
  closeBrowserTab: vi.fn(async () => undefined)
}))

vi.mock('../../services/terminal', () => ({
  killTerminal: vi.fn(async () => undefined)
}))

import { useTabsStore } from '../tabs'
import { useWindowStore } from '../window'

const tabsInitial = useTabsStore.getState()
const windowInitial = useWindowStore.getState()
const workspaceId = 'workspace-open-path'

const chat: InnerTab = {
  id: 'chat',
  kind: 'chat',
  pane: 'main',
  title: 'Chat',
  ref: { sessionId: null }
}

beforeEach(() => {
  useTabsStore.setState(tabsInitial, true)
  useWindowStore.setState(windowInitial, true)
  useWindowStore.setState({ activeWorkspaceId: workspaceId, rightPanelOpen: false })
  useTabsStore.getState().hydrate(workspaceId, { tabs: [chat], activeTabId: chat.id })
})

describe('openPath', () => {
  it('opens a file in the workspace right panel and reveals it', () => {
    useTabsStore.getState().openPath(workspaceId, 'doc', 'src/index.ts', 'index.ts')

    const state = useTabsStore.getState().stateOf(workspaceId)
    const doc = state.tabs.find((tab) => tab.kind === 'doc')
    expect(doc?.pane).toBe('right')
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toContainEqual(doc)
    expect(useWindowStore.getState().rightPanelOpen).toBe(true)
    expect(useWindowStore.getState().rightPanelOpenByWorkspace[workspaceId]).toBe(true)
  })

  it('reuses an already open right panel file instead of adding a duplicate', () => {
    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')
    const first = useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.kind === 'doc')!
    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')

    const docs = useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')
    expect(docs).toHaveLength(1)
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toEqual([first])
    expect(first.pane).toBe('right')
  })

  it('moves a legacy main-pane file into the right panel when reopened', () => {
    const legacyDoc: InnerTab = {
      id: 'legacy-doc',
      kind: 'doc',
      pane: 'main',
      title: 'README.md',
      ref: { path: 'README.md' }
    }
    useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, legacyDoc], activeTabId: chat.id })

    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')

    const docs = useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')
    expect(docs).toHaveLength(1)
    expect(docs[0]?.pane).toBe('right')
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toEqual(docs)
  })

  it('keeps at least one chat in the main pane when moving or closing tabs', () => {
    const files: InnerTab = {
      id: 'files',
      kind: 'files',
      pane: 'right',
      title: 'Files',
      ref: { path: '' }
    }
    useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, files], activeTabId: chat.id, rightActiveTabId: files.id })
    const dock = useTabsStore.getState().dockOf(workspaceId)
    const mainGroup = dock.root.type === 'split' && dock.root.first.type === 'group' ? dock.root.first.id : null
    const rightGroup = dock.root.type === 'split' && dock.root.second.type === 'group' ? dock.root.second.id : null
    expect(mainGroup).not.toBeNull()
    expect(rightGroup).not.toBeNull()

    useTabsStore.getState().moveDockTab(workspaceId, chat.id, mainGroup!, rightGroup!)
    useTabsStore.getState().closeDockTab(workspaceId, mainGroup!, chat.id)

    expect(useTabsStore.getState().tabsOf(workspaceId, 'main')).toEqual([chat])
  })

  it('repairs a persisted layout whose chats are all in the right panel', () => {
    const rightChat: InnerTab = { ...chat, id: 'right-chat', pane: 'right' }
    const files: InnerTab = {
      id: 'files', kind: 'files', pane: 'right', title: 'Files', ref: { path: '' }
    }
    useTabsStore.getState().hydrate(workspaceId, {
      tabs: [rightChat, files], activeTabId: rightChat.id, rightActiveTabId: rightChat.id
    })

    expect(useTabsStore.getState().tabsOf(workspaceId, 'main')).toContainEqual(expect.objectContaining({ id: rightChat.id, pane: 'main' }))
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toContainEqual(files)
  })
})
