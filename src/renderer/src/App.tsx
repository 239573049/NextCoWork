/**
 * 应用根。只做四件事:握手、订阅主进程推送、起事件泵、渲染外壳。
 *
 * ★ **握手时序照协议 §7**:`window:ready`(send)→ `app:getBootstrap`(invoke)
 * → 首屏 → 增量事件。顺序反了会出现「事件先到、状态还没到」的空窗。
 *
 * ★ **三个退订必须都调用**,否则每次 HMR 叠一层监听器 —— 只在 dev 出现,
 * 表现是一次状态更新触发 N 次重渲染,极难定位(方案 §3 规则 4)。
 *
 * ★ **`startAgentEventPump()` 在这里起一次,不在 ChatView 里**。
 * 每个 chat Tab 起一个泵的话,同一批事件会被 apply N 次,seq 校验立刻炸。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Bootstrap } from '../../shared/domain/bootstrap'
import type { AppSettings, ResolvedTheme } from '../../shared/domain/settings'
import type { Workspace } from '../../shared/domain/workspace'
import { announceReady, getBootstrap } from './services/app'
import { on } from './services/ipc'
import { AppShell } from './shell/AppShell'
import { startAgentEventPump, adoptActiveRuns, refreshHydratedSessions, useRunIndex } from './stores/session'
import { useImageThemes } from './stores/imageTheme'
import { useWindowStore } from './stores/window'
import { useTabsStore } from './stores/tabs'
import { applyTheme } from './theme/apply'
import { useI18n } from './i18n'

export default function App(): React.JSX.Element {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [appearance, setAppearance] = useState<ResolvedTheme | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [fatal, setFatal] = useState<string | null>(null)
  const hydrate = useWindowStore((s) => s.hydrate)
  const openSession = useTabsStore((s) => s.openSession)
  const { setLocale, t } = useI18n()

  useEffect(() => {
    if (settings !== null) setLocale(settings.locale)
  }, [settings, setLocale])

  useEffect(() => startAgentEventPump(), [])

  useEffect(() => {
    const offSettings = on('settings:changed', setSettings)
    const offTheme = on('theme:changed', ({ resolved }) => setAppearance(resolved))
    const offWorkspaces = on('workspace:changed', ({ workspaces: ws }) => setWorkspaces(ws))
    const offSessions = on('sessions:changed', () => { void refreshHydratedSessions() })

    announceReady('main')
    void getBootstrap()
      .then((b) => {
        setBoot(b)
        setSettings(b.settings)
        setWorkspaces(b.workspaces)
        setAppearance(b.resolvedTheme)
        hydrate(b)
        // ⌘R 重载后主进程里还活着的 run —— 角标要立刻正确,不能等下一个事件
        adoptActiveRuns(b.activeRuns)
        const raw = window.location.hash.match(/^#session=([^/]+)\/([^/]+)$/)
        if (raw !== null) {
          const workspaceId = decodeURIComponent(raw[1]!)
          const sessionId = decodeURIComponent(raw[2]!)
          openSession(workspaceId, sessionId)
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
        }
      })
      .catch((e: unknown) => setFatal(e instanceof Error ? e.message : String(e)))

    // ★ 三个退订必须都调用,否则每次 HMR 叠一层监听器
    return () => {
      offSettings()
      offTheme()
      offWorkspaces()
      offSessions()
    }
  }, [hydrate, openSession])

  /**
   * ★ **深浅和颜色是两路来的,必须汇到一处再落地。**
   * 外观模式跟着系统走(`theme:changed` 由主进程 nativeTheme 推),
   * 颜色主题跟着设置走(`settings:changed`)—— 两者各自到达,
   * 谁后到都得用上另一边的最新值。所以这里等两个 state 都有了再写一次 DOM,
   * 而不是在各自的回调里各写各的(那样切外观会把颜色抹回默认)。
   *
   * 两个都还没到的那几帧,界面用的是 `theme.css` 里写死的墨绿 —— 首屏就是对的。
   */
  /**
   * 上传的图片主题。**它和上面两路是第三个来源** —— 选中的那张如果是上传的,
   * 它的 seed 才是整套 token 的出处,所以 `uploaded` 到达之前 `resolveImageTheme`
   * 查不到这个 id,界面会先按颜色主题画一帧,拿到表之后再落一次。
   *
   * ★ 只拉表,没有第二步。底图 URL 跟着表一起来(`source.url` 是 `ncw://` 地址),
   * 原先那套「按需兑现 blob URL」的机制随协议迁移一起删掉了。
   */
  const uploadedThemes = useImageThemes((s) => s.uploaded)

  useEffect(() => {
    void useImageThemes.getState().load()
  }, [])

  useEffect(() => {
    if (appearance === null || settings === null) return
    applyTheme(document.documentElement, appearance, settings, uploadedThemes)
  }, [appearance, settings, uploadedThemes])

  // 运行中角标的数据源是 RunRegistry 的投影,不是任何 UI 状态(方案 §8)
  const runIndex = useRunIndex()
  const runningSessionIds = useMemo(() => new Set(runIndex.map((r) => r.sessionId)), [runIndex])
  const runningWorkspaceIds = useMemo(() => new Set(runIndex.map((r) => r.workspaceId)), [runIndex])

  if (fatal !== null) {
    return (
      <div className="flex h-full items-center justify-center bg-app p-8">
        <p className="selectable max-w-lg font-mono text-[13px] text-danger">{t('app.handshakeFailed', { error: fatal })}</p>
      </div>
    )
  }

  // 首屏之前不渲染外壳 —— 渲染一个空 Tab 条再让它跳成有内容的,比空一瞬间更难看
  if (boot === null || settings === null) {
    return <div className="h-full bg-app" />
  }

  return (
    <AppShell
      settings={settings}
      versions={boot.versions}
      workspaces={workspaces}
      runningSessionIds={runningSessionIds}
      runningWorkspaceIds={runningWorkspaceIds}
    />
  )
}
