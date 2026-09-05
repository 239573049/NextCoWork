import type { DockDirection, DockNode } from '../../../shared/domain/dock'
import { paneOf, type InnerTab, type TabPane } from '../../../shared/domain/tab'

export const DOCK_TAB_MIME = 'application/x-nextcowork-tab'
export type DockDropZone = DockDirection | 'center' | 'tabs'

export function groupTabs(node: Extract<DockNode, { type: 'group' }>, tabs: readonly InnerTab[]): InnerTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  return node.tabIds.map((id) => byId.get(id)).filter((tab): tab is InnerTab => tab !== undefined)
}

export function groupPane(tabs: readonly InnerTab[]): TabPane {
  const first = tabs[0]
  return first && tabs.every((tab) => paneOf(tab) === paneOf(first)) ? paneOf(first) : 'main'
}

/** Project visibility without deleting a hidden group's tabs or saved ratio. */
export function visibleDockNode(node: DockNode, tabs: readonly InnerTab[], rightVisible: boolean, bottomVisible: boolean): DockNode | null {
  if (node.type === 'group') {
    const members = groupTabs(node, tabs)
    const pane = node.pinned === 'right' ? 'right' : groupPane(members)
    return node.hidden || members.length === 0 || (pane === 'right' && !rightVisible) || (pane === 'bottom' && !bottomVisible) ? null : node
  }
  const first = visibleDockNode(node.first, tabs, rightVisible, bottomVisible)
  const second = visibleDockNode(node.second, tabs, rightVisible, bottomVisible)
  if (first === null) return second
  if (second === null) return first
  return { ...node, first, second }
}

export function dockDropZone(x: number, y: number, width: number, height: number, tabBarHeight: number): DockDropZone {
  if (y <= tabBarHeight) return 'tabs'
  const px = x / Math.max(1, width)
  const py = (y - tabBarHeight) / Math.max(1, height - tabBarHeight)
  return px < 0.25 ? 'left' : px > 0.75 ? 'right' : py < 0.25 ? 'up' : py > 0.75 ? 'down' : 'center'
}
