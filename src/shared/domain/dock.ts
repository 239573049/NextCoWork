import type { InnerTab, InnerTabState, TabPane } from './tab'
import { paneOf } from './tab'
import { ulid } from '../util/id'

export type DockDirection = 'left' | 'right' | 'up' | 'down'
export type DockSplitDirection = 'horizontal' | 'vertical'

export type DockNode =
  | {
      type: 'group'
      id: string
      tabIds: string[]
      activeTabId: string | null
      hidden?: boolean
      pinned?: 'right'
    }
  | {
      type: 'split'
      id: string
      direction: DockSplitDirection
      ratio: number
      first: DockNode
      second: DockNode
    }

export interface WorkspaceDockState {
  version: 2
  /** Revision 1 removes the old persisted, hidden split placeholders. */
  revision?: 1
  root: DockNode
  activeGroupId: string | null
  tabs: InnerTab[]
}

export const DOCK_MIN_RATIO = 0.15
export const DOCK_MAX_RATIO = 0.85

const clampRatio = (ratio: number): number =>
  Math.min(DOCK_MAX_RATIO, Math.max(DOCK_MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5))

const group = (tabs: readonly InnerTab[], id = ulid()): DockNode => {
  const ids = tabs.map((tab) => tab.id)
  return { type: 'group', id, tabIds: ids, activeTabId: ids[0] ?? null }
}

export function createInitialDock(tabs: readonly InnerTab[]): WorkspaceDockState {
  const main = tabs.filter((tab) => paneOf(tab) === 'main' || tab.pane === undefined)
  const bottom = tabs.filter((tab) => paneOf(tab) === 'bottom')
  const right = tabs.filter((tab) => paneOf(tab) === 'right')
  const mainNode = group(main)
  let root: DockNode = mainNode
  if (bottom.length > 0) {
    root = {
      type: 'split', id: ulid(), direction: 'vertical', ratio: 0.72,
      first: root, second: group(bottom)
    }
  }
  if (right.length > 0) {
    root = {
      type: 'split', id: ulid(), direction: 'horizontal', ratio: 0.72,
      first: root, second: group(right)
    }
  }
  const firstGroup = findFirstGroup(root)
  return { version: 2, revision: 1, root, activeGroupId: firstGroup?.id ?? null, tabs: [...tabs] }
}

function findFirstGroup(node: DockNode): Extract<DockNode, { type: 'group' }> | null {
  if (node.type === 'group') return node
  return findFirstGroup(node.first) ?? findFirstGroup(node.second)
}

export function findGroup(root: DockNode, groupId: string): Extract<DockNode, { type: 'group' }> | null {
  if (root.type === 'group') return root.id === groupId ? root : null
  return findGroup(root.first, groupId) ?? findGroup(root.second, groupId)
}

export function findParent(root: DockNode, nodeId: string): Extract<DockNode, { type: 'split' }> | null {
  if (root.type === 'group') return null
  if (root.first.id === nodeId || root.second.id === nodeId) return root
  return findParent(root.first, nodeId) ?? findParent(root.second, nodeId)
}

function mapNode(node: DockNode, id: string, fn: (node: DockNode) => DockNode): DockNode {
  if (node.id === id) return fn(node)
  if (node.type === 'group') return node
  return { ...node, first: mapNode(node.first, id, fn), second: mapNode(node.second, id, fn) }
}

const directionInfo = (direction: DockDirection): { axis: DockSplitDirection; first: boolean } => {
  if (direction === 'left') return { axis: 'horizontal', first: true }
  if (direction === 'right') return { axis: 'horizontal', first: false }
  if (direction === 'up') return { axis: 'vertical', first: true }
  return { axis: 'vertical', first: false }
}

export function splitGroup(state: WorkspaceDockState, groupId: string, direction: DockDirection, tabIds: readonly string[] = []): WorkspaceDockState {
  const target = findGroup(state.root, groupId)
  if (target === null) return state
  const info = directionInfo(direction)
  // This transient node must be populated before a store commits the split.
  const newGroup: DockNode = { type: 'group', id: ulid(), tabIds: [...tabIds], activeTabId: tabIds[0] ?? null }
  const split: DockNode = {
    type: 'split', id: ulid(), direction: info.axis, ratio: 0.5,
    first: info.first ? newGroup : target, second: info.first ? target : newGroup
  }
  const parent = findParent(state.root, groupId)
  const root = parent === null ? split : mapNode(state.root, parent.id, (node) => {
    if (node.type !== 'split') return node
    return node.first.id === groupId ? { ...node, first: split } : { ...node, second: split }
  })
  return { ...state, root, activeGroupId: newGroup.id }
}

export function addTabToGroup(state: WorkspaceDockState, groupId: string, tab: InnerTab): WorkspaceDockState {
  const target = findGroup(state.root, groupId)
  if (target === null) return state
  const root = mapNode(state.root, groupId, () => ({ ...target, tabIds: [...target.tabIds, tab.id], activeTabId: tab.id, hidden: false }))
  return normalizeDockState({ ...state, root, activeGroupId: groupId, tabs: [...state.tabs, tab] }, [...state.tabs, tab])
}

export function moveTab(state: WorkspaceDockState, tabId: string, fromGroupId: string, toGroupId: string, index?: number): WorkspaceDockState {
  if (state.tabs.find((tab) => tab.id === tabId)?.kind === 'files') return state
  if (fromGroupId === toGroupId) {
    const group = findGroup(state.root, toGroupId)
    const from = group?.tabIds.indexOf(tabId) ?? -1
    return from < 0 ? state : reorderTab(state, toGroupId, from, index ?? from)
  }
  const source = findGroup(state.root, fromGroupId)
  const target = findGroup(state.root, toGroupId)
  if (source === null || target === null || !source.tabIds.includes(tabId)) return state
  const moving = state.tabs.find((tab) => tab.id === tabId)
  const targetTabs = state.tabs.filter((tab) => target.tabIds.includes(tab.id))
  const targetPane = target.pinned === 'right'
    ? 'right'
    : targetTabs.length > 0 && targetTabs.every((tab) => paneOf(tab) === paneOf(targetTabs[0]!))
      ? paneOf(targetTabs[0]!)
      : null
  // Keep one chat in the main pane. Without this guard, collapsing the right
  // workbench can leave every session hidden and the sidebar has nowhere to
  // activate a conversation.
  if (moving?.kind === 'chat' && paneOf(moving) === 'main' && targetPane !== null && targetPane !== 'main') {
    const mainChats = state.tabs.filter((tab) => tab.kind === 'chat' && paneOf(tab) === 'main')
    if (mainChats.length <= 1) return state
  }
  const nextSource = { ...source, tabIds: source.tabIds.filter((id) => id !== tabId), activeTabId: source.activeTabId === tabId ? null : source.activeTabId }
  const nextIds = [...target.tabIds]
  nextIds.splice(Math.max(0, Math.min(index ?? nextIds.length, nextIds.length)), 0, tabId)
  // Receiving a tab also reveals an intentionally hidden destination.
  const nextTarget = { ...target, tabIds: nextIds, activeTabId: tabId, hidden: false }
  let root = mapNode(state.root, source.id, () => nextSource)
  root = mapNode(root, target.id, () => nextTarget)
  // pane is only a legacy compatibility hint. A dragged tab takes the target
  // group's hint; a new arbitrary Dock group must not inherit a hidden panel.
  const pane = targetTabs[0] && targetTabs.every((tab) => paneOf(tab) === paneOf(targetTabs[0]!))
    ? paneOf(targetTabs[0]) : 'main'
  const tabs = state.tabs.map((tab) => tab.id === tabId ? { ...tab, pane } : tab)
  return normalizeDockState({ ...state, root, activeGroupId: target.id, tabs }, tabs)
}

export function reorderTab(state: WorkspaceDockState, groupId: string, from: number, to: number): WorkspaceDockState {
  const target = findGroup(state.root, groupId)
  if (target === null || from < 0 || from >= target.tabIds.length) return state
  if (state.tabs.find((tab) => tab.id === target.tabIds[from])?.kind === 'files') return state
  const ids = [...target.tabIds]
  const [item] = ids.splice(from, 1)
  if (item === undefined) return state
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, item)
  return { ...state, root: mapNode(state.root, groupId, () => ({ ...target, tabIds: ids })) }
}

export function resizeSplit(state: WorkspaceDockState, splitId: string, ratio: number): WorkspaceDockState {
  return { ...state, root: mapNode(state.root, splitId, (node) => node.type === 'split' ? { ...node, ratio: clampRatio(ratio) } : node) }
}

function removeNode(root: DockNode, nodeId: string): DockNode | null {
  if (root.type === 'group') return root.id === nodeId ? null : root
  if (root.first.id === nodeId) return root.second
  if (root.second.id === nodeId) return root.first
  const first = removeNode(root.first, nodeId)
  const second = removeNode(root.second, nodeId)
  if (first === null) return second
  if (second === null) return first
  return { ...root, first, second }
}

export function closeGroup(state: WorkspaceDockState, groupId: string): WorkspaceDockState {
  const target = findGroup(state.root, groupId)
  if (target === null) return state
  const root = removeNode(state.root, groupId) ?? { type: 'group', id: ulid(), tabIds: [], activeTabId: null }
  const nextTabs = state.tabs.filter((tab) => !target.tabIds.includes(tab.id))
  const first = findFirstGroup(root)
  return normalizeDockState({ ...state, root, tabs: nextTabs, activeGroupId: first?.id ?? null }, nextTabs)
}

export function closeTab(state: WorkspaceDockState, groupId: string, tabId: string): WorkspaceDockState {
  const target = findGroup(state.root, groupId)
  if (target === null || !target.tabIds.includes(tabId)) return state
  const ids = target.tabIds.filter((id) => id !== tabId)
  const active = target.activeTabId === tabId ? (ids[0] ?? null) : target.activeTabId
  const next = { ...state, root: mapNode(state.root, groupId, () => ({ ...target, tabIds: ids, activeTabId: active })), tabs: state.tabs.filter((tab) => tab.id !== tabId) }
  return ids.length === 0 ? closeGroup(next, groupId) : next
}

export function normalizeDockState(raw: WorkspaceDockState, tabs: readonly InnerTab[] = raw.tabs): WorkspaceDockState {
  const seenTabs = new Set<string>()
  const uniqueTabs = tabs.filter((tab) => {
    if (seenTabs.has(tab.id)) return false
    seenTabs.add(tab.id)
    return tab.kind !== 'files' || !tabs.slice(0, tabs.indexOf(tab)).some((item) => item.kind === 'files')
  }).map((tab) => tab.kind === 'files' ? { ...tab, pane: 'right' as const } : tab)
  const valid = new Set(uniqueTabs.map((tab) => tab.id))
  const used = new Set<string>()
  const normalizeNode = (node: DockNode): DockNode | null => {
    if (node.type === 'group') {
      const ids = node.tabIds.filter((id) => valid.has(id) && !used.has(id))
      ids.forEach((id) => used.add(id))
      if (ids.length === 0) return null
      // Before revision 1, hidden meant a pending split rather than a user
      // visibility choice. Recover tabs moved into those old placeholders.
      return { ...node, hidden: raw.revision === 1 && node.hidden === true, tabIds: ids, activeTabId: ids.includes(node.activeTabId ?? '') ? node.activeTabId : (ids[0] ?? null) }
    }
    const first = normalizeNode(node.first)
    const second = normalizeNode(node.second)
    if (first === null) return second
    if (second === null) return first
    return { ...node, ratio: clampRatio(node.ratio), first, second }
  }
  const root = normalizeNode(raw.root) ?? { type: 'group', id: raw.root.type === 'group' ? raw.root.id : ulid(), tabIds: [], activeTabId: null }
  const orphaned = uniqueTabs.filter((tab) => !used.has(tab.id))
  const first = findFirstGroup(root)
  /*
    ★ 孤儿要按**它自己声明的那一格**归位,不能一律塞进第一个组。
    Agent 打开的浏览器就是这么进来的(先写进 `tabs`,Dock 树后一步才知道它):
    落回第一个组的话它会开在主区的对话旁边,而不是右侧工作台。
  */
  let finalRoot = root
  if (orphaned.length > 0 && first !== null) {
    const paneGroups: Array<{ id: string; pane: TabPane | null }> = []
    const collect = (node: DockNode): void => {
      if (node.type === 'group') {
        const members = uniqueTabs.filter((tab) => node.tabIds.includes(tab.id))
        const head = members[0]
        paneGroups.push({
          id: node.id,
          pane: node.pinned === 'right'
            ? 'right'
            : head !== undefined && members.every((tab) => paneOf(tab) === paneOf(head)) ? paneOf(head) : null
        })
        return
      }
      collect(node.first)
      collect(node.second)
    }
    collect(root)
    /*
      A right/bottom orphan arriving before any group exists for that pane
      (e.g. the very first Agent browser tab in a fresh workspace) must get a
      real split, not just fall back to the main group below. Otherwise the
      tab renders inside the main pane while still claiming `pane: 'right'`,
      and `toggleDockEdge` (AppShell) sees that claim and assumes the right
      panel already has content, so its open/close toggle silently no-ops
      until the tab is closed.
    */
    for (const pane of ['right', 'bottom'] as const) {
      if (paneGroups.some((entry) => entry.pane === pane)) continue
      if (!orphaned.some((tab) => paneOf(tab) === pane)) continue
      const edgeGroup: DockNode = { type: 'group', id: ulid(), tabIds: [], activeTabId: null }
      finalRoot = {
        type: 'split',
        id: ulid(),
        direction: pane === 'right' ? 'horizontal' : 'vertical',
        ratio: 0.72,
        first: finalRoot,
        second: edgeGroup
      }
      paneGroups.push({ id: edgeGroup.id, pane })
    }
    for (const tab of orphaned) {
      const target = paneGroups.find((entry) => entry.pane === paneOf(tab))?.id ?? first.id
      finalRoot = mapNode(finalRoot, target, (node) =>
        node.type === 'group'
          ? { ...node, tabIds: [...node.tabIds, tab.id], activeTabId: node.activeTabId ?? tab.id }
          : node
      )
    }
  }
  const filesTab = uniqueTabs.find((tab) => tab.kind === 'files')
  if (filesTab !== undefined) {
    // `filesTab.id` is a tab id, while `findGroup` expects a group id. Find
    // the containing group explicitly so an already pinned files group can be
    // preserved instead of being detached into a second split (which used to
    // leave an empty placeholder beside the right panel).
    const findContainingGroup = (node: DockNode): Extract<DockNode, { type: 'group' }> | null => {
      if (node.type === 'group') return node.tabIds.includes(filesTab.id) ? node : null
      return findContainingGroup(node.first) ?? findContainingGroup(node.second)
    }
    const fileGroup = findContainingGroup(finalRoot)
    const rightmost = rightmostGroup(finalRoot)
    if (fileGroup !== null && rightmost?.id === fileGroup.id) {
      finalRoot = mapNode(finalRoot, fileGroup.id, (node) => node.type === 'group' ? { ...node, pinned: 'right', hidden: false } : node)
    } else {
      const stripped = removeTabFromNode(finalRoot, filesTab.id)
      const mainRoot = stripped ?? { type: 'group', id: ulid(), tabIds: [], activeTabId: null }
      const pinned: DockNode = { type: 'group', id: fileGroup?.id ?? ulid(), tabIds: [filesTab.id], activeTabId: filesTab.id, pinned: 'right' }
      finalRoot = { type: 'split', id: ulid(), direction: 'horizontal', ratio: 0.78, first: mainRoot, second: pinned }
    }
  }
  const activeGroupId = findGroup(finalRoot, raw.activeGroupId ?? '')?.id ?? findFirstGroup(finalRoot)?.id ?? null
  return { version: 2, revision: 1, root: finalRoot, activeGroupId, tabs: uniqueTabs }
}

function rightmostGroup(node: DockNode): Extract<DockNode, { type: 'group' }> | null {
  if (node.type === 'group') return node
  return rightmostGroup(node.second)
}

function removeTabFromNode(node: DockNode, tabId: string): DockNode | null {
  if (node.type === 'group') {
    if (!node.tabIds.includes(tabId)) return node
    const tabIds = node.tabIds.filter((id) => id !== tabId)
    return tabIds.length === 0 ? null : { ...node, tabIds, activeTabId: node.activeTabId === tabId ? (tabIds[0] ?? null) : node.activeTabId, pinned: undefined }
  }
  const first = removeTabFromNode(node.first, tabId)
  const second = removeTabFromNode(node.second, tabId)
  if (first === null) return second
  if (second === null) return first
  return { ...node, first, second }
}

export function migrateLegacyInnerTabs(legacy: InnerTabState): WorkspaceDockState {
  return normalizeDockState(createInitialDock(legacy.tabs), legacy.tabs)
}
