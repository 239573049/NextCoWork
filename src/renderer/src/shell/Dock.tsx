import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { findGroup, type DockNode } from '../../../shared/domain/dock'
import type { InnerTabKind } from '../../../shared/domain/tab'
import { BOTTOM_TAB_MENU, INNER_TAB_MENU, RIGHT_TAB_MENU } from '../../../shared/domain/tab'
import type { Workspace } from '../../../shared/domain/workspace'
import { EmptyState } from '../components/ui/EmptyState'
import type { FallbackModel } from '../views/chat/Composer'
import { cn } from '../lib/cn'
import { useI18n } from '../i18n'
import { InnerView } from '../views/registry'
import { InnerTabBar } from './InnerTabBar'
import { useTabsStore } from '../stores/tabs'
import { confirmDocumentChanges, useDocumentsStore } from '../stores/documents'
import { DOCK_TAB_MIME, dockDropZone, groupPane, groupTabs, visibleDockNode, type DockDropZone } from './dock-layout'

export function DockRoot({ workspace, fallbackModel, runningSessionIds, rightVisible = true, bottomVisible = true }: { workspace: Workspace; fallbackModel: FallbackModel; runningSessionIds: ReadonlySet<string>; rightVisible?: boolean; bottomVisible?: boolean }): ReactNode {
  const dock = useTabsStore((state) => state.dockOf(workspace.id))
  const root = visibleDockNode(dock.root, dock.tabs, rightVisible, bottomVisible)
  const { t } = useI18n()
  return <div data-dock-root className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{root ? <DockNodeView key={root.id} node={root} workspace={workspace} fallbackModel={fallbackModel} runningSessionIds={runningSessionIds} /> : <EmptyState title={t('common.empty')} />}</div>
}

function DockNodeView({ node, workspace, fallbackModel, runningSessionIds }: { node: DockNode; workspace: Workspace; fallbackModel: FallbackModel; runningSessionIds: ReadonlySet<string> }): ReactNode {
  if (node.type === 'split') {
    const horizontal = node.direction === 'horizontal'
    return (
      <div
        data-dock-split-id={node.id}
        className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
        style={horizontal
          ? { gridTemplateColumns: `minmax(0, ${node.ratio}fr) 4px minmax(0, ${1 - node.ratio}fr)` }
          : { gridTemplateRows: `minmax(0, ${node.ratio}fr) 4px minmax(0, ${1 - node.ratio}fr)` }}
      >
        <DockNodeView key={node.first.id} node={node.first} workspace={workspace} fallbackModel={fallbackModel} runningSessionIds={runningSessionIds} />
        <DockSplitter workspaceId={workspace.id} splitId={node.id} direction={node.direction} ratio={node.ratio} />
        <DockNodeView key={node.second.id} node={node.second} workspace={workspace} fallbackModel={fallbackModel} runningSessionIds={runningSessionIds} />
      </div>
    )
  }
  return <DockGroup key={node.id} node={node} workspace={workspace} fallbackModel={fallbackModel} runningSessionIds={runningSessionIds} />
}

function DockGroup({ node, workspace, fallbackModel, runningSessionIds }: { node: Extract<DockNode, { type: 'group' }>; workspace: Workspace; fallbackModel: FallbackModel; runningSessionIds: ReadonlySet<string> }): ReactNode {
  const { t } = useI18n()
  const dock = useTabsStore((state) => state.dockOf(workspace.id))
  const tabs = groupTabs(node, dock.tabs)
  const edgePane = node.pinned === 'right' ? 'right' : groupPane(tabs)
  const activateTab = useTabsStore((state) => state.activateDockTab)
  const closeTab = useTabsStore((state) => state.closeDockTab)
  const openDock = useTabsStore((state) => state.openDock)
  const splitAndMoveDockTab = useTabsStore((state) => state.splitAndMoveDockTab)
  const moveDock = useTabsStore((state) => state.moveDockTab)
  const reorderDock = useTabsStore((state) => state.reorderDockTab)
  const [dragZone, setDragZone] = useState<DockDropZone | null>(null)
  useEffect(() => {
    if (dragZone === null) return
    const clear = (): void => setDragZone(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [dragZone])
  const active = tabs.find((tab) => tab.id === node.activeTabId)
  const menu = edgePane === 'bottom' ? BOTTOM_TAB_MENU : edgePane === 'right' ? RIGHT_TAB_MENU : INNER_TAB_MENU
  const open = (kind: InnerTabKind): void => openDock(workspace.id, node.id, kind)
  const onClose = async (id: string): Promise<void> => {
    const target = tabs.find((tab) => tab.id === id)
    if (target?.kind === 'doc' || target?.kind === 'preview') {
      if (!(await confirmDocumentChanges(workspace.id, target.ref.path))) return
      closeTab(workspace.id, node.id, id)
      const stillOpen = useTabsStore.getState().dockOf(workspace.id).tabs.some((tab) => (tab.kind === 'doc' || tab.kind === 'preview') && tab.ref.path === target.ref.path)
      if (!stillOpen) useDocumentsStore.getState().release(workspace.id, target.ref.path)
      return
    }
    closeTab(workspace.id, node.id, id)
  }
  const zoneAt = (event: DragEvent<HTMLElement>): DockDropZone => {
    const rect = event.currentTarget.getBoundingClientRect()
    const barHeight = event.currentTarget.querySelector('[data-dock-tabbar]')?.getBoundingClientRect().height ?? 40
    return dockDropZone(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, barHeight)
  }
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(DOCK_TAB_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    setDragZone(null)
    const raw = event.dataTransfer.getData(DOCK_TAB_MIME)
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as { tabId?: string; groupId?: string; workspaceId?: string }
      if (!payload.tabId || !payload.groupId || payload.workspaceId !== workspace.id) return
      const sourceGroup = findGroup(dock.root, payload.groupId)
      if (!sourceGroup?.tabIds.includes(payload.tabId)) return
      // The workspace-files tab is the only immovable tab. The rightmost
      // group itself can still receive previews, documents, terminals, and
      // browser tabs; keeping the group pinned only controls its position.
      if (dock.tabs.find((tab) => tab.id === payload.tabId)?.kind === 'files') return
      const zone = zoneAt(event)
      if (zone === 'tabs') {
        const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-dock-tab-id]')].filter((tab) => tab.dataset.dockTabId !== payload.tabId)
        const before = elements.findIndex((tab) => { const rect = tab.getBoundingClientRect(); return event.clientX < rect.left + rect.width / 2 })
        const index = before < 0 ? elements.length : before
        if (payload.groupId === node.id) reorderDock(workspace.id, node.id, node.tabIds.indexOf(payload.tabId), index)
        else moveDock(workspace.id, payload.tabId, payload.groupId, node.id, index)
      } else if (zone === 'center') {
        moveDock(workspace.id, payload.tabId, payload.groupId, node.id)
      } else {
        splitAndMoveDockTab(workspace.id, payload.tabId, payload.groupId, node.id, zone)
      }
    } catch { /* ignore malformed drag payloads */ }
  }
  return (
    <section data-dock-group-id={node.id} className={cn('app-no-drag relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-hairline', node.id === dock.activeGroupId && 'outline outline-1 outline-accent/30')} onMouseDown={() => useTabsStore.getState().activateDockGroup(workspace.id, node.id)} onDragOver={(event) => { if (!event.dataTransfer.types.includes(DOCK_TAB_MIME)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragZone(zoneAt(event)) }} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragZone(null) }} onDrop={onDrop}>
      <InnerTabBar
        tabs={tabs}
        groupId={node.id}
        workspaceId={workspace.id}
        activeId={node.activeTabId}
        runningSessionIds={runningSessionIds}
        menu={menu}
        canDragTab={(tab) => tab.kind !== 'files'}
        onActivate={(id) => activateTab(workspace.id, node.id, id)}
        onClose={(id) => { void onClose(id) }}
        onMove={(from, to) => useTabsStore.getState().reorderDockTab(workspace.id, node.id, from, to)}
        onOpen={open}
      />
      {dragZone !== null && <DropOverlay zone={dragZone} />}
      {active === undefined ? <EmptyState title={t('common.empty')} className="py-6" /> : <InnerView key={active.id} tab={active} workspace={workspace} fallbackModel={fallbackModel} />}
    </section>
  )
}

function DropOverlay({ zone }: { zone: DockDropZone }): ReactNode {
  const cls = 'pointer-events-none absolute z-20 rounded-lg border border-accent/70 bg-accent/20 shadow-lg shadow-black/10'
  if (zone === 'tabs') return <div className={cn(cls, 'inset-x-2 top-1 h-8')} />
  if (zone === 'left') return <div className={cn(cls, 'inset-y-2 left-2 w-1/2')} />
  if (zone === 'right') return <div className={cn(cls, 'inset-y-2 right-2 w-1/2')} />
  if (zone === 'up') return <div className={cn(cls, 'inset-x-2 top-2 h-1/2')} />
  if (zone === 'down') return <div className={cn(cls, 'inset-x-2 bottom-2 h-1/2')} />
  return <div className={cn(cls, 'inset-2')} />
}

function DockSplitter({ workspaceId, splitId, direction, ratio }: { workspaceId: string; splitId: string; direction: 'horizontal' | 'vertical'; ratio: number }): ReactNode {
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const resize = useTabsStore((state) => state.resizeDock)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    ref.current?.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging || ref.current?.parentElement === null || ref.current?.parentElement === undefined) return
    const rect = ref.current.parentElement.getBoundingClientRect()
    const ratio = direction === 'horizontal' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height
    resize(workspaceId, splitId, ratio)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (ref.current?.hasPointerCapture(event.pointerId)) ref.current.releasePointerCapture(event.pointerId)
    setDragging(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = direction === 'horizontal' ? (event.key === 'ArrowLeft' ? -0.03 : event.key === 'ArrowRight' ? 0.03 : 0) : (event.key === 'ArrowUp' ? -0.03 : event.key === 'ArrowDown' ? 0.03 : 0)
    if (event.key === 'Home') { resize(workspaceId, splitId, 0.5); event.preventDefault(); return }
    if (delta !== 0) { resize(workspaceId, splitId, ratio + delta); event.preventDefault() }
  }
  return <div ref={ref} role="separator" tabIndex={0} aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'} className={cn('relative z-10 shrink-0 bg-border/60', direction === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize', dragging && 'bg-accent')} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onKeyDown} onDoubleClick={() => resize(workspaceId, splitId, 0.5)} />
}
