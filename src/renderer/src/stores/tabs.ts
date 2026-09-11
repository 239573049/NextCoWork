/**
 * 内层 Tab —— **按 workspaceId 索引,不是按窗口**(方案 §8)。
 *
 * 这个归属关系是「切回某个工作区,它的 Tab 全都还在」的全部实现。
 * 反过来,如果内层 Tab 挂在窗口上,切工作区就得把 Tab 条清空再重建,
 * 用户开着的三个终端和两个文档就没了。
 *
 * **会话不是 Tab**,Tab 只**引用**一个 sessionId。所以:关掉聊天 Tab 不杀死
 * 正在跑的 run(run 在主进程的 RunRegistry 里活着)、可以在新 Tab 里重开历史会话、
 * 两个 Tab 能看同一个会话。
 */
import { create } from 'zustand'
import type { InnerTab, InnerTabKind, InnerTabState, TabPane } from '../../../shared/domain/tab'
import { chatKey, paneOf, reorderInPane, tabsInPane } from '../../../shared/domain/tab'
import { ulid } from '../../../shared/util/id'
import { getInnerTabs, persistInnerTabs } from '../services/app'
import { killTerminal } from '../services/terminal'
import { closeBrowserTab } from '../services/browser'
import { adoptDraftSession, isSessionUntouched, releaseSession } from './session'
import type { WorkspaceFileMutationRequest } from '../../../shared/domain/workspace-file'
import { isWithinPath } from './documents'
import { findGroup, migrateLegacyInnerTabs, normalizeDockState, splitGroup, moveTab as moveDockTab, reorderTab as reorderDockTab, resizeSplit, closeTab as closeDockTab, closeGroup as closeDockGroupState, addTabToGroup, type DockDirection, type DockNode } from '../../../shared/domain/dock'
import { useWindowStore } from './window'
import type { SessionChange } from '../../../shared/domain/session'

const EMPTY: InnerTabState = {
  tabs: [],
  activeTabId: null,
  bottomActiveTabId: null,
  rightActiveTabId: null
}

interface BrowserTabSyncItem {
  id: string
  clientTabId?: string
  url: string
  title: string
  source: 'user' | 'agent'
  profileId?: string
}

/**
 * 打开一个 Tab 时可以覆盖的初值。
 *
 * 存在的理由只有一个,但很硬:**在文件树里点一个文件要开的是「那个文件」**,
 * 不是又一个「未命名文档」。没有它,`open()` 就只能开空白 Tab,
 * 调用方只好开完再 `rename` + 改 ref —— 两次写盘、中间一帧标题是错的。
 */
export interface TabInit {
  title?: string
  selectedPath?: string
  /** 给 doc / draw / preview / files 用;其余 kind 忽略 */
  path?: string
  /** 给 browser 用 */
  url?: string
  /** Agent/browser manager tab identity. */
  browserId?: string
  profileId?: string
}

/** `+` 菜单里各种 kind 的初始 Tab。ref 的形状由 kind 决定,所以只能在这里分支。 */
function makeTab(kind: InnerTabKind, pane: TabPane, init: TabInit = {}): InnerTab {
  const id = ulid()
  const path = init.path ?? ''
  switch (kind) {
    case 'chat':
      /*
        ★ **`sessionId` 是 null,而且这里绝不发 `sessions:create`。**

        以前这行铸一个 ULID、紧接着一次 IPC 把它插进库,于是「新建对话」「关掉主区
        最后一个 Tab」「工作区第一次露面」各自都会在库里留下一条零消息的「新对话」。
        用户什么也没做,侧边栏却在涨 —— 而那条记录连一句话都没有,谁也认不出它是什么。

        真正需要它的时刻在别处:主进程 `runAgent` 发第一条消息时就会
        `store.ensureSession(...)`(`main/runtime.ts`),而且带的信息比这里全
        (model / mode / thinking / rootPathAtCreation)。这里那次抢跑只是让一条
        空记录提前几分钟出生。id 由 `bindChatSession` 在需要归属时才铸。
      */
      return { id, kind, pane, title: init.title ?? '新对话', ref: { sessionId: null } }
    case 'terminal':
      return { id, kind, pane, title: init.title ?? '终端', ref: { terminalId: ulid() } }
    case 'doc':
      return { id, kind, pane, title: init.title ?? '未命名文档', ref: { path } }
    case 'draw':
      return { id, kind, pane, title: init.title ?? '未命名绘图', ref: { path } }
    case 'browser':
      return {
        id,
        kind,
        pane,
        title: init.title ?? '新标签页',
        ref: {
          url: init.url ?? '',
          ...(init.browserId === undefined ? {} : { browserId: init.browserId }),
          ...(init.profileId === undefined ? {} : { profileId: init.profileId })
        }
      }
    case 'preview':
      return { id, kind, pane, title: init.title ?? '文件预览', ref: { path } }
    case 'files':
      return { id, kind, pane, title: init.title ?? '工作区文件', ref: { path, ...(init.selectedPath === undefined ? {} : { selectedPath: init.selectedPath }) } }
  }
}

interface TabsState {
  byWorkspace: Record<string, InnerTabState>

  stateOf: (workspaceId: string) => InnerTabState
  /** 某一格里的 Tab,按显示顺序 */
  tabsOf: (workspaceId: string, pane: TabPane) => InnerTab[]
  /** 某一格当前激活的 Tab id —— 两格各存各的 */
  activeIdOf: (workspaceId: string, pane: TabPane) => string | null
  dockOf: (workspaceId: string) => ReturnType<typeof migrateLegacyInnerTabs>
  activateDockGroup: (workspaceId: string, groupId: string) => void
  activateDockTab: (workspaceId: string, groupId: string, tabId: string) => void
  splitAndOpenDock: (workspaceId: string, groupId: string, direction: DockDirection, kind: InnerTabKind, pane?: TabPane) => void
  splitAndMoveDockTab: (workspaceId: string, tabId: string, fromGroupId: string, targetGroupId: string, direction: DockDirection) => void
  openDock: (workspaceId: string, groupId: string, kind: InnerTabKind, init?: TabInit, pane?: TabPane) => void
  moveDockTab: (workspaceId: string, tabId: string, fromGroupId: string, toGroupId: string, index?: number) => void
  reorderDockTab: (workspaceId: string, groupId: string, from: number, to: number) => void
  resizeDock: (workspaceId: string, splitId: string, ratio: number) => void
  closeDockTab: (workspaceId: string, groupId: string, tabId: string) => void
  closeDockGroup: (workspaceId: string, groupId: string) => void
  hydrate: (workspaceId: string, s: InnerTabState) => void
  /**
   * 工作区第一次被看到时:先取回上次的 Tab 布局,没有才开一个新对话
   * ——截图里从来没有空 Tab 条。异步但签名是 void,它挂在 effect 上。
   */
  ensure: (workspaceId: string) => void
  open: (workspaceId: string, kind: InnerTabKind, pane?: TabPane, init?: TabInit) => void
  /** 在已有会话上打开一个新 Tab（侧边栏历史会话使用）。 */
  openSession: (workspaceId: string, sessionId: string, title?: string) => void
  removeSessions: (change: Extract<SessionChange, { kind: 'deleted' }>) => void
  /**
   * 在文件树或 Markdown 链接里点一个文件时走这条,**不是 `open`**:文件会进入
   * 当前工作区的右侧工作台；同一个文件已经开着就切过去,不再开第二个。
   * `open` 反过来必须每次都新建(连点两次 `+ 新建对话`要得到两个对话),
   * 所以去重不能塞进它里面。
   */
  openPath: (workspaceId: string, kind: InnerTabKind, path: string, title: string) => void
  /**
   * 侧边栏那颗「新建对话」走这条,**也不是 `open`**。
   *
   * 区别在于这两颗按钮问的是**不同的问题**:Tab 条上的 `+ 新建对话` 说的是
   * 「再给我一个」(连点两次要得到两个,所以它必须走 `open`);侧边栏那颗说的是
   * 「我要开始一段新对话」—— 手边已经摊着一张没写过字的白纸时,再抽一张出来
   * 只会攒下一排一模一样的「新对话」,而用户以为自己什么也没做成。
   *
   * 所以:主区里已经有一个**没用过**的对话就切过去,没有才新建。
   * 「没用过」的判据是 `isSessionUntouched`,和 `ChatView` 用来决定画不画
   * 问候语那一屏的是同一个 —— 屏幕上是白纸的,这里就当白纸。
   */
  newChat: (workspaceId: string) => void
  /**
   * 给一个草稿聊天 Tab 铸出真正的 sessionId。**这是「白纸」变成「一段会话」的唯一入口。**
   *
   * 调它的只有两处,而且都在 `ChatView`:发出第一条消息、贴上第一个附件。
   * 前者显然;后者是被逼的 —— `main/db/repo.ts` 的 `recordMessageAttachments` 里
   * 有一句 `if (loc.scope !== 'session' || loc.ownerId !== session.id) return`,
   * 那是一道安全边界(渲染层不能把别的会话的图 re-home 到这条消息上)。附件在
   * 草稿键下上传的话,它的 `ncw://` owner 就永远不等于后来的会话 id,于是这张图
   * **被静默丢弃**:发送时看着好好的,重启后历史里那张图凭空消失,且没有任何报错。
   * 要么绑定时把文件和表行整体搬家(一套会部分失败的机器),要么贴图那一刻就铸 id。
   *
   * ★ **必须幂等。** 上面两条路径可能先后发生(先贴图再发送),第二次调用要拿到
   * 同一个 id,否则第二次会把第一次的附件甩掉。
   *
   * ★ 铸了 id **不等于**库里有了记录。那一行仍然只由主进程 `runAgent` 的
   * `ensureSession` 建 —— 所以「贴了图但没发送」的 Tab 有 id、有 URL、
   * 有磁盘上的草稿附件,而侧边栏里没有它。这正是我们要的。
   *
   * 返回 null = 这个 tabId 不存在或者不是 chat。
   */
  bindChatSession: (workspaceId: string, tabId: string) => string | null
  activate: (workspaceId: string, tabId: string) => void
  close: (workspaceId: string, tabId: string) => void
  applyFileMutation: (req: WorkspaceFileMutationRequest) => void
  /** `from`/`to` 是**该格内**的下标,见 shared/domain/tab.ts 的 reorderInPane */
  move: (workspaceId: string, from: number, to: number, pane?: TabPane) => void
  rename: (workspaceId: string, tabId: string, title: string) => void
  /** Session metadata is authoritative across windows; updating it never changes focus/layout. */
  syncSessionTitle: (workspaceId: string, sessionId: string, title: string) => void
  setBrowser: (workspaceId: string, tabId: string, patch: { url?: string; title?: string; browserId?: string; profileId?: string }) => void
  syncBrowserTabs: (
    workspaceId: string,
    tabs: ReadonlyArray<{
      id: string
      clientTabId?: string
      url: string
      title: string
      source: 'user' | 'agent'
      profileId?: string
    }>
  ) => void
  /** 把已经存在的 Tab 顶到它所在 Dock 组的最前面(不改 activeGroupId) */
  revealTab: (workspaceId: string, tabId: string) => void
  /** 工作区关闭时销毁:Tab 表和它那些会话的转录一起放掉(正在跑的除外) */
  forget: (workspaceId: string) => void
}

/**
 * 「哪一格的激活项」这件事只在这里分支一次。
 *
 * 三格的激活项存在**不同字段**上(`activeTabId` / `bottomActiveTabId` /
 * `rightActiveTabId`),因为它们是同时可见的三条 Tab 条 —— 合成一个字段的话,
 * 点一下底部的终端就会把主区正在看的对话取消激活。
 */
function withActive(s: InnerTabState, pane: TabPane, id: string | null): InnerTabState {
  if (pane === 'bottom') return { ...s, bottomActiveTabId: id }
  if (pane === 'right') return { ...s, rightActiveTabId: id }
  return { ...s, activeTabId: id }
}

function activeIn(s: InnerTabState, pane: TabPane): string | null {
  if (pane === 'bottom') return s.bottomActiveTabId ?? null
  if (pane === 'right') return s.rightActiveTabId ?? null
  return s.activeTabId
}

function groupForPane(dock: ReturnType<typeof migrateLegacyInnerTabs>, pane: TabPane): string | null {
  const visit = (node: DockNode): string | null => {
    if (node.type === 'group') {
      const members = dock.tabs.filter((tab) => node.tabIds.includes(tab.id))
      if (members.length > 0 && members.every((tab) => paneOf(tab) === pane)) return node.id
      return null
    }
    return visit(node.first) ?? visit(node.second)
  }
  return visit(dock.root)
}

function groupContainingTab(dock: ReturnType<typeof migrateLegacyInnerTabs>, tabId: string): string | null {
  const visit = (node: DockNode): string | null => {
    if (node.type === 'group') return node.tabIds.includes(tabId) ? node.id : null
    return visit(node.first) ?? visit(node.second)
  }
  return visit(dock.root)
}

/** A split inherits the pane its anchor group sits in, never the drag direction. */
function paneOfGroup(dock: ReturnType<typeof migrateLegacyInnerTabs>, groupId: string): TabPane {
  const node = findGroup(dock.root, groupId)
  if (node === null) return 'main'
  if (node.pinned === 'right') return 'right'
  const members = dock.tabs.filter((tab) => node.tabIds.includes(tab.id))
  const head = members[0]
  return head !== undefined && members.every((tab) => paneOf(tab) === paneOf(head)) ? paneOf(head) : 'main'
}

export const useTabsStore = create<TabsState>((set, get) => {
  const dockCache = new Map<string, { source: InnerTabState; dock: ReturnType<typeof migrateLegacyInnerTabs> }>()
  const withDock = (state: InnerTabState): InnerTabState => {
    let dock = normalizeDockState(state.dock ?? migrateLegacyInnerTabs(state), state.tabs)
    const present = new Set<string>()
    const collect = (node: DockNode): void => {
      if (node.type === 'group') { node.tabIds.forEach((id) => present.add(id)); return }
      collect(node.first); collect(node.second)
    }
    collect(dock.root)
    // Legacy callers and browser events can add a tab to `tabs` before the
    // Dock tree knows about it. Attach those orphans to the matching pane
    // group so the next render never leaves a tab unmounted.
    for (const tab of state.tabs) {
      if (present.has(tab.id)) continue
      const wanted = paneOf(tab)
      const groups: Array<{ id: string; pane: TabPane | null }> = []
      const visit = (node: DockNode): void => {
        if (node.type === 'group') {
          const members = state.tabs.filter((item) => node.tabIds.includes(item.id))
          groups.push({ id: node.id, pane: members[0] && members.every((item) => paneOf(item) === paneOf(members[0]!)) ? paneOf(members[0]!) : null })
          return
        }
        visit(node.first); visit(node.second)
      }
      visit(dock.root)
      const target = groups.find((group) => group.pane === wanted)?.id ?? groups.find((group) => group.pane === 'main')?.id
      if (target === undefined) continue
      const add = (node: DockNode): DockNode => {
        if (node.type === 'group') return node.id === target ? { ...node, tabIds: [...node.tabIds, tab.id], activeTabId: node.activeTabId ?? tab.id, hidden: false } : node
        return { ...node, first: add(node.first), second: add(node.second) }
      }
      dock = { ...dock, root: add(dock.root) }
      present.add(tab.id)
    }
    // Old activation fields are still accepted during migration. Once a
    // Dock snapshot exists, the Dock group's active id is authoritative.
    if (state.dock === undefined) {
      const activeIds = [state.activeTabId, state.bottomActiveTabId ?? null, state.rightActiveTabId ?? null].filter((id): id is string => id !== null)
      const activate = (node: DockNode): DockNode => {
        if (node.type === 'group') {
          const id = activeIds.find((candidate) => node.tabIds.includes(candidate))
          return id === undefined ? node : { ...node, activeTabId: id }
        }
        return { ...node, first: activate(node.first), second: activate(node.second) }
      }
      dock = { ...dock, root: activate(dock.root) }
    }
    // Recover older layouts where every chat was moved into a collapsible
    // panel. Reuse one of those sessions in the main pane so hiding the right
    // workbench cannot hide the entire conversation area.
    const chats = dock.tabs.filter((tab) => tab.kind === 'chat')
    if (chats.length > 0 && !chats.some((tab) => paneOf(tab) === 'main')) {
      const chat = chats[0]!
      const source = groupContainingTab(dock, chat.id)
      let destination = groupForPane(dock, 'main')
      if (source !== null && destination === null) {
        dock = splitGroup(dock, source, 'left')
        destination = dock.activeGroupId
      }
      if (source !== null && destination !== null) {
        dock = moveDockTab(dock, chat.id, source, destination)
        return { ...state, activeTabId: chat.id, tabs: dock.tabs, dock }
      }
    }
    return { ...state, tabs: dock.tabs, dock }
  }
  const write = (workspaceId: string, next: InnerTabState): void => {
    const normalized = withDock(next)
    set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: normalized } })
    persistInnerTabs(workspaceId, normalized)
  }

  /** 正在取持久化布局的工作区。`ensure` 挂在 effect 上,会被重入。 */
  const loading = new Set<string>()
  const pendingTitles = new Map<string, Map<string, string>>()
  // Agent events can arrive for a workspace that is not currently visible.
  // Keep them pending until that workspace's persisted inner tabs are hydrated,
  // otherwise a background browser event could overwrite its chat tabs.
  const pendingBrowser = new Map<string, readonly BrowserTabSyncItem[]>()

  function applyPendingBrowser(workspaceId: string): void {
    const pending = pendingBrowser.get(workspaceId)
    if (pending === undefined) return
    pendingBrowser.delete(workspaceId)
    get().syncBrowserTabs(workspaceId, pending)
  }

  async function loadOrSeed(workspaceId: string): Promise<void> {
    const snapshot = await getInnerTabs(workspaceId)
    const renamed = pendingTitles.get(workspaceId)
    const persisted = withDock({ ...snapshot, tabs: snapshot.tabs.map((tab) => {
      const title = tab.kind === 'chat' && tab.ref.sessionId !== null ? renamed?.get(tab.ref.sessionId) : undefined
      return title === undefined ? tab : { ...tab, title }
    }) })
    // 这一趟 IPC 期间用户可能已经自己开了一个 Tab —— 那份是新的,别覆盖它
    if (get().byWorkspace[workspaceId] !== undefined) {
      applyPendingBrowser(workspaceId)
      return
    }
    if (persisted.tabs.length > 0) {
      set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: persisted } })
      applyPendingBrowser(workspaceId)
      return
    }
    const tab = makeTab('chat', 'main')
    write(workspaceId, {
      tabs: [tab],
      activeTabId: tab.id,
      bottomActiveTabId: null,
      rightActiveTabId: null
    })
    applyPendingBrowser(workspaceId)
  }

  return {
    byWorkspace: {},

    stateOf(workspaceId) {
      return get().byWorkspace[workspaceId] ?? EMPTY
    },

    tabsOf(workspaceId, pane) {
      return tabsInPane(get().stateOf(workspaceId).tabs, pane)
    },

    activeIdOf(workspaceId, pane) {
      return activeIn(get().stateOf(workspaceId), pane)
    },

    dockOf(workspaceId) {
      const state = get().stateOf(workspaceId)
      const cached = dockCache.get(workspaceId)
      if (cached?.source === state) return cached.dock
      const dock = normalizeDockState(state.dock ?? migrateLegacyInnerTabs(state), state.tabs)
      dockCache.set(workspaceId, { source: state, dock })
      return dock
    },

    activateDockGroup(workspaceId, groupId) {
      const cur = get().stateOf(workspaceId)
      const dock = get().dockOf(workspaceId)
      const visit = (node: import('../../../shared/domain/dock').DockNode): boolean =>
        node.type === 'group' ? node.id === groupId : visit(node.first) || visit(node.second)
      if (!visit(dock.root)) return
      if (dock.activeGroupId === groupId) return
      write(workspaceId, { ...cur, dock: { ...dock, activeGroupId: groupId } })
    },

    activateDockTab(workspaceId, groupId, tabId) {
      const cur = get().stateOf(workspaceId)
      const dock = get().dockOf(workspaceId)
      const target = dock.root && (() => {
        const visit = (node: import('../../../shared/domain/dock').DockNode): boolean => {
          if (node.type === 'group') {
            if (node.id !== groupId) return false
            return node.tabIds.includes(tabId)
          }
          return visit(node.first) || visit(node.second)
        }
        return visit(dock.root)
      })()
      if (!target) return
      const update = (node: import('../../../shared/domain/dock').DockNode): import('../../../shared/domain/dock').DockNode => {
        if (node.type === 'group') return node.id === groupId ? { ...node, activeTabId: tabId } : node
        return { ...node, first: update(node.first), second: update(node.second) }
      }
      const tab = cur.tabs.find((item) => item.id === tabId)
      write(workspaceId, withActive({ ...cur, dock: { ...dock, root: update(dock.root), activeGroupId: groupId } }, tab === undefined ? 'main' : paneOf(tab), tabId))
    },

    splitAndOpenDock(workspaceId, groupId, direction, kind, pane = 'main') {
      const cur = get().stateOf(workspaceId)
      const dock = get().dockOf(workspaceId)
      if (!findGroup(dock.root, groupId)) return
      const split = splitGroup(dock, groupId, direction)
      if (split.activeGroupId === null) return
      const tab = makeTab(kind, pane)
      const next = addTabToGroup(split, split.activeGroupId, tab)
      write(workspaceId, { ...cur, tabs: next.tabs, dock: next })
    },

    splitAndMoveDockTab(workspaceId, tabId, fromGroupId, targetGroupId, direction) {
      const cur = get().stateOf(workspaceId)
      const dock = get().dockOf(workspaceId)
      if (!findGroup(dock.root, fromGroupId)?.tabIds.includes(tabId) || !findGroup(dock.root, targetGroupId)) return
      const moving = dock.tabs.find((tab) => tab.id === tabId)
      /*
        ★ 新格属于**目标格所在的那一面板**,不是拖动方向。按方向推 pane 的话,
        在主区往下拖会把这个 Tab 标成 `bottom`,而底部面板默认是收起的 ——
        `visibleDockNode` 会把整格滤掉,表现是「会话拖完就没了,侧栏点它也没反应」。
      */
      const destinationPane: TabPane = paneOfGroup(dock, targetGroupId)
      if (moving?.kind === 'chat' && paneOf(moving) === 'main' && destinationPane !== 'main') {
        const mainChats = dock.tabs.filter((tab) => tab.kind === 'chat' && paneOf(tab) === 'main')
        if (mainChats.length <= 1) return
      }
      const split = splitGroup(dock, targetGroupId, direction)
      const destination = split.activeGroupId
      if (destination === null) return
      const moved = moveDockTab(split, tabId, fromGroupId, destination)
      const next = {
        ...moved,
        tabs: moved.tabs.map((tab) => tab.id === tabId ? { ...tab, pane: destinationPane } : tab)
      }
      write(workspaceId, { ...cur, tabs: next.tabs, dock: next })
    },

    openDock(workspaceId, groupId, kind, init, pane = 'main') {
      const cur = get().stateOf(workspaceId)
      const tab = makeTab(kind, pane, init)
      write(workspaceId, { ...cur, dock: addTabToGroup(get().dockOf(workspaceId), groupId, tab), tabs: [...cur.tabs, tab] })
    },

    moveDockTab(workspaceId, tabId, fromGroupId, toGroupId, index) {
      const cur = get().stateOf(workspaceId)
      const dock = moveDockTab(get().dockOf(workspaceId), tabId, fromGroupId, toGroupId, index)
      if (dock === get().dockOf(workspaceId)) return
      write(workspaceId, { ...cur, tabs: dock.tabs, dock })
    },

    reorderDockTab(workspaceId, groupId, from, to) {
      const cur = get().stateOf(workspaceId)
      write(workspaceId, { ...cur, dock: reorderDockTab(get().dockOf(workspaceId), groupId, from, to) })
    },

    resizeDock(workspaceId, splitId, ratio) {
      const cur = get().stateOf(workspaceId)
      write(workspaceId, { ...cur, dock: resizeSplit(get().dockOf(workspaceId), splitId, ratio) })
    },

    closeDockTab(workspaceId, groupId, tabId) {
      const cur = get().stateOf(workspaceId)
      if (!findGroup(get().dockOf(workspaceId).root, groupId)?.tabIds.includes(tabId)) return
      const target = cur.tabs.find((tab) => tab.id === tabId)
      if (target?.kind === 'chat' && paneOf(target) === 'main' && cur.tabs.filter((tab) => tab.kind === 'chat' && paneOf(tab) === 'main').length <= 1) return
      if (target?.kind === 'terminal') void killTerminal(target.ref.terminalId).catch(() => undefined)
      if (target?.kind === 'browser' && target.ref.browserId !== undefined) void closeBrowserTab(workspaceId, target.ref.browserId).catch(() => undefined)
      const dock = closeDockTab(get().dockOf(workspaceId), groupId, tabId)
      if (dock.tabs.length === 0) {
        const chat = makeTab('chat', 'main')
        write(workspaceId, { ...cur, tabs: [chat], activeTabId: chat.id, dock: addTabToGroup({ ...dock, tabs: [] }, dock.activeGroupId ?? groupId, chat) })
        return
      }
      write(workspaceId, { ...cur, tabs: dock.tabs, dock })
    },

    closeDockGroup(workspaceId, groupId) {
      const cur = get().stateOf(workspaceId)
      const target = get().dockOf(workspaceId).root
      const ids: string[] = []
      const visit = (node: import('../../../shared/domain/dock').DockNode): void => {
        if (node.type === 'group') { if (node.id === groupId) ids.push(...node.tabIds); return }
        visit(node.first); visit(node.second)
      }
      visit(target)
      const remainingMainChats = cur.tabs.filter((tab) => tab.kind === 'chat' && paneOf(tab) === 'main' && !ids.includes(tab.id))
      if (remainingMainChats.length === 0) return
      for (const id of ids) {
        const tab = cur.tabs.find((item) => item.id === id)
        if (tab?.kind === 'terminal') void killTerminal(tab.ref.terminalId).catch(() => undefined)
        if (tab?.kind === 'browser' && tab.ref.browserId !== undefined) void closeBrowserTab(workspaceId, tab.ref.browserId).catch(() => undefined)
      }
      const dock = closeDockGroupState(get().dockOf(workspaceId), groupId)
      if (dock.tabs.length === 0) {
        const chat = makeTab('chat', 'main')
        write(workspaceId, { ...cur, tabs: [chat], activeTabId: chat.id, dock: addTabToGroup({ ...dock, tabs: [] }, dock.activeGroupId ?? groupId, chat) })
      } else write(workspaceId, { ...cur, tabs: dock.tabs, dock })
    },

    hydrate(workspaceId, s) {
      // Keep hydrate's object identity for callers that use it as an in-memory
      // snapshot (and let dockOf cache/normalize the derived Dock view).
      const chats = s.tabs.filter((tab) => tab.kind === 'chat')
      const state = chats.length > 0 && !chats.some((tab) => paneOf(tab) === 'main') ? withDock(s) : s
      set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: state } })
      applyPendingBrowser(workspaceId)
    },

    ensure(workspaceId) {
      if (get().byWorkspace[workspaceId] !== undefined || loading.has(workspaceId)) return
      loading.add(workspaceId)
      void loadOrSeed(workspaceId)
        .catch((err: unknown) => {
          // 读不回来就当全新工作区处理 —— 空 Tab 条比一个错误提示更没得做
          console.error('[tabs] 内层 Tab 布局读取失败,按新工作区处理:', err)
          if (get().byWorkspace[workspaceId] === undefined) {
            const tab = makeTab('chat', 'main')
            write(workspaceId, {
              tabs: [tab],
              activeTabId: tab.id,
              bottomActiveTabId: null,
              rightActiveTabId: null
            })
          }
        })
        .finally(() => {
          loading.delete(workspaceId)
          pendingTitles.delete(workspaceId)
          applyPendingBrowser(workspaceId)
        })
    },

    open(workspaceId, kind, pane = 'main', init) {
      const cur = get().stateOf(workspaceId)
      const tab = makeTab(kind, pane, init)
      const dock = get().dockOf(workspaceId)
      const groupId = groupForPane(dock, pane) ?? dock.activeGroupId ?? (dock.root.type === 'group' ? dock.root.id : null)
      if (groupId === null) return
      const nextDock = addTabToGroup(dock, groupId, tab)
      write(workspaceId, withActive({ ...cur, tabs: nextDock.tabs, dock: nextDock }, pane, tab.id))
    },

    openSession(workspaceId, sessionId, title) {
      const cur = get().stateOf(workspaceId)
      const existing = cur.tabs.find((t) => t.kind === 'chat' && t.ref.sessionId === sessionId)
      if (existing !== undefined) {
        // The conversation may live in a collapsed panel; activating it alone
        // would look like the sidebar click did nothing.
        if (paneOf(existing) === 'right') useWindowStore.getState().setRightPanelForWorkspace(workspaceId, true)
        if (paneOf(existing) === 'bottom') useWindowStore.getState().setBottomPanelForWorkspace(workspaceId, true)
        const groupId = groupContainingTab(get().dockOf(workspaceId), existing.id)
        if (groupId) get().activateDockTab(workspaceId, groupId, existing.id)
        return
      }
      // Build the tab directly from the existing session id. Calling makeTab
      // first creates a second, throw-away id (and used to make opening a
      // history item look like it created a new conversation).
      const chat: InnerTab = {
        id: ulid(),
        kind: 'chat',
        pane: 'main',
        title: title?.trim() ?? '',
        ref: { sessionId }
      }
      const dock = get().dockOf(workspaceId)
      const groupId = groupForPane(dock, 'main') ?? dock.activeGroupId ?? (dock.root.type === 'group' ? dock.root.id : null)
      if (groupId === null) return
      const nextDock = addTabToGroup(dock, groupId, chat)
      write(workspaceId, withActive({ ...cur, tabs: nextDock.tabs, dock: nextDock }, 'main', chat.id))
    },

    removeSessions(change) {
      const deleted = new Set(change.sessionIds)
      for (const [workspaceId, state] of Object.entries(get().byWorkspace)) {
        const affected = state.tabs.filter((tab) => tab.kind === 'chat' && tab.ref.sessionId !== null && deleted.has(tab.ref.sessionId))
        if (affected.length === 0) continue
        const replacement = change.replacement
        if (affected.some((tab) => tab.id === state.activeTabId)
          && replacement?.workspaceId === workspaceId && !deleted.has(replacement.id)) {
          get().openSession(workspaceId, replacement.id, replacement.title)
        }
        for (const tab of affected) get().close(workspaceId, tab.id)
      }
    },

    openPath(workspaceId, kind, path, title) {
      const cur = get().stateOf(workspaceId)
      // 文件打开属于当前工作区的右侧工作台。后台工作区也只展开自己的面板，
      // 不会改变窗口当前正在看的工作区。
      useWindowStore.getState().setRightPanelForWorkspace(workspaceId, true)
      let dock = get().dockOf(workspaceId)
      const existing = cur.tabs.find(
        (t) => t.kind === kind && 'path' in t.ref && t.ref.path === path
      )
      if (existing !== undefined) {
        const sourceGroupId = groupContainingTab(dock, existing.id)
        if (sourceGroupId === null) return
        if (paneOf(existing) === 'right') {
          get().activateDockTab(workspaceId, sourceGroupId, existing.id)
          return
        }
        // Layouts persisted before file tabs moved to the right may still
        // contain this document in the main pane. Move that existing tab so
        // opening it again does not leave a duplicate behind.
        let targetGroupId = groupForPane(dock, 'right')
        if (targetGroupId === null) {
          const base = dock.activeGroupId ?? (dock.root.type === 'group' ? dock.root.id : null)
          if (base === null) return
          dock = splitGroup(dock, base, 'right')
          targetGroupId = dock.activeGroupId
        }
        if (targetGroupId === null) return
        const movedDock = moveDockTab(dock, existing.id, sourceGroupId, targetGroupId)
        // An empty group has no pane hint for the shared move helper to infer;
        // this destination is explicitly the right workbench.
        const nextDock = {
          ...movedDock,
          tabs: movedDock.tabs.map((tab) => tab.id === existing.id ? { ...tab, pane: 'right' as const } : tab)
        }
        write(workspaceId, withActive({ ...cur, tabs: nextDock.tabs, dock: nextDock }, 'right', existing.id))
        return
      }
      const tab = makeTab(kind, 'right', { path, title })
      let groupId = groupForPane(dock, 'right')
      // If the right side has never been created, split it now so a file link
      // opened from a chat is immediately visible in the right workbench.
      if (groupId === null) {
        const base = dock.activeGroupId ?? (dock.root.type === 'group' ? dock.root.id : null)
        if (base === null) return
        dock = splitGroup(dock, base, 'right')
        groupId = dock.activeGroupId
      }
      if (groupId === null) return
      const nextDock = addTabToGroup(dock, groupId, tab)
      write(workspaceId, withActive({ ...cur, tabs: nextDock.tabs, dock: nextDock }, 'right', tab.id))
    },

    newChat(workspaceId) {
      const cur = get().stateOf(workspaceId)
      const chats = tabsInPane(cur.tabs, 'main').filter(
        (t): t is Extract<InnerTab, { kind: 'chat' }> => t.kind === 'chat'
      )
      /*
        ★ **只有还没绑定会话的草稿 Tab 才可能是白纸。**
        `isSessionUntouched` 查的是渲染层的 store 注册表,而那些 store 是懒创建的
        —— 重启后布局从盘里读回来,除了当前那一个,其余 chat Tab 都还没挂载过,
        注册表里查不到,于是「查不到就是没碰过」把**跑过一整段对话的会话**也算成了
        白纸。症状就是点「新建对话」跳进一个早就执行过的会话。
        绑过 sessionId 就说明它至少发过一条消息或贴过一个附件(见 `bindChatSession`),
        无论 store 在不在,它都不是白纸。

        先看当前这一个 —— 已经站在一张白纸前时,这一下应该什么也不发生,
        而不是切到另一张同样空白的纸上(那看着像点错了)。
        否则取**最靠后**的那一个:`open` 是往后追加的,所以上一次「新建对话」
        给出来的就是最后那一个。
      */
      const active = activeIn(cur, 'main')
      const blank = (t: Extract<InnerTab, { kind: 'chat' }>): boolean =>
        t.ref.sessionId === null && isSessionUntouched(chatKey(t))
      const reusable =
        chats.find((t) => t.id === active && blank(t)) ??
        [...chats].reverse().find(blank)

      if (reusable === undefined) {
        get().open(workspaceId, 'chat')
        return
      }
      get().activate(workspaceId, reusable.id)
    },

    bindChatSession(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const target = cur.tabs.find((t) => t.id === tabId)
      if (target === undefined || target.kind !== 'chat') return null
      if (target.ref.sessionId !== null) return target.ref.sessionId

      const sessionId = ulid()
      // 搬家在写 ref **之前**:写完 ref 会触发一轮渲染,而 `views/registry.tsx`
      // 的 key 挂在 chatKey 上 —— ChatView 重挂时新键的 store 里必须已经有草稿了,
      // 否则输入框会先闪一帧空白。
      adoptDraftSession(tabId, sessionId)
      const tabs = cur.tabs.map((t) =>
        t.id === tabId && t.kind === 'chat' ? { ...t, ref: { sessionId } } : t
      )
      write(workspaceId, { ...cur, tabs })
      return sessionId
    },

    activate(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const tab = cur.tabs.find((t) => t.id === tabId)
      if (tab === undefined) return
      const groupId = groupContainingTab(get().dockOf(workspaceId), tabId)
      if (groupId === null) return
      const dock = get().dockOf(workspaceId)
      const activate = (node: DockNode): DockNode => {
        if (node.type === 'group') return node.id === groupId ? { ...node, activeTabId: tabId } : node
        return { ...node, first: activate(node.first), second: activate(node.second) }
      }
      write(workspaceId, withActive({ ...cur, dock: { ...dock, root: activate(dock.root), activeGroupId: groupId } }, paneOf(tab), tabId))
    },

    close(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const target = cur.tabs.find((t) => t.id === tabId)
      if (target === undefined) return
      const pane = paneOf(target)

      // A terminal is a real PTY owned by the main process. Closing its tab is
      // the explicit lifecycle boundary; switching tabs only unmounts xterm
      // and intentionally keeps the shell (and its scrollback) alive.
      if (target.kind === 'terminal') void killTerminal(target.ref.terminalId).catch(() => undefined)
      if (target.kind === 'browser' && target.ref.browserId !== undefined) {
        void closeBrowserTab(workspaceId, target.ref.browserId).catch(() => undefined)
      }

      // 下一个激活项在**本格内**顺位递补 —— 关掉底部的终端不该跳到主区的对话上
      const siblings = tabsInPane(cur.tabs, pane)
      const idx = siblings.findIndex((t) => t.id === tabId)
      const rest = siblings.filter((t) => t.id !== tabId)
      const nextActive =
        activeIn(cur, pane) === tabId
          ? (rest[idx]?.id ?? rest[idx - 1]?.id ?? null)
          : activeIn(cur, pane)

      const tabs = cur.tabs.filter((t) => t.id !== tabId)

      /*
        「关掉最后一个就补一个空对话」**只对主区成立**。底部那条空掉是合法状态 ——
        它对应「把底部面板关掉」这个动作(AppShell 看到最后一个被关就收起面板)。
        照搬到底部的话,面板就永远关不掉:关一个补一个。
      */
      if (pane === 'main' && !tabs.some((tab) => tab.kind === 'chat' && paneOf(tab) === 'main')) {
        const tab = makeTab('chat', 'main')
        // Session cleanup can close a chat while document tabs remain. Keep
        // the main pane usable by replacing the removed session with a draft.
        write(workspaceId, { ...cur, tabs: [...tabs, tab], activeTabId: tab.id })
        return
      }
      write(workspaceId, withActive({ ...cur, tabs }, pane, nextActive))
    },

    move(workspaceId, from, to, pane = 'main') {
      const cur = get().stateOf(workspaceId)
      write(workspaceId, { ...cur, tabs: reorderInPane(cur.tabs, pane, from, to) })
    },

    rename(workspaceId, tabId, title) {
      const cur = get().stateOf(workspaceId)
      const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, title } : t))
      write(workspaceId, { ...cur, tabs })
    },

    syncSessionTitle(workspaceId, sessionId, title) {
      if (loading.has(workspaceId)) {
        const pending = pendingTitles.get(workspaceId) ?? new Map<string, string>()
        pending.set(sessionId, title)
        pendingTitles.set(workspaceId, pending)
      }
      const current = get().byWorkspace[workspaceId]
      if (current === undefined) return
      let changed = false
      const tabs = current.tabs.map((tab) => {
        if (tab.kind !== 'chat' || tab.ref.sessionId !== sessionId || tab.title === title) return tab
        changed = true
        return { ...tab, title }
      })
      // No layout write: another window may have a newer tab order. Reloads
      // resolve titles from sessions through tabs:getInner instead.
      if (changed) set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: { ...current, tabs } } })
    },

    setBrowser(workspaceId, tabId, patch) {
      const cur = get().stateOf(workspaceId)
      const tabs = cur.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'browser') return tab
        return {
          ...tab,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ref: {
            ...tab.ref,
            ...(patch.url === undefined ? {} : { url: patch.url }),
            ...(patch.browserId === undefined ? {} : { browserId: patch.browserId }),
            ...(patch.profileId === undefined ? {} : { profileId: patch.profileId })
          }
        }
      })
      write(workspaceId, { ...cur, tabs })
    },

    syncBrowserTabs(workspaceId, remoteTabs) {
      if (get().byWorkspace[workspaceId] === undefined) {
        pendingBrowser.set(workspaceId, [...remoteTabs])
        get().ensure(workspaceId)
        return
      }
      const cur = get().stateOf(workspaceId)
      const remoteIds = new Set(remoteTabs.map((tab) => tab.id))
      let tabs = [...cur.tabs]
      let changed = false
      let activatedAgentTabId: string | null = null
      for (const remote of remoteTabs) {
        const existing = tabs.find(
          (tab): tab is Extract<InnerTab, { kind: 'browser' }> =>
            tab.kind === 'browser' &&
            (
              tab.ref.browserId === remote.id ||
              (
                remote.source === 'user' &&
                remote.clientTabId !== undefined &&
                tab.id === remote.clientTabId
              )
            )
        )
        if (existing !== undefined) {
          if (
            existing.ref.url !== remote.url ||
            existing.title !== remote.title ||
            existing.ref.browserId !== remote.id ||
            existing.ref.profileId !== remote.profileId
          ) {
            tabs = tabs.map((tab) =>
              tab.id === existing.id && tab.kind === 'browser'
                ? {
                    ...tab,
                    title: remote.title,
                    ref: {
                      ...tab.ref,
                      url: remote.url,
                      browserId: remote.id,
                      ...(remote.profileId === undefined ? {} : { profileId: remote.profileId })
                    }
                  }
                : tab
            )
            changed = true
          }
          continue
        }
        // Agent tabs live in the right workbench so they never replace the
        // conversation currently being edited in the main pane.
        const id = remote.source === 'user' && remote.clientTabId !== undefined
          ? remote.clientTabId
          : ulid()
        tabs.push({
          id,
          kind: 'browser',
          pane: remote.source === 'agent' ? 'right' : 'main',
          title: remote.title,
          ref: {
            url: remote.url,
            browserId: remote.id,
            ...(remote.profileId === undefined ? {} : { profileId: remote.profileId })
          }
        })
        if (remote.source === 'agent') activatedAgentTabId = id
        changed = true
      }
      const beforePrune = tabs.length
      tabs = tabs.filter(
        (tab) =>
          tab.kind !== 'browser' ||
          tab.ref.browserId === undefined ||
          remoteIds.has(tab.ref.browserId)
      )
      if (tabs.length !== beforePrune) changed = true
      if (changed) {
        if (tabsInPane(tabs, 'main').length === 0) {
          const chat = makeTab('chat', 'main')
          tabs = [...tabs, chat]
        }
        const main = tabsInPane(tabs, 'main')
        const bottom = tabsInPane(tabs, 'bottom')
        const right = tabsInPane(tabs, 'right')
        const nextMain = main.some((tab) => tab.id === cur.activeTabId) ? cur.activeTabId : main[0]?.id ?? null
        const nextBottom = bottom.some((tab) => tab.id === cur.bottomActiveTabId)
          ? cur.bottomActiveTabId ?? null
          : bottom[0]?.id ?? null
        const nextRight = right.some((tab) => tab.id === cur.rightActiveTabId)
          ? cur.rightActiveTabId ?? null
          : right[0]?.id ?? null
        write(workspaceId, {
          ...cur,
          tabs,
          activeTabId: nextMain,
          bottomActiveTabId: nextBottom,
          rightActiveTabId: activatedAgentTabId ?? nextRight
        })
        if (activatedAgentTabId !== null) get().revealTab(workspaceId, activatedAgentTabId)
      }
    },

    /*
      `write` 只会把新 Tab 挂进 Dock 组,不会抢走那一组已经激活的 Tab
      (右侧那组默认停在「工作区文件」上)。Agent 打开的浏览器必须自己浮到
      前面来,否则它只是多了一个看不见的标签。这里**不动 activeGroupId** ——
      后台开一个页面不该把用户正在打字的那一格的焦点抢过去。
    */
    revealTab(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const tab = cur.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return
      const dock = get().dockOf(workspaceId)
      const groupId = groupContainingTab(dock, tabId)
      if (groupId === null) return
      const group = findGroup(dock.root, groupId)
      if (group === null || group.activeTabId === tabId) return
      const update = (node: DockNode): DockNode =>
        node.type === 'group'
          ? (node.id === groupId ? { ...node, activeTabId: tabId, hidden: false } : node)
          : { ...node, first: update(node.first), second: update(node.second) }
      write(workspaceId, withActive({ ...cur, dock: { ...dock, root: update(dock.root) } }, paneOf(tab), tabId))
    },

    applyFileMutation(req) {
      if (!['rename', 'move', 'delete'].includes(req.operation)) return
      const cur = get().stateOf(req.workspaceId)
      if (req.operation === 'delete') {
        for (const tab of cur.tabs) {
          if ('path' in tab.ref && isWithinPath(tab.ref.path, req.path)) get().close(req.workspaceId, tab.id)
        }
        return
      }
      if (!req.destination) return
      const destination = req.destination
      const tabs = cur.tabs.map((tab): InnerTab => {
        if (!('path' in tab.ref) || !isWithinPath(tab.ref.path, req.path)) return tab
        const path = destination + tab.ref.path.slice(req.path.length)
        return { ...tab, ref: { path }, title: path.split('/').pop() ?? path } as InnerTab
      })
      if (tabs.some((tab, i) => tab !== cur.tabs[i])) write(req.workspaceId, { ...cur, tabs })
    },

    forget(workspaceId) {
      /*
        会话 store 一起放掉。**这里是唯一放得掉的地方** —— 内层 Tab 表是全应用
        唯一知道「这个工作区有哪些 sessionId」的东西,别处想放也没有名单。

        正在跑的那几个放不掉(`releaseSession` 自己会拒绝),这是故意的:
        run 活在主进程,关掉工作区不该把它从渲染层的账上抹掉。
      */
      for (const t of get().stateOf(workspaceId).tabs) {
        if (t.kind === 'chat') releaseSession(chatKey(t))
      }
      const next = { ...get().byWorkspace }
      delete next[workspaceId]
      dockCache.delete(workspaceId)
      set({ byWorkspace: next })
    }
  }
})
