/**
 * 应用外壳 —— 悬浮面板布局。
 *
 * 窗口四周留 8px,侧边栏与右侧内容区是**两块独立的圆角面板**,中间也是 8px 缝
 * (截图里能看见 `--color-app` 从缝里透出来)。四边和中缝**同一个 8px**,是一套
 * 栅格不是四个凑出来的数 —— 量自 4aa68110:面板体 8..304 / 313..1255,
 * 上下同样 8..1132,窗口边框自己占 1px。这不是装饰:面板边缘就是分区边界,
 * 所以全局基本不用 box-shadow,靠底色差分层。
 *
 * ★ **`app-drag` 与 Tab 拖动排序正面冲突**(方案 §8)。macOS 用
 * `titleBarStyle: 'hiddenInset'`,顶部这条 34px 落在自绘标题栏里,而那块是
 * `-webkit-app-region: drag` —— **OS 会吞掉这个区域里所有 pointer 事件**,
 * 表现是「Tab 拖不动,整个窗口跟着鼠标跑」。所以 drag 只给 Tab **之间的空白**,
 * 每个 Tab 元素自己显式 `app-no-drag`(见 OuterTabBar)。
 *
 * ★ **设置是模态浮层,不是一个 Tab**(截图 06cd7b3c 是盖在界面上的面板)。
 * 做成 feature Tab 的话,「关掉设置」和「关掉一个工作区」就成了同一个动作。
 */
import { PanelLeft } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Bootstrap } from '../../../shared/domain/bootstrap'
import type { AppSettings } from '../../../shared/domain/settings'
import { INNER_TAB_MENU, tabsInPane } from '../../../shared/domain/tab'
import type { Workspace } from '../../../shared/domain/workspace'
import type { SessionListItem } from '../../../shared/domain/session'
import { IconButton } from '../components/ui/IconButton'
import { cn } from '../lib/cn'
import { usePresence } from '../lib/usePresence'
import { pickWorkspace } from '../services/app'
import { listSessions } from '../services/sessions'
import { on } from '../services/ipc'
import { SettingsOverlay } from '../settings/SettingsOverlay'
import { useTabsStore } from '../stores/tabs'
import { useWindowStore } from '../stores/window'
import { FeatureView, InnerView } from '../views/registry'
import { AllTabsMenu, InnerTabBar } from './InnerTabBar'
import { OuterTabBar } from './OuterTabBar'
import { BottomPanel, RightPanel, useSeedPane } from './Panels'
import { Sidebar } from './Sidebar'

/**
 * 三格面板开合的时长。**三处必须同一个数** —— 侧边栏收起的同时,主面板的左边界
 * 在往左长、Tab 条的左内边距在往右推、那颗展开按钮在等着淡入,四条曲线只要有一条
 * 不同步,看着就是「分好几批到位」。改这里,别在某个组件里单独写一个 duration。
 *
 * 280 而不是 200:侧边栏是 297px 宽的一大块,200ms 下人眼几乎只看到首尾两帧,
 * 「快」和「闪」是一回事。位移越大需要的时间越长(同样一条曲线,一个图标转 90°
 * 150ms 就够),这一档是当前布局下能明显看出「它在走」的下限。
 * 上限在 350 附近 —— 再长就开始觉得点了没反应。
 */
const PANEL_MS = 280

export function AppShell({
  settings,
  versions,
  workspaces,
  runningSessionIds,
  runningWorkspaceIds
}: {
  settings: AppSettings
  /** 「关于」页那四个版本号。来自 bootstrap,不是 preload 的 `versions()` */
  versions: Bootstrap['versions']
  workspaces: readonly Workspace[]
  /** 来自 RunRegistry 的聚合,不是任何 UI 状态(方案 §8) */
  runningSessionIds: ReadonlySet<string>
  runningWorkspaceIds: ReadonlySet<string>
}): ReactNode {
  const {
    outer,
    activeOuterId,
    activeWorkspaceId,
    sidebarCollapsed,
    rightPanelOpen,
    bottomPanelOpen,
    rightPanelWidth,
    bottomPanelHeight,
    settingsPage
  } = useWindowStore()
  const win = useWindowStore()
  const tabs = useTabsStore()
  const ensureTabs = useTabsStore((s) => s.ensure)
  const openTab = useTabsStore((s) => s.open)

  /**
   * 三格面板都是条件挂载的,直接 `{open && <Panel/>}` 收起时节点当场消失,
   * 没有东西可以播退场 —— 所以统一过一遍 usePresence(它的文件头写了为什么)。
   * `shown` 驱动尺寸,`mounted` 决定还渲不渲染,`animating` 只在开合那一下为真,
   * 拖分隔条时是假的(否则每拖一帧都排一次插值,手感像拉皮筋)。
   */
  const sidebar = usePresence(!sidebarCollapsed, PANEL_MS)
  const bottom = usePresence(bottomPanelOpen, PANEL_MS)
  const right = usePresence(rightPanelOpen, PANEL_MS)

  const activeOuter = outer.find((t) => t.id === activeOuterId)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const [sessionItems, setSessionItems] = useState<SessionListItem[]>([])

  useEffect(() => {
    if (activeWorkspaceId === null) {
      setSessionItems([])
      return
    }
    let alive = true
    const load = (): void => {
      void listSessions(activeWorkspaceId).then((items) => { if (alive) setSessionItems(items) }).catch((err: unknown) => console.error('[sessions] 加载列表失败', err))
    }
    load()
    const off = on('sessions:changed', (event) => {
      if (event.workspaceId === undefined || event.workspaceId === activeWorkspaceId) load()
    })
    return () => { alive = false; off() }
  }, [activeWorkspaceId])

  // 工作区一露面就保证它至少有一个对话 Tab —— 空的内层 Tab 条没有任何可做的事。
  // 依赖取的是 action 而不是整个 `tabs`:后者每次写入都换新引用,而 ensure 本身会写。
  useEffect(() => {
    if (activeWorkspaceId !== null) ensureTabs(activeWorkspaceId)
  }, [activeWorkspaceId, ensureTabs])

  /*
    ⌘, —— 走渲染层的全局 keydown,不走主进程应用菜单。
    主进程现在**完全没有** `Menu` / `globalShortcut`,为一个快捷键就得补一整套
    菜单模板 + 一条 main→renderer 命令频道 + 契约白名单条目,不划算。
    代价照实记:窗口没聚焦时不响应,也不出现在 macOS 菜单栏里
    (「偏好」页那一行的描述文字就是这句话,别只写在这儿)。

    依赖取 action 不取整个 store —— `openSettings` 引用是稳定的,
    取 `win` 的话每次任意窗口状态变更都会拆装一遍监听器。
  */
  const openSettings = useWindowStore((s) => s.openSettings)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ',') return
      e.preventDefault()
      openSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openSettings])

  const inner = activeWorkspaceId === null ? null : tabs.stateOf(activeWorkspaceId)
  const activeInner = inner?.tabs.find((t) => t.id === inner.activeTabId)

  /*
    ★ 三条 Tab 条从**同一张表**里切出来(见 shared/domain/tab.ts 的 `InnerTabBase.pane`)。
    过去这里直接把 `inner.tabs` 整个喂给主区那条 —— 现在底部和右边也有 Tab 了,
    不切的话终端会跟对话挤在最上面那条里。
  */
  const mainTabs = inner === null ? [] : tabsInPane(inner.tabs, 'main')
  const bottomTabs = inner === null ? [] : tabsInPane(inner.tabs, 'bottom')
  const rightTabs = inner === null ? [] : tabsInPane(inner.tabs, 'right')

  // 面板掀开时那一格还空着,就按参考实现补上它默认那一个:底部是终端,右边是文件树
  useSeedPane({
    open: bottomPanelOpen,
    workspaceId: activeWorkspaceId,
    pane: 'bottom',
    kind: 'terminal',
    count: bottomTabs.length,
    openTab
  })
  useSeedPane({
    open: rightPanelOpen,
    workspaceId: activeWorkspaceId,
    pane: 'right',
    kind: 'files',
    count: rightTabs.length,
    openTab
  })

  /**
   * 关掉面板里的一个 Tab。**关掉最后一个 = 收起这个面板。**
   *
   * `tabs.close` 那边只对主区做「关光了补一个空对话」,底部/右侧空掉是合法状态 ——
   * 合法但没意义:一条只剩 `+` 的 Tab 条占着 220px 还什么都不显示。收起来才是
   * 用户的本意。两个 store 的写在同一个事件里,React 批成一次 render,
   * 所以 `useSeedPane` 那边看到的是「已经关了」,不会又补一个回来。
   */
  const closePaneTab = (pane: 'bottom' | 'right', id: string): void => {
    if (activeWorkspaceId === null) return
    const last = tabs.tabsOf(activeWorkspaceId, pane).length <= 1
    tabs.close(activeWorkspaceId, id)
    if (!last) return
    if (pane === 'bottom') win.toggleBottomPanel()
    else win.toggleRightPanel()
  }

  return (
    <div className="app-ground flex h-full bg-app p-2">
      {/*
        ★ 中缝的 8px 从根上的 `gap-2` 挪到了侧边栏自己的 `mr-2`。
        gap 是**父元素**的属性,不会因为孩子宽度变成 0 就消失 —— 留着它的话,
        侧边栏收干净以后主面板左边还硬顶着 8+8=16px,比展开态还靠右,
        收起动画的最后一帧会「顿」一下。宽度和外边距一起归零才是连续的。

        包一层而不是直接给 <aside> 加 transition:里面那层是**定宽 297 的**,
        尺寸动的只有外面这个壳,内容被裁掉、而不是被挤扁 —— 否则 297px 的版式
        (nav、卡片、文字)会在这 280ms 里一路重排,文字换行满天飞。
        `rounded-panel` 也得挂在壳上,不然裁切边在动画期间是方角。
      */}
      {sidebar.mounted && (
        <div
          className={cn(
            'flex shrink-0 overflow-hidden rounded-panel',
            'transition-[width,margin-right] duration-280 ease-panel',
            sidebar.shown ? 'mr-2 w-[297px]' : 'mr-0 w-0'
          )}
        >
          <Sidebar
            workspace={workspace ?? null}
            chatTabs={inner?.tabs.filter((t) => t.kind === 'chat') ?? []}
            sessions={sessionItems}
            activeFeature={activeOuter?.kind === 'feature' ? activeOuter.ref.feature : null}
            activeSessionId={activeInner?.kind === 'chat' ? activeInner.ref.sessionId : null}
            runningSessionIds={runningSessionIds}
            // ★ `newChat` 不是 `open`:已经有一个没用过的对话就切过去,不再攒一排
            // 一模一样的「新对话」。Tab 条上那颗 `+` 仍走 `open`,它问的是
            // 「再给我一个」—— 见 stores/tabs.ts 的 newChat
            onNewChat={() => activeWorkspaceId !== null && tabs.newChat(activeWorkspaceId)}
            onSearch={() => {
              /* 步骤 14:cmdk 命令面板 */
            }}
            onOpenFeature={win.openFeature}
            onOpenSettings={() => win.openSettings()}
            onSelectSession={(sessionId) => {
              if (activeWorkspaceId === null || inner === null) return
              const t = inner.tabs.find((x) => x.kind === 'chat' && x.ref.sessionId === sessionId)
              if (t !== undefined) tabs.activate(activeWorkspaceId, t.id)
              else {
                const item = sessionItems.find((x) => x.id === sessionId)
                tabs.openSession(activeWorkspaceId, sessionId, item?.title)
              }
            }}
            onCollapse={win.toggleSidebar}
          />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-panel bg-canvas">
        {/*
          34px 的条 + `items-end` 让 30px 的 Tab 顶边正好离条顶 4px —— 这两个数是
          量出来的,不是调出来的:参考图三张都是「窗口边 8px、条 8..41、激活 Tab 12..41」。
          原本这里是 38px,Tab 就沉到离条顶 8px,整条 Tab 看着比参考低一截。
          改这个数之前先去量图(scripts/crop.mjs + 竖线扫描),别凭手感。
          侧边栏表头是同一个数,两边必须一起改,否则红绿灯和 Tab 底边错位。
        */}
        <div
          className={cn(
            // ★ `chrome` 不是 `surface`:深色下两者同值,浅色下外层 Tab 条(#e8e4dd)
            // **比侧边栏(#f6f4ef)更暗** —— 量自 docs/image-new。用 surface 会让整条
            // Tab 在浅色主题下浮起来,和参考实现的层次正好相反。
            'app-drag flex h-[34px] shrink-0 items-end gap-1.5 bg-chrome px-2',
            // 侧边栏收起时红绿灯落到这条上,得给它让出位置。
            // 78 = 参考里按钮盒左边 x86 减去主面板左边 x8(见下面那段量数)
            // 内边距和侧边栏宽度同时同速地走,红绿灯下面才不会先空出一块再被填上
            'transition-[padding-left] duration-280 ease-panel',
            sidebarCollapsed && 'pl-[78px]'
          )}
        >
          {sidebarCollapsed && (
            /*
              ★ 这颗按钮的四个参数全是量出来的,别按手感调 —— 用户就是拿它跟参考对不齐
              提的意见。量 docs/image-new/image.png(收起态):

                y=25 横扫  红灯 x21..32 / 黄灯 x41..52 / 绿灯 x61..72,
                          按钮盒 x86..123 → **宽 38**,底色 #dbd8d1,笔画 #2d4739
                x=104 竖扫 盒子 y11..38 → **高 28**;x=91 处却只有 y14..35,
                          正是 r=14(=半高)的**药丸**轮廓,不是 8px 小圆角方块
                x=26 竖扫  红灯核心 y21..28 → 灯心 ≈ y24.5,而盒心 (11+38)/2 = 24.5
                          → 两者**居中对齐**,不是底对齐

              原先写的是 26×26 方块 + `items-end` + `mb-1`(盒心 y24、宽窄了 12px、
              没有底色),所以看着既偏左又偏小。`active` 也不是可选项:参考里这颗
              在收起态**就是**挖暗+强调色,它在报告「侧边栏现在是收起的」。
              对照组是同一套图里展开态的那颗(image copy 2.png x=274):无底色、
              笔画 #7e7f7e = `icon` —— 证明这套 token 的差别就是「开着 / 没开」。
            */
            <IconButton
              label="展开侧边栏"
              size={28}
              width={38}
              active
              onClick={win.toggleSidebar}
              // reveal-delayed:延迟到侧边栏收完再淡入,否则和侧边栏里那颗
              // 「收起」按钮会同屏出现 280ms —— 它俩是同一个控件的两个位置。
              className="reveal-delayed self-center rounded-pill"
            >
              <PanelLeft size={16} />
            </IconButton>
          )}
          <OuterTabBar
            tabs={outer}
            activeId={activeOuterId}
            workspaces={workspaces}
            runningWorkspaceIds={runningWorkspaceIds}
            onActivate={win.activate}
            onClose={win.close}
            onMove={win.move}
            onOpenWorkspace={win.openWorkspace}
            onPickWorkspace={() => {
              void pickWorkspace().then((w) => {
                if (w !== null) win.openWorkspace(w.id)
              })
            }}
            onCreateWorkspace={() => {
              // 「新建」和「打开」目前是同一个动作:工作区就是一个目录,
              // 而目录选择必须走主进程 dialog(渲染层永不指定任意路径,方案 §9)
              void pickWorkspace().then((w) => {
                if (w !== null) win.openWorkspace(w.id)
              })
            }}
            rightPanelOpen={rightPanelOpen}
            bottomPanelOpen={bottomPanelOpen}
            onToggleRightPanel={win.toggleRightPanel}
            onToggleBottomPanel={win.toggleBottomPanel}
          />
        </div>

        {/*
          内容区分成「左列 + 右栏」,底部面板只压在**左列**下面 ——
          和编辑器类应用一致:右侧文件栏是通栏的,终端不该把它顶掉。
        */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {activeOuter?.kind === 'feature' ? (
              // feature Tab 没有内层 Tab 条 —— 它不属于任何工作区
              <FeatureView feature={activeOuter.ref.feature} />
            ) : workspace === undefined || inner === null || activeWorkspaceId === null ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-fg-faint">
                打开一个工作区开始
              </div>
            ) : (
              <>
                <InnerTabBar
                  tabs={mainTabs}
                  activeId={inner.activeTabId}
                  runningSessionIds={runningSessionIds}
                  menu={INNER_TAB_MENU}
                  trailing={
                    <AllTabsMenu
                      tabs={mainTabs}
                      activeId={inner.activeTabId}
                      onActivate={(id) => tabs.activate(activeWorkspaceId, id)}
                    />
                  }
                  onActivate={(id) => tabs.activate(activeWorkspaceId, id)}
                  onClose={(id) => tabs.close(activeWorkspaceId, id)}
                  onMove={(from, to) => tabs.move(activeWorkspaceId, from, to, 'main')}
                  onOpen={(kind) => tabs.open(activeWorkspaceId, kind, 'main')}
                />
                {activeInner !== undefined && (
                  <InnerView
                    key={activeInner.id}
                    tab={activeInner}
                    workspace={workspace}
                    fallbackModel={settings.defaultModel}
                  />
                )}
              </>
            )}

            {bottom.mounted && (
              <BottomPanel
                open={bottom.shown}
                animating={bottom.animating}
                workspace={workspace ?? null}
                tabs={bottomTabs}
                activeId={inner?.bottomActiveTabId ?? null}
                runningSessionIds={runningSessionIds}
                fallbackModel={settings.defaultModel}
                size={bottomPanelHeight}
                onResize={win.setBottomPanelHeight}
                onActivate={(id) =>
                  activeWorkspaceId !== null && tabs.activate(activeWorkspaceId, id)
                }
                onCloseTab={(id) => closePaneTab('bottom', id)}
                onMove={(from, to) =>
                  activeWorkspaceId !== null && tabs.move(activeWorkspaceId, from, to, 'bottom')
                }
                onOpen={(kind) =>
                  activeWorkspaceId !== null && tabs.open(activeWorkspaceId, kind, 'bottom')
                }
                onClosePanel={win.toggleBottomPanel}
              />
            )}
          </div>

          {right.mounted && (
            <RightPanel
              open={right.shown}
              animating={right.animating}
              workspace={workspace ?? null}
              tabs={rightTabs}
              activeId={inner?.rightActiveTabId ?? null}
              runningSessionIds={runningSessionIds}
              fallbackModel={settings.defaultModel}
              size={rightPanelWidth}
              onResize={win.setRightPanelWidth}
              onActivate={(id) => activeWorkspaceId !== null && tabs.activate(activeWorkspaceId, id)}
              onCloseTab={(id) => closePaneTab('right', id)}
              onMove={(from, to) =>
                activeWorkspaceId !== null && tabs.move(activeWorkspaceId, from, to, 'right')
              }
              onOpen={(kind) =>
                activeWorkspaceId !== null && tabs.open(activeWorkspaceId, kind, 'right')
              }
              onClosePanel={win.toggleRightPanel}
            />
          )}
        </div>
      </main>

      {/*
        ★ 渲染在根 div **之内**,不 portal —— 见 SettingsOverlay 文件头:
        portal 到 body 下就够不着 `.app-no-drag`,浮层压住标题栏的那一条会被
        OS 吞掉 pointer 事件。
      */}
      {settingsPage !== null && (
        <SettingsOverlay
          page={settingsPage}
          settings={settings}
          versions={versions}
          onNavigate={win.openSettings}
          onClose={win.closeSettings}
        />
      )}
    </div>
  )
}
