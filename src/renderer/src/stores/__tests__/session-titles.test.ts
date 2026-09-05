import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTabState } from '../../../../shared/domain/tab'

vi.mock('../../services/app', () => ({ getInnerTabs: vi.fn(), persistInnerTabs: vi.fn() }))
vi.mock('../../services/sessions', () => ({ createSession: vi.fn(async () => undefined) }))

import { getInnerTabs, persistInnerTabs } from '../../services/app'
import { useTabsStore } from '../tabs'

const initial = useTabsStore.getState()
const state: InnerTabState = {
  tabs: [
    { id: 'chat-a', kind: 'chat', title: '新对话', ref: { sessionId: 'session' } },
    { id: 'chat-b', kind: 'chat', pane: 'right', title: '新对话', ref: { sessionId: 'session' } },
    { id: 'doc', kind: 'doc', title: 'README.md', ref: { path: '/README.md' } }
  ], activeTabId: 'doc', bottomActiveTabId: null, rightActiveTabId: 'chat-b'
}

beforeEach(() => { vi.clearAllMocks(); useTabsStore.setState(initial, true) })

describe('session title synchronization', () => {
  it('updates every tab for the session without changing focus, another workspace, or persisted layout', () => {
    const tabs = useTabsStore.getState()
    tabs.hydrate('workspace', state)
    tabs.hydrate('another', state)
    tabs.syncSessionTitle('workspace', 'session', '异步标题')
    const updated = useTabsStore.getState().stateOf('workspace')
    expect(updated.tabs.map((tab) => tab.title)).toEqual(['异步标题', '异步标题', 'README.md'])
    expect(updated).toMatchObject({ activeTabId: 'doc', rightActiveTabId: 'chat-b' })
    expect(useTabsStore.getState().stateOf('another')).toBe(state)
    expect(persistInnerTabs).not.toHaveBeenCalled()
  })

  it('keeps a title notification that arrives while an older layout snapshot is loading', async () => {
    let resolve!: (state: InnerTabState) => void
    vi.mocked(getInnerTabs).mockImplementation(() => new Promise((r) => { resolve = r }))
    useTabsStore.getState().ensure('loading-workspace')
    useTabsStore.getState().syncSessionTitle('loading-workspace', 'session', 'Newer generated title')
    resolve(state)
    await vi.waitFor(() => expect(useTabsStore.getState().stateOf('loading-workspace').tabs[0]?.title).toBe('Newer generated title'))
    expect(persistInnerTabs).not.toHaveBeenCalled()
  })

  it('does not open a workspace or a tab when an unrelated conversation changes', () => {
    useTabsStore.getState().syncSessionTitle('closed-workspace', 'session', 'Title')
    expect(useTabsStore.getState().byWorkspace).toEqual({})
  })
})
