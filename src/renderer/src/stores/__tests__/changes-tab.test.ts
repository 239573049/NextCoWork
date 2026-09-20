/**
 * 回合底部那张改动审查卡点一行文件 → 审查 tab 要开在**右侧工作区**、
 * 并且**停在那个文件**上。
 *
 * 这条路上有两处会悄悄失效:
 * 1. 落点。右侧工作台还没切出来时,`open(ws,'changes','right')` 会退回当前分组,
 *    tab 落进主区盖住对话 —— 所以走 `openChangeReview`。
 * 2. `selectedPath` 的搬运。没落进 `ref` 的话界面不报错,只是永远停在清单第一个
 *    文件,点第 7 行和点第 1 行看起来一模一样。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockNode } from '../../../../shared/domain/dock'
import { paneOf, type InnerTab } from '../../../../shared/domain/tab'

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
const workspaceId = 'workspace-changes-tab'

const chat: InnerTab = {
  id: 'chat',
  kind: 'chat',
  pane: 'main',
  title: 'Chat',
  ref: { sessionId: null }
}

function changesTabs(): Extract<InnerTab, { kind: 'changes' }>[] {
  return useTabsStore
    .getState()
    .stateOf(workspaceId)
    .tabs.filter((tab): tab is Extract<InnerTab, { kind: 'changes' }> => tab.kind === 'changes')
}

/**
 * tab 实际落在哪个 dock 分组。
 *
 * ★ 别用 `paneOf(tab)` 判落点:它读的是 tab 自己的 `pane` 字段,而 `makeTab`
 *   是按调用方要求写死的 —— 一个落进主区分组的 tab,`pane` 照样写着 'right'。
 *   「盖在对话上面」这个症状只有从 dock 树上才看得出来。
 */
function groupOf(tabId: string): string | null {
  const visit = (node: DockNode): string | null => {
    if (node.type === 'group') return node.tabIds.includes(tabId) ? node.id : null
    return visit(node.first) ?? visit(node.second)
  }
  return visit(useTabsStore.getState().dockOf(workspaceId).root)
}

beforeEach(() => {
  useTabsStore.setState(tabsInitial, true)
  useWindowStore.setState(windowInitial, true)
  useWindowStore.setState({ activeWorkspaceId: workspaceId, rightPanelOpen: false })
  useTabsStore.getState().hydrate(workspaceId, { tabs: [chat], activeTabId: chat.id })
})

describe('opening a change review tab', () => {
  it('lands in the right workbench even when it has never been split out', () => {
    useTabsStore.getState().openChangeReview(workspaceId, 'run-1', 'session-1')

    const tab = changesTabs()[0]
    expect(tab).toBeDefined()
    expect(paneOf(tab!)).toBe('right')
    // 关键的一条:和主区那条对话**不在同一个 dock 分组**里。
    // 同组就是「审查 tab 开进主区、盖住对话」那个事故。
    expect(groupOf(tab!.id)).not.toBe(groupOf(chat.id))
    expect(useTabsStore.getState().stateOf(workspaceId).rightActiveTabId).toBe(tab!.id)
    expect(useWindowStore.getState().rightPanelOpen).toBe(true)
    expect(useTabsStore.getState().stateOf(workspaceId).activeTabId).toBe(chat.id)
  })

  it('carries the clicked file through to the tab ref', () => {
    useTabsStore
      .getState()
      .openChangeReview(workspaceId, 'run-1', 'session-1', 'src/renderer/src/views/chat/draft-attachments.ts')

    expect(changesTabs()[0]?.ref).toEqual({
      runId: 'run-1',
      sessionId: 'session-1',
      selectedPath: 'src/renderer/src/views/chat/draft-attachments.ts'
    })
  })

  it('leaves selectedPath off the ref when the whole change set was opened', () => {
    // 不送 explicit undefined:那会让落盘的布局里多出一个 "selectedPath": undefined,
    // 读回来时和「没选过」不是同一个形状。
    useTabsStore.getState().openChangeReview(workspaceId, 'run-1', 'session-1')

    const ref = changesTabs()[0]?.ref
    expect(ref).toEqual({ runId: 'run-1', sessionId: 'session-1' })
    expect(ref !== undefined && 'selectedPath' in ref).toBe(false)
  })

  it('retargets the one tab of a run instead of stacking a copy per file', () => {
    const tabs = useTabsStore.getState()
    tabs.openChangeReview(workspaceId, 'run-1', 'session-1', 'a.ts')
    const first = changesTabs()[0]?.id
    tabs.openChangeReview(workspaceId, 'run-1', 'session-1', 'b.ts')

    // 展开一个 11 个文件的改动集挨个点,右边攒出 11 个同名「改动」—— 这条拦它。
    expect(changesTabs()).toHaveLength(1)
    expect(changesTabs()[0]?.id).toBe(first)
    expect(changesTabs()[0]?.ref.selectedPath).toBe('b.ts')
  })

  it('keeps one tab per run, not per session', () => {
    const tabs = useTabsStore.getState()
    tabs.openChangeReview(workspaceId, 'run-1', 'session-1', 'a.ts')
    tabs.openChangeReview(workspaceId, 'run-2', 'session-1', 'a.ts')

    expect(changesTabs().map((t) => t.ref.runId)).toEqual(['run-1', 'run-2'])
  })
})
