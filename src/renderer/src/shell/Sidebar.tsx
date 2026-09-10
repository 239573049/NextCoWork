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
import { Archive, Check, Copy, ExternalLink, Link, LoaderCircle, MessageSquarePlus, Pin, Search, Settings, SquarePen, Trash2, Pencil, ListChecks } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { type FeatureKind, type InnerTab } from '../../../shared/domain/tab'
import type { Workspace } from '../../../shared/domain/workspace'
import type { SessionListItem } from '../../../shared/domain/session'
import type { ClientAuthState } from '../../../shared/domain/client-auth'
import { Mark } from '../components/brand/Mark'
import { EmptyState } from '../components/ui/EmptyState'
import { IconButton } from '../components/ui/IconButton'
import { cn } from '../lib/cn'
import { IS_MAC } from '../lib/platform'
import { ChevronRight, PanelLeft } from 'lucide-react'
import { FEATURE_ICON } from './icons'
import { useI18n, type Translate } from '../i18n'
import { ContextMenu, type ContextMenuPosition } from '../components/ui/ContextMenu'
import { Dialog } from '../components/ui/Dialog'
import { Button } from '../components/ui/Button'
import { duplicateSession, renameSession, setArchived, setFavorited } from '../services/sessions'
import { copyText, openSessionWindow } from '../services/app'

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
  onDeleteSession,
  onCollapse,
  auth
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
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => Promise<void>
  onCollapse: () => void
  auth: ClientAuthState
}): ReactNode {
  const { t } = useI18n()
  return (
    <aside className="flex w-[297px] shrink-0 flex-col overflow-hidden rounded-panel bg-surface">
      {/*
        macOS hiddenInset 把红绿灯放在窗口左上角,而侧边栏面板正好在那里 ——
        `pl-[74px]` 是给它们让出来的位置,不是随手写的边距。**所以它只给 macOS**:
        Windows/Linux 的三颗按钮在右上角(见 main/window/title-bar.ts),
        这里再留 74px 就是个空洞。收起按钮本来就右对齐,换成常规内边距即可。
        整条 app-drag:这一行没有别的可点内容,让它可以拖窗口。
        高度必须和 AppShell 的外层 Tab 条一致(34px,量自参考图),否则红绿灯和 Tab 底边错位。
      */}
      <div
        className={cn(
          'app-drag flex h-[34px] shrink-0 items-center justify-end pr-1',
          IS_MAC ? 'pl-[74px]' : 'pl-2'
        )}
      >
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

      <div className="flex items-center gap-2 px-4 pt-1 pb-4 text-fg">
        <Mark />
        <span className="font-brand text-[15px] font-bold tracking-tight">NextCoWork</span>
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
              {sessions.filter((s) => !s.archived).length === 0 &&
              chatTabs.every((tab) => tab.kind !== 'chat' || sessions.some((s) => s.id === tab.ref.sessionId && s.archived)) ? (
                <EmptyState title={t('workspace.noChats')} className="py-6" />
              ) : (
                <ul className="flex flex-col gap-0.5 pb-1">
                  <SessionGroupList
                    workspaceId={workspace.id}
                    sessions={sessions}
                    chatTabs={chatTabs}
                    activeSessionId={activeSessionId}
                    runningSessionIds={runningSessionIds}
                    onSelectSession={onSelectSession}
                    onDeleteSession={onDeleteSession}
                    t={t}
                  />
                </ul>
              )}
            </Section>

            <Section title={t('workspace.archived')} defaultOpen={false}>
              {sessions.filter((s) => s.archived).length === 0 ? (
                <EmptyState title={t('workspace.noArchived')} className="py-6" />
              ) : (
                <ul className="flex flex-col gap-0.5 pb-1">
                  {sessions.filter((s) => s.archived).map((s) => (
                    <ArchivedSessionItem
                      key={s.id}
                      session={s}
                      workspaceId={workspace.id}
                      onSelectSession={onSelectSession}
                      onDeleteSession={onDeleteSession}
                      t={t}
                    />
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
          <p className="truncate text-[12.5px] text-fg">{auth.mode === 'authenticated' ? (auth.user?.displayName || auth.user?.username || auth.user?.email || t('sidebar.signedIn')) : t('sidebar.localMode')}</p>
          <p className="truncate text-[11px] text-fg-faint">{auth.mode === 'authenticated' ? t('sidebar.signedInHint') : t('sidebar.localModeHint')}</p>
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

type SidebarI18n = Translate

/**
 * 历史会话按更新时间分组。已打开的 Tab 仍由 session id 去重，
 * 这样点击历史项只会激活现有 Tab，不会在列表里再画一条重复记录。
 */
function SessionGroupList({
  workspaceId,
  sessions,
  chatTabs,
  activeSessionId,
  runningSessionIds,
  onSelectSession,
  onDeleteSession,
  t
}: {
  workspaceId: string
  sessions: readonly SessionListItem[]
  chatTabs: readonly InnerTab[]
  activeSessionId: string | null
  runningSessionIds: ReadonlySet<string>
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => Promise<void>
  t: SidebarI18n
}): ReactNode {
  /*
    ★ **只列库里真有的会话。**

    这里曾经还有一段「Tab 里有、但库里没有 → 合成一条列表项」的补丁,那是
    `sessions:create` IPC 往返期间的兜底。现在渲染层根本不建会话了(白纸不落库,
    见 `stores/tabs.ts` 的 `makeTab`),那段补丁就成了草稿垃圾的唯一来源 ——
    每开一个空 Tab 这里就凭空多一行「新对话」,而库里什么都没有,右键删也删不掉。

    草稿的去处是顶部那条 Tab 栏,它本来就在那儿。发出第一条消息之后主进程
    `runAgent` 才 `ensureSession`,广播 `sessions:changed`,这一行才出现。
  */
  const allSessions: SessionListItem[] = sessions.filter((session) => !session.archived)
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const startOfRecent = startOfToday - 6 * 86_400_000
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const toggleSelected = (sessionId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }
  const groups = [
    { key: 'today', title: t('workspace.today'), items: allSessions.filter((s) => s.updatedAt >= startOfToday) },
    { key: 'recent', title: t('workspace.last7Days'), items: allSessions.filter((s) => s.updatedAt < startOfToday && s.updatedAt >= startOfRecent) },
    { key: 'earlier', title: t('workspace.earlier'), items: allSessions.filter((s) => s.updatedAt < startOfRecent) }
  ] as const

  return (
    <>
      {groups.map((group) => {
        const visible = group.items.filter((s) => !chatTabs.some((tab) => tab.kind === 'chat' && tab.ref.sessionId === s.id))
        const openTabs = group.items.filter((s) => chatTabs.some((tab) => tab.kind === 'chat' && tab.ref.sessionId === s.id))
        const items = [...openTabs, ...visible]
        if (items.length === 0) return null
        return (
          <SessionGroupBlock
            key={group.key}
            title={group.title}
            items={items}
            chatTabs={chatTabs}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
            t={t}
            multiSelect={multiSelect}
            selectedIds={selectedIds}
            toggleSelected={toggleSelected}
            onToggleMultiSelect={() => {
              setMultiSelect((value) => !value)
              setSelectedIds(new Set())
            }}
            workspaceId={workspaceId}
          />
        )
      })}
    </>
  )
}

function SessionGroupBlock({
  title,
  items,
  chatTabs,
  activeSessionId,
  runningSessionIds,
  onSelectSession,
  onDeleteSession,
  t,
  multiSelect,
  selectedIds,
  toggleSelected,
  onToggleMultiSelect,
  workspaceId
}: {
  title: string
  items: readonly SessionListItem[]
  chatTabs: readonly InnerTab[]
  activeSessionId: string | null
  runningSessionIds: ReadonlySet<string>
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => Promise<void>
  t: SidebarI18n
  multiSelect: boolean
  selectedIds: ReadonlySet<string>
  toggleSelected: (sessionId: string) => void
  onToggleMultiSelect: () => void
  workspaceId: string
}): ReactNode {
  const [open, setOpen] = useState(true)
  const [menu, setMenu] = useState<{ session: SessionListItem; position: ContextMenuPosition } | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'rename'; session: SessionListItem } | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const run = async (action: () => Promise<void>): Promise<void> => {
    try { await action() } catch (error) { console.error('[sessions] 操作失败', error) }
    setMenu(null)
    setConfirmingDeleteId(null)
  }
  return (
    <li className="pt-1 first:pt-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11.5px] text-fg-faint"
      >
        <ChevronRight size={12} className={cn('transition-transform duration-180', open && 'rotate-90')} />
        <span>{title}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {items.map((session) => {
            const openTab = chatTabs.find((tab) => tab.kind === 'chat' && tab.ref.sessionId === session.id)
            const active = session.id === activeSessionId
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => multiSelect ? toggleSelected(session.id) : onSelectSession(session.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ session, position: { x: event.clientX, y: event.clientY } })
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                    active ? 'bg-canvas text-fg' : 'text-fg-muted hover:bg-tint-hover hover:text-fg'
                  )}
                >
                      {multiSelect && <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] border', selectedIds.has(session.id) ? 'border-accent bg-accent text-canvas' : 'border-border')}>
                        {selectedIds.has(session.id) && <Check size={11} />}
                      </span>}
                      <span className="min-w-0 flex-1 truncate">{openTab?.title ?? session.title}</span>
                  {(runningSessionIds.has(session.id) || session.running) && (
                    <LoaderCircle size={12} aria-label={t('chat.taskChecklistRunning')} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
                  )}
                  {session.favorited && <span className="shrink-0 text-accent">★</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {menu !== null && (
        <ContextMenu position={menu.position} label={t('session.menu')} onClose={() => {
          setMenu(null)
          setConfirmingDeleteId(null)
        }} width={220}>
          {(close) => (
            <>
              <MenuAction icon={<ExternalLink size={15} />} label={t('session.openNewWindow')} onSelect={() => {
                void run(() => openSessionWindow(workspaceId, menu.session.id))
              }} />
              <MenuAction icon={<Pencil size={15} />} label={t('session.rename')} onSelect={() => {
                setRenameDraft(menu.session.title)
                setConfirmingDeleteId(null)
                setDialog({ kind: 'rename', session: menu.session })
                close()
              }} />
              <MenuAction icon={<Copy size={15} />} label={t('session.copy')} onSelect={() => {
                void run(async () => {
                  await duplicateSession(menu.session.id, t('session.copyTitle', { title: menu.session.title }))
                })
              }} />
              <MenuAction icon={<Link size={15} />} label={t('session.copyLink')} onSelect={() => {
                void run(async () => {
                  await copyText(`${window.location.href.split('#')[0]}#session=${encodeURIComponent(workspaceId)}/${encodeURIComponent(menu.session.id)}`)
                })
              }} />
              <div role="separator" className="my-1 h-px bg-border" />
              <MenuAction icon={<Pin size={15} />} label={menu.session.favorited ? t('session.unpin') : t('session.pin')} onSelect={() => void run(() => setFavorited(menu.session.id, !menu.session.favorited))} />
              <MenuAction icon={<Archive size={15} />} label={menu.session.archived ? t('session.unarchive') : t('session.archive')} onSelect={() => void run(() => setArchived(menu.session.id, !menu.session.archived))} />
              <MenuAction icon={<ListChecks size={15} />} label={multiSelect ? t('session.multiSelectDone') : t('session.multiSelect')} onSelect={() => { setConfirmingDeleteId(null); close(); onToggleMultiSelect() }} />
              <div role="separator" className="my-1 h-px bg-border" />
              <MenuAction
                danger
                icon={<Trash2 size={15} />}
                label={confirmingDeleteId === menu.session.id ? t('common.confirmDelete') : t('session.delete')}
                onSelect={() => {
                  if (confirmingDeleteId === menu.session.id) {
                    void run(() => onDeleteSession(menu.session.id))
                  } else {
                    setConfirmingDeleteId(menu.session.id)
                  }
                }}
              />
            </>
          )}
        </ContextMenu>
      )}
      <Dialog
        open={dialog?.kind === 'rename'}
        onClose={() => setDialog(null)}
        title={t('session.rename')}
        width={420}
        footer={
          <>
            <Button size="sm" onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="accent" disabled={renameDraft.trim().length === 0} onClick={() => {
              if (dialog?.kind !== 'rename') return
              void run(() => renameSession(dialog.session.id, renameDraft)).then(() => setDialog(null))
            }}>{t('common.save')}</Button>
          </>
        }
      >
        <label className="block text-[12px] text-fg-muted" htmlFor="session-rename-input">{t('session.renamePrompt')}</label>
        <input id="session-rename-input" autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} className="selectable mt-2 h-9 w-full rounded-[8px] border border-border bg-surface-field px-2.5 text-[13px] text-fg outline-none focus:border-accent" />
      </Dialog>
    </li>
  )
}

function MenuAction({ icon, label, danger = false, onSelect }: { icon: ReactNode; label: string; danger?: boolean; onSelect: () => void }): ReactNode {
  return <button type="button" role="menuitem" onClick={onSelect} className={cn('flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13px] transition-colors hover:bg-tint-strong', danger ? 'text-danger' : 'text-fg')}><span className={danger ? 'text-danger' : 'text-accent-soft'}>{icon}</span><span className="truncate">{label}</span></button>
}

/**
 * 归档列表里的一行。曾经这里只是个裸 `<button>`,没有右键菜单 ——
 * 「取消归档」「删除」两个动作都挂在 `SessionGroupBlock` 的上下文菜单里,
 * 而归档区渲染的是另一段 JSX,压根没接那套菜单,于是归档会话删不掉、
 * 也无法一键恢复回「最近对话」。这里补一份缩小版菜单,复用同样的 IPC。
 */
function ArchivedSessionItem({
  session,
  workspaceId,
  onSelectSession,
  onDeleteSession,
  t
}: {
  session: SessionListItem
  workspaceId: string
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => Promise<void>
  t: SidebarI18n
}): ReactNode {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const run = async (action: () => Promise<void>): Promise<void> => {
    try { await action() } catch (error) { console.error('[sessions] 操作失败', error) }
    setMenu(null)
    setConfirmingDelete(false)
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectSession(session.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-tint-hover hover:text-fg"
      >
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {session.favorited && <span className="shrink-0 text-accent">★</span>}
      </button>
      {menu !== null && (
        <ContextMenu position={menu} label={t('session.menu')} onClose={() => { setMenu(null); setConfirmingDelete(false) }} width={220}>
          {() => (
            <>
              <MenuAction icon={<ExternalLink size={15} />} label={t('session.openNewWindow')} onSelect={() => {
                void run(() => openSessionWindow(workspaceId, session.id))
              }} />
              <MenuAction icon={<Copy size={15} />} label={t('session.copy')} onSelect={() => {
                void run(async () => { await duplicateSession(session.id, t('session.copyTitle', { title: session.title })) })
              }} />
              <div role="separator" className="my-1 h-px bg-border" />
              <MenuAction icon={<Archive size={15} />} label={t('session.unarchive')} onSelect={() => void run(() => setArchived(session.id, false))} />
              <div role="separator" className="my-1 h-px bg-border" />
              <MenuAction
                danger
                icon={<Trash2 size={15} />}
                label={confirmingDelete ? t('common.confirmDelete') : t('session.delete')}
                onSelect={() => {
                  if (confirmingDelete) {
                    void run(() => onDeleteSession(session.id))
                  } else {
                    setConfirmingDelete(true)
                  }
                }}
              />
            </>
          )}
        </ContextMenu>
      )}
    </li>
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
