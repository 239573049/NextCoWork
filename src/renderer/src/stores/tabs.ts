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
import { paneOf, reorderInPane, tabsInPane } from '../../../shared/domain/tab'
import { ulid } from '../../../shared/util/id'
import { getInnerTabs, persistInnerTabs } from '../services/app'
import { isSessionUntouched, releaseSession } from './session'

const EMPTY: InnerTabState = {
  tabs: [],
  activeTabId: null,
  bottomActiveTabId: null,
  rightActiveTabId: null
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
  /** 给 doc / draw / preview / files 用;其余 kind 忽略 */
  path?: string
  /** 给 browser 用 */
  url?: string
}

/** `+` 菜单里各种 kind 的初始 Tab。ref 的形状由 kind 决定,所以只能在这里分支。 */
function makeTab(kind: InnerTabKind, pane: TabPane, init: TabInit = {}): InnerTab {
  const id = ulid()
  const path = init.path ?? ''
  switch (kind) {
    case 'chat':
      return { id, kind, pane, title: init.title ?? '新对话', ref: { sessionId: ulid() } }
    case 'terminal':
      return { id, kind, pane, title: init.title ?? '终端', ref: { terminalId: ulid() } }
    case 'doc':
      return { id, kind, pane, title: init.title ?? '未命名文档', ref: { path } }
    case 'draw':
      return { id, kind, pane, title: init.title ?? '未命名绘图', ref: { path } }
    case 'browser':
      return { id, kind, pane, title: init.title ?? '新标签页', ref: { url: init.url ?? '' } }
    case 'preview':
      return { id, kind, pane, title: init.title ?? '文件预览', ref: { path } }
    case 'files':
      return { id, kind, pane, title: init.title ?? '工作区文件', ref: { path } }
  }
}

interface TabsState {
  byWorkspace: Record<string, InnerTabState>

  stateOf: (workspaceId: string) => InnerTabState
  /** 某一格里的 Tab,按显示顺序 */
  tabsOf: (workspaceId: string, pane: TabPane) => InnerTab[]
  /** 某一格当前激活的 Tab id —— 两格各存各的 */
  activeIdOf: (workspaceId: string, pane: TabPane) => string | null
  hydrate: (workspaceId: string, s: InnerTabState) => void
  /**
   * 工作区第一次被看到时:先取回上次的 Tab 布局,没有才开一个新对话
   * ——截图里从来没有空 Tab 条。异步但签名是 void,它挂在 effect 上。
   */
  ensure: (workspaceId: string) => void
  open: (workspaceId: string, kind: InnerTabKind, pane?: TabPane, init?: TabInit) => void
  /**
   * 在文件树里点一个文件时走这条,**不是 `open`**:同一个文件已经开着就切过去,
   * 不再开第二个。`open` 反过来必须每次都新建(连点两次 `+ 新建对话`
   * 要得到两个对话),所以去重不能塞进它里面。
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
  activate: (workspaceId: string, tabId: string) => void
  close: (workspaceId: string, tabId: string) => void
  /** `from`/`to` 是**该格内**的下标,见 shared/domain/tab.ts 的 reorderInPane */
  move: (workspaceId: string, from: number, to: number, pane?: TabPane) => void
  rename: (workspaceId: string, tabId: string, title: string) => void
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

export const useTabsStore = create<TabsState>((set, get) => {
  const write = (workspaceId: string, next: InnerTabState): void => {
    set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: next } })
    persistInnerTabs(workspaceId, next)
  }

  /** 正在取持久化布局的工作区。`ensure` 挂在 effect 上,会被重入。 */
  const loading = new Set<string>()

  async function loadOrSeed(workspaceId: string): Promise<void> {
    const persisted = await getInnerTabs(workspaceId)
    // 这一趟 IPC 期间用户可能已经自己开了一个 Tab —— 那份是新的,别覆盖它
    if (get().byWorkspace[workspaceId] !== undefined) return
    if (persisted.tabs.length > 0) {
      // 读回来的和写出去的是同一份,不回写 —— 否则每次启动都白打一次盘
      set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: persisted } })
      return
    }
    const tab = makeTab('chat', 'main')
    write(workspaceId, {
      tabs: [tab],
      activeTabId: tab.id,
      bottomActiveTabId: null,
      rightActiveTabId: null
    })
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

    hydrate(workspaceId, s) {
      set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: s } })
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
        .finally(() => loading.delete(workspaceId))
    },

    open(workspaceId, kind, pane = 'main', init) {
      const cur = get().stateOf(workspaceId)
      const tab = makeTab(kind, pane, init)
      write(workspaceId, withActive({ ...cur, tabs: [...cur.tabs, tab] }, pane, tab.id))
    },

    openPath(workspaceId, kind, path, title) {
      const cur = get().stateOf(workspaceId)
      /*
        文件树里点的文件**一律开在主区**(参考截图:点 `bun.lock`,Tab 出现在
        最上面那条,不是在右边那条)。右侧那格是导航,主区才是内容。
      */
      const existing = cur.tabs.find(
        (t) => t.kind === kind && 'path' in t.ref && t.ref.path === path && paneOf(t) === 'main'
      )
      if (existing !== undefined) {
        if (activeIn(cur, 'main') !== existing.id) write(workspaceId, withActive(cur, 'main', existing.id))
        return
      }
      const tab = makeTab(kind, 'main', { path, title })
      write(workspaceId, withActive({ ...cur, tabs: [...cur.tabs, tab] }, 'main', tab.id))
    },

    newChat(workspaceId) {
      const cur = get().stateOf(workspaceId)
      const chats = tabsInPane(cur.tabs, 'main').filter(
        (t): t is Extract<InnerTab, { kind: 'chat' }> => t.kind === 'chat'
      )
      /*
        先看当前这一个 —— 已经站在一张白纸前时,这一下应该什么也不发生,
        而不是切到另一张同样空白的纸上(那看着像点错了)。
        否则取**最靠后**的那一个:`open` 是往后追加的,所以上一次「新建对话」
        给出来的就是最后那一个。
      */
      const active = activeIn(cur, 'main')
      const reusable =
        chats.find((t) => t.id === active && isSessionUntouched(t.ref.sessionId)) ??
        [...chats].reverse().find((t) => isSessionUntouched(t.ref.sessionId))

      if (reusable === undefined) {
        get().open(workspaceId, 'chat')
        return
      }
      get().activate(workspaceId, reusable.id)
    },

    activate(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const tab = cur.tabs.find((t) => t.id === tabId)
      if (tab === undefined) return
      const pane = paneOf(tab)
      if (activeIn(cur, pane) === tabId) return
      write(workspaceId, withActive(cur, pane, tabId))
    },

    close(workspaceId, tabId) {
      const cur = get().stateOf(workspaceId)
      const target = cur.tabs.find((t) => t.id === tabId)
      if (target === undefined) return
      const pane = paneOf(target)

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
      if (pane === 'main' && rest.length === 0) {
        const tab = makeTab('chat', 'main')
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

    forget(workspaceId) {
      /*
        会话 store 一起放掉。**这里是唯一放得掉的地方** —— 内层 Tab 表是全应用
        唯一知道「这个工作区有哪些 sessionId」的东西,别处想放也没有名单。

        正在跑的那几个放不掉(`releaseSession` 自己会拒绝),这是故意的:
        run 活在主进程,关掉工作区不该把它从渲染层的账上抹掉。
      */
      for (const t of get().stateOf(workspaceId).tabs) {
        if (t.kind === 'chat') releaseSession(t.ref.sessionId)
      }
      const next = { ...get().byWorkspace }
      delete next[workspaceId]
      set({ byWorkspace: next })
    }
  }
})
