/**
 * 窗口级状态:外层 Tab + 当前工作区 + 侧边栏折叠。
 *
 * ★ **`activeWorkspaceId` 是一个值、两个消费者**(方案 §8):内层 Tab 条和侧边栏
 * 下半的会话区都从它派生。各自存一份必然会不同步,而「切了顶部 Tab 但左边没跟着变」
 * 是那种用户一眼看得见、你却要查半天的 bug。
 *
 * 它**不是**从 `activeOuterId` 直接算出来的,虽然看起来可以。因为「定时任务」这类
 * 功能 Tab 激活时,侧边栏仍然显示着原来那个工作区的会话列表(截图 4aa68110) ——
 * 派生式写法在那一刻会算出 null,整个侧边栏下半会闪空。所以它是显式状态,
 * 只在**激活一个工作区 Tab 时**才更新。
 */
import { create } from 'zustand'
import type { Bootstrap } from '../../../shared/domain/bootstrap'
import type { FeatureKind, OuterTab, WindowKind } from '../../../shared/domain/tab'
import { reorder } from '../../../shared/domain/tab'
import type { Workspace } from '../../../shared/domain/workspace'
import { ulid } from '../../../shared/util/id'
import { DEFAULT_SETTINGS_PAGE, type SettingsPageId } from '../settings/nav'
import { persistOuterTabs } from '../services/app'
import { useTabsStore } from './tabs'

interface WindowState {
  windowKind: WindowKind
  outer: OuterTab[]
  activeOuterId: string | null
  /** 见文件头:显式状态,不从 activeOuterId 派生 */
  activeWorkspaceId: string | null
  sidebarCollapsed: boolean
  /**
   * 外层 Tab 条右端那两个面板开关(量自 docs/image-new:`PanelBottom` 在
   * x949..962、`PanelRight` 在 x991..1004)。**它们是窗口级的,不是工作区级的** ——
   * 参考实现里切工作区 Tab 时右侧「工作区文件」面板保持打开,只是换了内容。
   */
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  /**
   * 拖出来的面板尺寸。**和上面两个开关不同,这两个是落盘的** ——
   * 理由写在 `WindowTabState` 那两个字段上。
   *
   * 参考实现里右侧面板确实是可拖的:同一版界面的两张截图,一张 ≈297px
   * (工具条收成「搜索 + …」),一张 ≈608px(七颗按钮全展开)。
   * 也就是说宽度不只是个人喜好,它**改变工具条的形态**(见 FilesView 的 ResizeObserver)。
   */
  rightPanelWidth: number
  bottomPanelHeight: number
  /**
   * 设置模态浮层。**一个字段兼表「开没开」和「开在哪一页」** ——
   * 拆成 `open: boolean` + `page` 的话,这两个值必然会有不同步的那一刻。
   *
   * ★ **不落盘。** 和 `sidebarCollapsed` / 两个面板开关同类:它是这个窗口
   * 此刻的呈现状态,不是用户的偏好。启动到一半自己弹出设置面板是 bug 不是恢复。
   * 现在靠「`persist()` 只在 Tab 增删改移里调用」自动成立,而这是**碰巧对**——
   * 哪天有人给整个 store 套上 persist 中间件就会退化。同目录测试守着这条。
   *
   * 放在 store 而不是 AppShell 的 useState,因为调用点不止一个,且有的够不着
   * 组件树:`services/ipc.ts` 那句「UI 据 code 决定**跳设置页**」说的那个跳转
   * 会发生在 session store 的错误分支里,那里只有 `getState()`。
   */
  settingsPage: SettingsPageId | null

  hydrate: (b: Bootstrap) => void
  activate: (outerId: string) => void
  openWorkspace: (workspaceId: string) => void
  openFeature: (feature: FeatureKind) => void
  close: (outerId: string) => void
  move: (from: number, to: number) => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  toggleBottomPanel: () => void
  /** 拖动分隔条时每帧都在调 —— 落盘那侧防抖 500ms,这里不用自己攒 */
  setRightPanelWidth: (px: number) => void
  setBottomPanelHeight: (px: number) => void
  openSettings: (page?: SettingsPageId) => void
  closeSettings: () => void
}

const firstWorkspaceId = (tabs: readonly OuterTab[], activeId: string | null): string | null => {
  const active = tabs.find((t) => t.id === activeId)
  if (active?.kind === 'workspace') return active.ref.workspaceId
  for (const t of tabs) if (t.kind === 'workspace') return t.ref.workspaceId
  return null
}

/**
 * 全新安装的第一屏。
 *
 * 主进程已经播种了「默认工作区」这条**记录**(`main/runtime.ts` 的 `seedDefaultWorkspace`),
 * 但记录不是视图 —— 没人替它开一个外层 Tab 的话,首屏停在「打开一个工作区开始」,
 * 用户必须先走一遍「打开文件夹」才看得见这个应用长什么样。而那恰恰是那次播种
 * 想消灭的空态。挑最近打开过的一个开出来。
 *
 * 只在**持久化的 Tab 表为空**时发生 —— 包括用户上次自己关光了所有 Tab 的情况。
 * 编辑器类应用都是这么做的(重开上次那个目录),而空壳首屏除了 Tab 条上那个 `+`
 * 之外什么都没有,不值得让用户每次启动都走一遍。
 *
 * 注意这不等于「Tab 关不掉」:补 Tab 只发生在 `hydrate`,`close` 里没有这一步 ——
 * 当前这次会话里关光就是空的,不会有一个 Tab 自己长回来。
 */
const initialTabs = (workspaces: readonly Workspace[]): OuterTab[] => {
  const latest = [...workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
  if (latest === undefined) return []
  return [{ id: ulid(), kind: 'workspace', ref: { workspaceId: latest.id } }]
}

/**
 * 面板尺寸的默认值与夹取范围。
 *
 * 下界不是随手定的:右侧那格窄于 ≈240 时,树里第三层的文件名就只剩几个字,
 * 那时候该做的是把面板关掉而不是继续缩。上界留出主区仍能读一段对话的宽度。
 * **读回持久化值时也走这个夹取** —— 上一版的默认宽度、或者换了台小屏机器,
 * 都可能让存下来的数字在当前屏幕上是荒谬的。
 */
const RIGHT_PANEL = { def: 300, min: 240, max: 720 } as const
const BOTTOM_PANEL = { def: 220, min: 140, max: 640 } as const

const clamp = (px: number, r: { min: number; max: number }): number =>
  Math.round(Math.min(r.max, Math.max(r.min, px)))

export const useWindowStore = create<WindowState>((set, get) => {
  /** 每次结构性变更都落盘。主进程侧防抖 500ms,这里不用自己攒。 */
  const persist = (outer: OuterTab[], activeOuterId: string | null): void => {
    const { windowKind, rightPanelWidth, bottomPanelHeight } = get()
    persistOuterTabs(windowKind, { outer, activeOuterId, rightPanelWidth, bottomPanelHeight })
  }

  return {
    windowKind: 'main',
    outer: [],
    activeOuterId: null,
    activeWorkspaceId: null,
    sidebarCollapsed: false,
    rightPanelOpen: false,
    bottomPanelOpen: false,
    rightPanelWidth: RIGHT_PANEL.def,
    bottomPanelHeight: BOTTOM_PANEL.def,
    settingsPage: null,

    hydrate(b) {
      /*
        ★ 过滤掉持久化数据里的「设置」功能 Tab。`FeatureKind` 里有 `'settings'`
        (`FEATURE_LABEL` / `FEATURE_ICON` 都给了它值),今天没人开它,但**类型允许**,
        而旧版本留下的 kv 记录里完全可能躺着一条。放进来就出现了第二个设置入口,
        正是 `AppShell` 文件头禁止的那件事:「关掉设置」和「关掉一个工作区」
        会变成同一个动作。见下面 `openFeature` 里的那道拦截。
      */
      const persisted = b.tabState.outer.filter(
        (t) => !(t.kind === 'feature' && t.ref.feature === 'settings')
      )
      const outer = persisted.length > 0 ? persisted : initialTabs(b.workspaces)
      const activeOuterId = b.tabState.activeOuterId ?? outer[0]?.id ?? null
      set({
        windowKind: b.windowKind,
        outer,
        activeOuterId,
        activeWorkspaceId: firstWorkspaceId(outer, activeOuterId),
        rightPanelWidth: clamp(b.tabState.rightPanelWidth ?? RIGHT_PANEL.def, RIGHT_PANEL),
        bottomPanelHeight: clamp(b.tabState.bottomPanelHeight ?? BOTTOM_PANEL.def, BOTTOM_PANEL)
      })
      // 自动开出来的这一个也要落盘,否则它每次启动都换一个新 id ——
      // 内层 Tab 按 workspaceId 索引不受影响,但拖出来的顺序会莫名回退。
      if (persisted.length === 0 && outer.length > 0) persist(outer, activeOuterId)
    },

    activate(outerId) {
      const tab = get().outer.find((t) => t.id === outerId)
      if (tab === undefined) return
      set({
        activeOuterId: outerId,
        // 功能 Tab 不改工作区上下文 —— 侧边栏保持原样
        ...(tab.kind === 'workspace' ? { activeWorkspaceId: tab.ref.workspaceId } : {})
      })
      persist(get().outer, outerId)
    },

    openWorkspace(workspaceId) {
      const existing = get().outer.find(
        (t) => t.kind === 'workspace' && t.ref.workspaceId === workspaceId
      )
      if (existing !== undefined) {
        get().activate(existing.id)
        return
      }
      const tab: OuterTab = { id: ulid(), kind: 'workspace', ref: { workspaceId } }
      const outer = [...get().outer, tab]
      set({ outer, activeOuterId: tab.id, activeWorkspaceId: workspaceId })
      persist(outer, tab.id)
    },

    openFeature(feature) {
      // 设置是模态浮层,不是 Tab —— 改道,不建 Tab、不落盘(见 hydrate 里的过滤)
      if (feature === 'settings') {
        get().openSettings()
        return
      }
      const existing = get().outer.find((t) => t.kind === 'feature' && t.ref.feature === feature)
      if (existing !== undefined) {
        get().activate(existing.id)
        return
      }
      const tab: OuterTab = { id: ulid(), kind: 'feature', ref: { feature } }
      const outer = [...get().outer, tab]
      set({ outer, activeOuterId: tab.id })
      persist(outer, tab.id)
    },

    close(outerId) {
      const { outer, activeOuterId } = get()
      const idx = outer.findIndex((t) => t.id === outerId)
      if (idx < 0) return
      const closed = outer[idx]
      const next = outer.filter((t) => t.id !== outerId)
      // 关掉的是当前 Tab 时,焦点给右邻;没有右邻给左邻 —— 浏览器的习惯
      const nextActive =
        activeOuterId === outerId ? (next[idx]?.id ?? next[idx - 1]?.id ?? null) : activeOuterId
      set({
        outer: next,
        activeOuterId: nextActive,
        activeWorkspaceId: firstWorkspaceId(next, nextActive)
      })
      persist(next, nextActive)

      /*
        ★ **关掉工作区 Tab = 这个工作区退出内存。** 内层 Tab 表和它那些会话的
        转录都该放掉 —— 方案 §8 写的「per-session store 懒创建、工作区关闭时销毁」
        就是这一行。曾经这两个释放函数都写好了却没有任何人调用,于是开过的每个
        工作区、每段转录都留在内存里直到退出应用。

        `openWorkspace` 保证一个工作区最多只有一个外层 Tab,所以不必再查
        还有没有别的 Tab 引用它。**正在跑的 run 不受影响** —— 它活在主进程,
        `releaseSession` 会拒绝放掉那些会话。
      */
      if (closed?.kind === 'workspace') useTabsStore.getState().forget(closed.ref.workspaceId)
    },

    move(from, to) {
      const outer = reorder(get().outer, from, to)
      set({ outer })
      persist(outer, get().activeOuterId)
    },

    toggleSidebar() {
      set({ sidebarCollapsed: !get().sidebarCollapsed })
    },

    toggleRightPanel() {
      set({ rightPanelOpen: !get().rightPanelOpen })
    },

    toggleBottomPanel() {
      set({ bottomPanelOpen: !get().bottomPanelOpen })
    },

    setRightPanelWidth(px) {
      const rightPanelWidth = clamp(px, RIGHT_PANEL)
      if (rightPanelWidth === get().rightPanelWidth) return
      set({ rightPanelWidth })
      persist(get().outer, get().activeOuterId)
    },

    setBottomPanelHeight(px) {
      const bottomPanelHeight = clamp(px, BOTTOM_PANEL)
      if (bottomPanelHeight === get().bottomPanelHeight) return
      set({ bottomPanelHeight })
      persist(get().outer, get().activeOuterId)
    },

    openSettings(page) {
      // 已经开着时不给页码就停在原地 —— 再按一次 ⌘, 不该把用户翻回首页
      set({ settingsPage: page ?? get().settingsPage ?? DEFAULT_SETTINGS_PAGE })
    },

    closeSettings() {
      set({ settingsPage: null })
    }
  }
})
