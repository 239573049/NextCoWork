/**
 * 双层 Tab —— 方案 §8「三个必须分清的概念」第二、三条。
 *
 * 判断模型对不对的**试金石**:关掉最后一个正在观看某个运行中会话的 Tab,
 * run 依然活着,且外层工作区 Tab 上显示运行中角标。表达不出这个,说明归属关系搞错了。
 *
 * 角标的数据源是 **RunRegistry 按 workspaceId 聚合**,不是任何 UI 状态。
 */
import type { TabMenuItem } from '../plugin/contribution'

/** ★ 外层 Tab 不只装工作区 —— 「定时任务」是作为独立外层 Tab 打开的 */
export type OuterTab =
  | { id: string; kind: 'workspace'; ref: { workspaceId: string }; /** Keep this tab at the start of the tab strip. */ pinned?: boolean }
  | { id: string; kind: 'feature'; ref: { feature: FeatureKind }; /** Keep this tab at the start of the tab strip. */ pinned?: boolean }

export type FeatureKind = 'scheduled' | 'extensions' | 'browser' | 'git' | 'review' | 'settings'

/**
 * 功能页的标题 —— **key 不是文案**。
 *
 * ★ 这里原本是一张硬编码中文的 `Record<FeatureKind, string>`。它违反项目
 * AGENTS.md 的第一条,而且是那种切到 `en-US` 之后**还是中文**、却不会有任何
 * 报错的违规:渲染处直接把值铺出去,根本没有 `t()` 可言。改成 key 之后,
 * 漏翻的那一条会在界面上显示成 key 本身 —— 看得见,才改得掉。
 */
export const FEATURE_LABEL_KEY: Record<FeatureKind, string> = {
  scheduled: 'feature.scheduled',
  extensions: 'feature.extensions',
  browser: 'feature.browser',
  git: 'feature.git',
  review: 'feature.review',
  settings: 'feature.settings'
}

/**
 * ★ 内层 Tab 属于**工作区**,不属于窗口(切换外层 Tab 时该工作区的内层 Tab 集自动恢复)。
 * ★ 会话不是 Tab,Tab 只**引用**一个 sessionId,而且**可以一个都不引用**(见 `chatKey`)。
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
  /**
   * ★ `sessionId` 可以是 `null` —— 那是一个**还没有会话的对话 Tab**(草稿)。
   *
   * 「新建对话」不该在库里留下任何东西:它给的是一张白纸,而白纸攒多了就是
   * 侧边栏里一排一模一样的「新对话」,用户以为自己什么也没做成。所以 id 在
   * **需要一个归属**的那一刻才铸出来(发出第一条消息,或者贴上第一个附件),
   * 见 `stores/tabs.ts` 的 `bindChatSession`;库里那一行更晚,由主进程
   * `runAgent` 的 `ensureSession` 建。
   */
  /**
   * `readOnly` = 这是**别人的**会话,只能看。目前唯一的来源是子代理卡片:
   * 点一下就在右侧工作区开一个只读会话,复用主智能体那套渲染。
   *
   * ★ 放在 `ref` 而不是 `InnerTabBase`,是因为它是「这个 Tab 指着什么」的一部分 ——
   * 只读的是那个会话,不是这个 Tab 的显示方式。也因此它会跟着布局一起落盘:
   * 重启之后那个面板仍然是只读的,而不是突然多出一个输入框、让人往子代理的
   * 会话里发消息(那条路在主进程侧根本没有接)。
   */
  /**
   * `subagentOf` = 这个只读会话是**哪张卡片**点开的:父会话 id + 那次 `Task` 调用的 callId。
   *
   * 身份栏要显示的那些格子(子代理类型、模型、执行方式、停在哪个阶段、工具数/错误数、
   * 距上次事件多久)**一格都不在子会话自己的转录里** —— 它们住在**父**会话的
   * `transcript.subagents[callId]`。子转录只是一段普通对话,它不知道自己是谁派出来的。
   *
   * ★ 跟着 `readOnly` 一起落盘,而不是在渲染层另起一张 `childSessionId → 父坐标` 的索引表:
   * 那张表在 ⌘R 之后是空的(它只在活的 `subagent_start` 流过时才被写),而 Tab 是从盘里
   * 读回来的 —— 于是重载后面板还在,身份栏却整条消失。
   */
  | (InnerTabBase & {
      kind: 'chat'
      ref: {
        sessionId: string | null
        readOnly?: true
        subagentOf?: { sessionId: string; callId: string }
      }
    })
  | (InnerTabBase & { kind: 'terminal'; ref: { terminalId: string } })
  | (InnerTabBase & { kind: 'doc'; ref: { path: string } })
  | (InnerTabBase & { kind: 'draw'; ref: { path: string } })
  | (InnerTabBase & { kind: 'browser'; ref: { url: string; browserId?: string; profileId?: string } })
  | (InnerTabBase & { kind: 'preview'; ref: { path: string } })
  /**
   * 工作区文件树。`ref.path` 是**子树根**(相对工作区,`''` = 工作区根)——
   * 留着这个字段是因为参考实现的行动菜单里有「以此为根」类的操作,
   * 而且它让「同时挂两棵不同子树」不需要改类型。
   */
  | (InnerTabBase & { kind: 'files'; ref: { path: string; selectedPath?: string } })
  /**
   * 「改动审查」—— 某一轮(顶层 run)改了哪些文件 + 每个文件的 diff。
   *
   * ★ 按 `runId` 定位(不是 sessionId):一个会话有多个任务块,每块一个可独立
   *   打开的审查 tab。`sessionId` 一并存下,便于关会话时清理与去重。
   *
   * `selectedPath` 是**打开时先看哪个文件的 diff**(缺省是清单里的第一个),
   * 从回合底部那张卡点某一行过来时带上 —— 可选,老布局读回来时没有它。
   */
  | (InnerTabBase & { kind: 'changes'; ref: { runId: string; sessionId: string; selectedPath?: string } })
  /**
   * 插件接管的自定义编辑器(`contributes.customEditors`)。
   *
   * ★ `pluginId` 和 `viewType` **都要落盘**,而且**都要存**:
   *
   * - 只存 `viewType` 的话,两个插件声明了同一个 viewType 时,重启之后这个
   *   Tab 会打开另一个插件 —— 而它读的是同一个文件;
   * - 只存 `pluginId` 的话,一个插件贡献多个编辑器时认不出该开哪一个。
   *
   * ★ 插件不在了(卸载 / 禁用 / 装载失败)时**不能让这个 Tab 消失**,
   * 也不能让它空着 —— 降级成只读文本预览,见 `views/registry.tsx`。
   * 让它消失意味着用户重启一次就丢了一屏工作区布局,而没有任何提示。
   */
  | (InnerTabBase & { kind: 'custom'; ref: { viewType: string; pluginId: string; path: string } })

export type InnerTabKind = InnerTab['kind']

export function paneOf(tab: InnerTab): TabPane {
  return tab.pane ?? 'main'
}

/**
 * 这个聊天 Tab 在**渲染层各注册表**里的键 —— 转录 store、未发出输入的存档,
 * 都按它索引。
 *
 * 已绑定会话的用 sessionId;草稿用 tabId(它本来就是个 ULID,不会撞)。
 * 存在的理由是那两张表在草稿期也得有得用:白纸上打了半句话、贴了张图,
 * 关掉应用再回来还得在 —— 而这时候还没有会话 id 可以拿。
 *
 * ★ **拿它去调主进程是错的**:草稿键不是会话 id,`sessions:get` 只会告诉你
 * 会话不存在。凡是要往 IPC 送的,都必须先 `bindChatSession` 换一个真 id。
 */
export function chatKey(tab: Extract<InnerTab, { kind: 'chat' }>): string {
  return tab.ref.sessionId ?? tab.id
}

/**
 * `+` 菜单的内置项 —— **三格共用一张表**,靠 `panes` 决定哪一格出哪几项。
 *
 * ## 这里换掉了什么
 *
 * 原本是三张常量(`INNER_TAB_MENU` / `BOTTOM_TAB_MENU` / `RIGHT_TAB_MENU`),
 * 每一项长这样:`{ kind, label: '新建对话', separatorBefore }`。三处硬伤:
 *
 * 1. **`label` 是硬编码中文**,渲染处直接铺出去 —— 切到 `en-US` 菜单还是中文。
 * 2. **`kind` 同时是身份、图标键、动作**。插件项没有 `InnerTabKind`,三处全卡死:
 *    `key={item.kind}`、`INNER_TAB_ICON[item.kind]`、`onOpen(item.kind)`。
 * 3. **分隔线是数据里的 `separatorBefore`**,加一项就得手工挪那个标记。
 *
 * 换成 `TabMenuItem` 之后:文案是 key、身份是 `id`、动作是 `action` 判别联合、
 * 分隔线由 **group 边界自动生成**。截图里那条分隔(新建文档与新建终端之间)
 * 正好落在 `create|tools` 边界上,**视觉零变化**。
 *
 * 插件项经 `mergeMenuItems` 并进来,规则(排在内置之后、单插件最多 3 项)
 * 在 `shared/plugin/contribution.ts`。
 */
export const BUILTIN_TAB_MENU: readonly TabMenuItem[] = [
  // view —— 「看已有的东西」。主区不出:主区默认就是内容区。
  { id: 'builtin.files', titleKey: 'tabMenu.files', icon: 'files', group: 'view', order: 10, panes: ['right'], action: { kind: 'openTab', tabKind: 'files' } },
  { id: 'builtin.preview', titleKey: 'tabMenu.preview', icon: 'image', group: 'view', order: 20, panes: ['bottom', 'right'], action: { kind: 'openTab', tabKind: 'preview' } },

  // create —— 「造一个新的」。三格都出,顺序即截图里的顺序。
  { id: 'builtin.chat', titleKey: 'tabMenu.chat', icon: 'message-square', accelerator: 'CmdOrCtrl+N', group: 'create', order: 10, action: { kind: 'openTab', tabKind: 'chat' } },
  /*
    ★ 这里原来有一项 `builtin.draw`(「新建绘图」)。它开出来的 `draw` Tab
    本版只有一个占位空壳(`views/registry.tsx` 的 "draw" 分支渲染 Placeholder),
    而真正的绘图现在由插件贡献(`contributes.menus` → `excalidraw.new`)——
    留着它等于给用户两个「新建绘图」,其中一个点了什么都没有。

    `draw` 这个 Tab kind 本身**保留**:落盘的旧布局里可能还有它,
    从联合类型里删掉会让那些 Tab 直接消失(而用户没做错任何事)。
  */
  { id: 'builtin.doc', titleKey: 'tabMenu.doc', icon: 'file-text', accelerator: 'Alt+CmdOrCtrl+N', group: 'create', order: 30, action: { kind: 'openTab', tabKind: 'doc' } },

  // tools —— 「开一个工具」。分隔线落在这条边界上。
  { id: 'builtin.terminal', titleKey: 'tabMenu.terminal', icon: 'terminal', group: 'tools', order: 10, action: { kind: 'openTab', tabKind: 'terminal' } },
  { id: 'builtin.browser', titleKey: 'tabMenu.browser', icon: 'globe', accelerator: 'CmdOrCtrl+T', group: 'tools', order: 20, action: { kind: 'openTab', tabKind: 'browser' } }
]

/** 这一格该出哪几项。省略 `panes` = 三格都出。 */
export function tabMenuForPane(
  items: readonly TabMenuItem[],
  pane: TabPane
): TabMenuItem[] {
  return items.filter((item) => item.panes === undefined || item.panes.includes(pane))
}

/** 每个工作区一份内层 Tab 状态,持久化到 kv 表(防抖 500ms) */
export interface InnerTabState {
  /** ★ 三条 Tab 条**共用这一张表**,靠 `pane` 区分,见 InnerTabBase.pane */
  tabs: InnerTab[]
  activeTabId: string | null
  /** 底部那条的激活项。旧的持久化记录没有这个字段 → undefined → 底部为空 */
  bottomActiveTabId?: string | null
  /** 右边那条的激活项。同上。 */
  rightActiveTabId?: string | null
  /** Version 2 recursive Dock layout. Kept optional for legacy snapshots. */
  dock?: import('./dock').WorkspaceDockState
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
