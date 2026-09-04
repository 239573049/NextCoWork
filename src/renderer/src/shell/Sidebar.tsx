/**
 * 侧边栏 —— 方案 §8 的核心结构决策落点。
 *
 * **上下两半作用域不同,不能混在一个 store 里:**
 *
 *   上半(功能入口)  作用域 = 全局      新建对话 / 搜索 / 定时任务 / 浏览器 / Skill 管理 / 每日回顾
 *   下半(会话区)    作用域 = 当前工作区  长期计划 / 最近对话 / 归档
 *
 * 这正是你要的那条行为:**切换顶部的工作空间会影响左侧会话列表**。
 * 下半的数据全部由 `activeWorkspaceId` 派生,所以「切了顶部 Tab 但左边没跟着变」
 * 这个 bug 在结构上就写不出来。
 *
 * 上半的导航项与功能外层 Tab 是**同一个东西的两个位置**(截图 4aa68110:
 * 「定时任务」的 Tab 打开时,侧边栏那一项是高亮的),所以 `activeFeature` 从
 * 外层 Tab 表反查,不另存一份。
 *
 * **297px 是量出来的,而且是定宽 —— 别改成可拖的。** 29 张截图里面板体一律占
 * x=8..304,两种窗口宽度(1146 / 1264)下同一个数,所以参考实现这条边不跟窗口走、
 * 也没有分隔条。中途一度以为它在 235~312 之间浮动,那是把设置浮层的左侧导航栏
 * 当成侧边栏量了 —— 浮层盖住了扫描线,量到的是它内部的分栏。
 */
import { MessageSquarePlus, Search, Settings, SquarePen } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { type FeatureKind, type InnerTab } from '../../../shared/domain/tab'
import type { Workspace } from '../../../shared/domain/workspace'
import type { SessionListItem } from '../../../shared/domain/session'
import { Mark } from '../components/brand/Mark'
import { EmptyState } from '../components/ui/EmptyState'
import { IconButton } from '../components/ui/IconButton'
import { cn } from '../lib/cn'
import { ChevronRight, PanelLeft } from 'lucide-react'
import { FEATURE_ICON } from './icons'
import { useI18n } from '../i18n'

const NAV_FEATURES: readonly FeatureKind[] = ['scheduled', 'browser', 'skills', 'review']

export function Sidebar({
  workspace,
  chatTabs,
  sessions,
  activeFeature,
  activeSessionId,
  runningSessionIds,
  onNewChat,
  onSearch,
  onOpenFeature,
  onOpenSettings,
  onSelectSession,
  onCollapse
}: {
  /** 当前工作区。null = 一个都没打开(下半整体降级为空态) */
  workspace: Workspace | null
  /** 当前工作区里已打开的对话 Tab —— 步骤 6 接上 SQLite 后换成真正的历史会话表 */
  chatTabs: readonly InnerTab[]
  /** 数据库中的全部会话；未打开的历史会话也应出现在侧边栏。 */
  sessions: readonly SessionListItem[]
  activeFeature: FeatureKind | null
  activeSessionId: string | null
  runningSessionIds: ReadonlySet<string>
  onNewChat: () => void
  onSearch: () => void
  onOpenFeature: (f: FeatureKind) => void
  onOpenSettings: () => void
  onSelectSession: (tabId: string) => void
  onCollapse: () => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <aside className="flex w-[297px] shrink-0 flex-col overflow-hidden rounded-panel bg-surface">
      {/*
        macOS hiddenInset 把红绿灯放在窗口左上角,而侧边栏面板正好在那里 ——
        `pl-[74px]` 是给它们让出来的位置,不是随手写的边距。
        整条 app-drag:这一行没有别的可点内容,让它可以拖窗口。
        高度必须和 AppShell 的外层 Tab 条一致(34px,量自参考图),否则红绿灯和 Tab 底边错位。
      */}
      <div className="app-drag flex h-[34px] shrink-0 items-center justify-end pr-1 pl-[74px]">
        {/*
          和 AppShell 收起态那颗是**同一个控件的两个状态**,所以尺寸必须一样,
          否则一收一放图标会跳一下大小。量 image copy 2.png(展开态):
          笔画 x274 / x287 → 字形 14px 宽(= lucide size 16),字形中心 x280.5,
          颜色 #7e7f7e = `icon`,**没有底色**。
          38 宽的盒子右边贴到 x300(pr-1)时字形中心正好落在 281 —— 对上了。
          `active` 留给收起态:参考里只有收起的那颗是挖暗 + 强调色。
        */}
        <IconButton
          label={t('nav.collapseSidebar')}
          size={28}
          width={38}
          onClick={onCollapse}
          className="rounded-pill"
        >
          <PanelLeft size={16} />
        </IconButton>
      </div>

      <div className="px-4 pt-1 pb-4 text-fg">
        <Mark />
      </div>

      {/* ── 上半:全局 ── */}
      <nav className="flex flex-col gap-0.5 px-2.5">
        <NavItem icon={<SquarePen size={16} />} onClick={onNewChat}>
          {t('nav.newChat')}
        </NavItem>
        <NavItem icon={<Search size={16} />} onClick={onSearch}>
          {t('nav.search')}
        </NavItem>
        {NAV_FEATURES.map((f) => {
          const Icon = FEATURE_ICON[f]
          return (
            <NavItem
              key={f}
              icon={<Icon size={16} />}
              active={activeFeature === f}
              onClick={() => onOpenFeature(f)}
            >
              {t(`feature.${f}` as Parameters<typeof t>[0])}
            </NavItem>
          )
        })}
      </nav>

      {/* ── 下半:当前工作区 ── */}
      <div className="scroll-thin mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2">
        {workspace === null ? (
          <EmptyState
            icon={<MessageSquarePlus size={22} />}
            title={t('workspace.none')}
            hint={t('workspace.noneHint')}
          />
        ) : (
          <>
            <Section title={t('workspace.plan')} defaultOpen={false}>
              <EmptyState title={t('workspace.noPlan')} className="py-6" />
            </Section>

            <Section
              title={t('workspace.recentChats')}
              defaultOpen
              action={
                <IconButton label={t('nav.newChat')} size={22} onClick={onNewChat}>
                  <SquarePen size={13} />
                </IconButton>
              }
            >
              {chatTabs.length === 0 && sessions.filter((s) => !s.archived).length === 0 ? (
                <EmptyState title={t('workspace.noChats')} className="py-6" />
              ) : (
                <ul className="flex flex-col gap-0.5 pb-1">
                  {chatTabs.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onSelectSession(t.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left',
                          'text-[12.5px] transition-colors',
                          t.kind === 'chat' && t.ref.sessionId === activeSessionId
                            ? 'bg-canvas text-fg'
                            : 'text-fg-muted hover:bg-tint-hover hover:text-fg'
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        {t.kind === 'chat' && runningSessionIds.has(t.ref.sessionId) && (
                          <span className="size-1.5 shrink-0 rounded-pill bg-accent" />
                        )}
                      </button>
                    </li>
                  ))}
                  {sessions
                    .filter((s) => !s.archived && !chatTabs.some((t) => t.kind === 'chat' && t.ref.sessionId === s.id))
                    .map((s) => (
                      <li key={`history-${s.id}`}>
                        <button
                          type="button"
                          onClick={() => onSelectSession(s.id)}
                          className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-tint-hover hover:text-fg"
                        >
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          {s.favorited && <span className="shrink-0 text-accent">★</span>}
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </Section>

            <Section title={t('workspace.archived')} defaultOpen={false}>
              {sessions.filter((s) => s.archived).length === 0 ? (
                <EmptyState title={t('workspace.noArchived')} className="py-6" />
              ) : (
                <ul className="flex flex-col gap-0.5 pb-1">
                  {sessions.filter((s) => s.archived).map((s) => (
                    <li key={`archived-${s.id}`}>
                      <button
                        type="button"
                        onClick={() => onSelectSession(s.id)}
                        className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-tint-hover hover:text-fg"
                      >
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        {s.favorited && <span className="shrink-0 text-accent">★</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>

      {/*
        参考实现这里是账户 / 游客模式。NextCoWork 没有账户体系(方案 §10 砍掉了
        钱包 / 云同步 / 每日回顾那一整块商业化面),所以这个位置换成设置入口 ——
        形状留着,含义换掉。
      */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('nav.settings')}
        onClick={(event) => {
          // 齿轮本身已经是独立按钮，避免事件冒泡后把打开动作执行两次。
          if (event.target instanceof Element && event.target.closest('button') !== null) return
          onOpenSettings()
        }}
        onKeyDown={(event) => {
          // 只处理卡片本身获得焦点时的键盘操作，避免齿轮按钮的按键事件重复触发。
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpenSettings()
          }
        }}
        className="mx-1.5 mb-1.5 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-card px-3 py-3 transition-colors hover:bg-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <div className="flex size-8 items-center justify-center rounded-pill bg-tint-strong text-fg">
          <Mark size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] text-fg">{t('sidebar.localMode')}</p>
          <p className="truncate text-[11px] text-fg-faint">{t('sidebar.localModeHint')}</p>
        </div>
        <IconButton label={t('common.settings')} onClick={onOpenSettings}>
          <Settings size={15} />
        </IconButton>
      </div>
    </aside>
  )
}

function NavItem({
  children,
  icon,
  active = false,
  onClick
}: {
  children: ReactNode
  icon: ReactNode
  active?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-[8px] px-3 py-[7px] text-left text-[13px] transition-colors',
        // 激活 = 往暗里挖;悬停 = 往暖里偏。两个维度,不会互相盖掉
        active ? 'bg-canvas text-fg' : 'text-fg hover:bg-tint-hover'
      )}
    >
      {/*
        ★ 导航图标**不分激活态**,一律满强度 `icon`。
        原本非激活用 `accent-soft`(#7f5944),放大 6 倍对比参考图才看出来:
        参考里五个图标是同一个强度,而我这边量出来是 #754e3c —— 整列读起来像是禁用了。
        激活态已经由行底色(`bg-canvas`)表达,不需要图标再表达第二遍。
        用 `icon` 不用 `accent`:深色参考里它是橙的,浅色参考里是中性灰,
        两者是同一个语义的两套取值 —— 见 IconButton 的注释。
      */}
      <span className="shrink-0 text-icon">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

/** 可折叠卡片 —— 截图里下半三块都是这个形状 */
function Section({
  title,
  children,
  action,
  defaultOpen
}: {
  title: string
  children: ReactNode
  /**
   * 标题右侧那个按钮。**这里刻意没有「装饰性图标」那一档** ——
   * 曾经有,结果「最近对话」把同一支笔画了两遍(卡片自己的 kind 图标一支、
   * 新建对话按钮一支),挤在一起看着像个渲染 bug。参考实现这个位置**只放动作**,
   * 没有动作就空着(截图里「归档」右侧就是空的)。
   */
  action?: ReactNode
  defaultOpen: boolean
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="shrink-0 overflow-hidden rounded-card bg-surface-raised">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={13}
            className={cn(
              // 180 而不是跟着卡片的 220:同一条曲线下,位移小的东西要更短的时间
              // 才显得是「同一下动作」—— 箭头转 90° 用 220ms 会拖在卡片后面。
              'shrink-0 text-icon transition-transform duration-180 ease-panel',
              open && 'rotate-90'
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{title}</span>
        </button>
        {action}
      </div>
      {/*
        ★ 展开高度是 `grid-template-rows: 0fr → 1fr`,不是 `height: 0 → auto`。
        后者根本动不了 —— CSS 不能在长度和关键字之间插值,`auto` 那一头没有数,
        所以「测一遍内容高度、写死像素、播完再改回 auto」是老写法要多一次
        测量+两次重排的原因。fr 两头都是数,浏览器自己会插值,而且内容改了
        (新开一个会话、列表加一行)不用重新测。

        里外必须是两层:动的是外层的行高,`overflow-hidden` 挂在里层 ——
        少一层的话内容会跟着行高一起被压扁,文字在这 280ms 里疯狂重排。
        内容**始终挂载**(不是 `{open && ...}`):收起时高度为 0,要留着才有得裁。
      */}
      <div
        className={cn(
          // 220 而不是面板的 280:这里展开的是 70~200px 的一小块,
          // 用整块侧边栏(297px)的时长会显得黏。曲线是同一条,手感才是一套。
          'grid transition-[grid-template-rows] duration-220 ease-panel',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        // 收起后里面还是可聚焦的 DOM —— 不挡住的话 Tab 键会跳进一个看不见的列表
        inert={!open}
      >
        <div className="overflow-hidden">
          <div className="px-1.5 pb-1">{children}</div>
        </div>
      </div>
    </section>
  )
}
