/**
 * 双层 Tab —— 方案 §8「三个必须分清的概念」第二、三条。
 *
 * 判断模型对不对的**试金石**:关掉最后一个正在观看某个运行中会话的 Tab,
 * run 依然活着,且外层工作区 Tab 上显示运行中角标。表达不出这个,说明归属关系搞错了。
 *
 * 角标的数据源是 **RunRegistry 按 workspaceId 聚合**,不是任何 UI 状态。
 */

/** ★ 外层 Tab 不只装工作区 —— 「定时任务」是作为独立外层 Tab 打开的 */
export type OuterTab =
  | { id: string; kind: 'workspace'; ref: { workspaceId: string } }
  | { id: string; kind: 'feature'; ref: { feature: FeatureKind } }

export type FeatureKind = 'scheduled' | 'skills' | 'browser' | 'review' | 'settings'

export const FEATURE_LABEL: Record<FeatureKind, string> = {
  scheduled: '定时任务',
  skills: 'Skill 管理',
  browser: '浏览器',
  review: '每日回顾',
  settings: '设置'
}

/**
 * ★ 内层 Tab 属于**工作区**,不属于窗口(切换外层 Tab 时该工作区的内层 Tab 集自动恢复)。
 * ★ 会话不是 Tab,Tab 只**引用**一个 sessionId。
 *
 * 这样才能:关掉聊天 Tab 而不杀死正在跑的 run、在新 Tab 里重开历史会话、
 * 两个 Tab 看同一会话。
 */
interface InnerTabBase {
  id: string
  title: string
  /**
   * ★ **底部面板和右侧面板都是内层 Tab 条,不是「终端面板」「文件面板」。**
   *
   * 三处的 `+` 菜单是同一套东西的三个子集:主区五项;底部多一项「文件预览」排最前;
   * 右侧那颗 `+` 的 tooltip 直接写着「添加右侧工作台标签」,首项是「工作区文件」。
   * 也就是说任何一种 kind 都能开在任何一格 —— 主区正在对话、下面开着终端、
   * 右边挂着文件树,这三件事同时成立。
   *
   * 所以「哪一格」是 Tab 自己的属性,而不是三套互不相干的状态:三条 Tab 条共用
   * 一张表、一份持久化、一套增删改,将来「把这个 Tab 拖到下面去」也只是改这一个字段。
   *
   * 可选是为了**兼容已经落盘的布局** —— 旧记录没有这个字段,读回来一律当 `main`
   * (见 `paneOf`)。加成必填会让升级后第一次启动的 Tab 条整个空掉。
   */
  pane?: TabPane
}

export type TabPane = 'main' | 'bottom' | 'right'

export type InnerTab =
  | (InnerTabBase & { kind: 'chat'; ref: { sessionId: string } })
  | (InnerTabBase & { kind: 'terminal'; ref: { terminalId: string } })
  | (InnerTabBase & { kind: 'doc'; ref: { path: string } })
  | (InnerTabBase & { kind: 'draw'; ref: { path: string } })
  | (InnerTabBase & { kind: 'browser'; ref: { url: string } })
  | (InnerTabBase & { kind: 'preview'; ref: { path: string } })
  /**
   * 工作区文件树。`ref.path` 是**子树根**(相对工作区,`''` = 工作区根)——
   * 留着这个字段是因为参考实现的行动菜单里有「以此为根」类的操作,
   * 而且它让「同时挂两棵不同子树」不需要改类型。
   */
  | (InnerTabBase & { kind: 'files'; ref: { path: string } })

export type InnerTabKind = InnerTab['kind']

export function paneOf(tab: InnerTab): TabPane {
  return tab.pane ?? 'main'
}

export interface InnerTabMenuItem {
  kind: InnerTabKind
  label: string
  accelerator?: string
  /** 菜单里这一项之前画一道分隔 —— 写成数据而不是渲染时的 `i === 3` */
  separatorBefore?: boolean
}

/** 主区 `+` 菜单(截图 7674f2f5):五项,终端之前一道分隔 */
export const INNER_TAB_MENU: readonly InnerTabMenuItem[] = [
  { kind: 'chat', label: '新建对话', accelerator: 'CmdOrCtrl+N' },
  { kind: 'draw', label: '新建绘图' },
  { kind: 'doc', label: '新建文档', accelerator: 'Alt+CmdOrCtrl+N' },
  { kind: 'terminal', label: '新建终端', separatorBefore: true },
  { kind: 'browser', label: '网页浏览', accelerator: 'CmdOrCtrl+T' }
]

/**
 * 底部面板 `+` 菜单。比主区那条**多一项「文件预览」并排在最前**,
 * 其余五项和分隔位置完全一致 —— 这正是「底部是同一套 Tab 系统」的直接证据。
 */
export const BOTTOM_TAB_MENU: readonly InnerTabMenuItem[] = [
  { kind: 'preview', label: '文件预览' },
  ...INNER_TAB_MENU
]

/**
 * 右侧面板 `+` 菜单。那颗 `+` 的 tooltip 是「**添加右侧工作台标签**」——
 * 「工作台标签」这四个字就是这一层的命名,右边不是一个专用的文件栏,
 * 是一格能放任何东西的工作台。首项自然是它默认那一个:工作区文件。
 */
export const RIGHT_TAB_MENU: readonly InnerTabMenuItem[] = [
  { kind: 'files', label: '工作区文件' },
  { kind: 'preview', label: '文件预览' },
  ...INNER_TAB_MENU
]

/** 每个工作区一份内层 Tab 状态,持久化到 kv 表(防抖 500ms) */
export interface InnerTabState {
  /** ★ 三条 Tab 条**共用这一张表**,靠 `pane` 区分,见 InnerTabBase.pane */
  tabs: InnerTab[]
  activeTabId: string | null
  /** 底部那条的激活项。旧的持久化记录没有这个字段 → undefined → 底部为空 */
  bottomActiveTabId?: string | null
  /** 右边那条的激活项。同上。 */
  rightActiveTabId?: string | null
}

/** 窗口级状态:外层 Tab 条 + 当前激活的外层 Tab */
export interface WindowTabState {
  outer: OuterTab[]
  activeOuterId: string | null
  /**
   * 两个面板拖出来的尺寸。
   *
   * **开没开不落盘,拖多宽落盘** —— 这两件事看着一类,其实不是:
   * 「面板开着」是这个窗口此刻的呈现状态(启动时自己弹开是 bug),
   * 而「我把它拖到 600 宽」是用户调过的偏好,和外层 Tab 的顺序同级 ——
   * 每次启动都弹回默认宽度,是编辑器类应用里最招人烦的一种失忆。
   *
   * 可选是为了**兼容已经落盘的记录**:旧记录没有这两个字段,读回来用默认值。
   */
  rightPanelWidth?: number
  bottomPanelHeight?: number
}

export type WindowKind = 'main' | 'quick'

// ─── 拖动排序 ───

/**
 * ★ 顶部 Tab 可拖动排序。两条约束:
 *
 * 1. **顺序是用户资产,必须持久化**。数组顺序就是显示顺序,拖完写 kv 表(防抖 500ms,
 *    同其余窗口状态)。别在渲染层用一个临时的 sortIndex —— 重启就没了。
 * 2. **拖动区与系统标题栏冲突**。macOS 用 `titleBarStyle: 'hiddenInset'`,外层 Tab 条
 *    正好落在自绘标题栏里,而那块是 `-webkit-app-region: drag`。**这个区域里 OS 会吞掉
 *    所有 pointer 事件**,HTML5 dragstart / pointermove 一个都收不到 —— 表现是「Tab 拖不动,
 *    整个窗口跟着鼠标跑」。每个 Tab 元素必须显式 `-webkit-app-region: no-drag`
 *    (theme.css 里的 `.app-no-drag`),只把 Tab 之间的空白留给窗口拖动。
 *
 * 用 pointer 事件手写而不引 dnd 库:只有一维重排,而拖拽库在 `no-drag` 区域的
 * 边界情况上反而更难调。
 */
export interface TabReorder {
  from: number
  to: number
}

/** 纯函数,主进程与渲染层共用,保证两边算出同一个顺序。 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list]
  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...list]
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}

// ─── 三条 Tab 条共用一张表的取数 / 改序 ───

export function tabsInPane(tabs: readonly InnerTab[], pane: TabPane): InnerTab[] {
  return tabs.filter((t) => paneOf(t) === pane)
}

/**
 * 只重排某一格内部的顺序 —— `from` / `to` 是**该格内的下标**,不是全局下标。
 *
 * 做法是「抽出来排好、再按原来的坑位填回去」:那一格占用的全局位置集合不变,
 * 另外两格一个元素都不动。直接拿全局数组去 `reorder` 会算错 ——
 * 底部那条的第 0 个,在共用表里可能是第 5 个。
 */
export function reorderInPane(
  tabs: readonly InnerTab[],
  pane: TabPane,
  from: number,
  to: number
): InnerTab[] {
  const slots: number[] = []
  const subset: InnerTab[] = []
  tabs.forEach((t, i) => {
    if (paneOf(t) === pane) {
      slots.push(i)
      subset.push(t)
    }
  })
  const moved = reorder(subset, from, to)
  const next = [...tabs]
  slots.forEach((slot, i) => {
    const t = moved[i]
    if (t !== undefined) next[slot] = t
  })
  return next
}
