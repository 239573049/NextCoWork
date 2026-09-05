/**
 * 应用级 handler:握手 + 外链。
 *
 * 握手时序照协议 §7:`window:ready` → `app:getBootstrap` → 首屏 → 增量事件。
 * Bootstrap **一次拿全**,而不是让渲染层开局打七八个 invoke —— 那样会出现
 * 「设置到了但工作区还没到」的中间态,每个组件都得写一遍 loading 分支。
 */
import { app, clipboard, nativeTheme, shell } from 'electron'
import type { Bootstrap } from '../../shared/domain/bootstrap'
import { runs } from '../kernel/run-registry'
import type { ResolvedTheme, ThemePreference } from '../../shared/domain/settings'
import type { WindowKind } from '../../shared/domain/tab'
import { EMPTY_OUTER, outerTabKey, store } from '../state/store'
import { windows } from '../window/registry'
import { IpcError } from './errors'

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return pref
}

/** 设置页三态直接映射到 Electron 的 themeSource,系统菜单/原生控件才会跟着变 */
export function applyThemePreference(pref: ThemePreference): ResolvedTheme {
  nativeTheme.themeSource = pref
  return resolveTheme(pref)
}

export function getBootstrap(windowKind: WindowKind): Bootstrap {
  const settings = store.getSettings()
  return {
    windowKind,
    settings,
    resolvedTheme: resolveTheme(settings.theme),
    workspaces: store.listWorkspaces(),
    tabState: store.getKv(outerTabKey(windowKind), EMPTY_OUTER),
    // ★ 正常冷启动一定是空的 ——「永不恢复运行中状态」(方案 §9)。
    //   非空只发生在渲染层重载(⌘R):主进程没重启,run 还活着。
    activeRuns: runs.activeRunIds().flatMap((id) => {
      const run = runs.get(id)
      return run === undefined || run.parentRunId !== undefined ? [] : [{
        runId: run.runId, sessionId: run.sessionId, workspaceId: run.workspaceId, status: run.status
      }]
    }),
    activeSubagents: runs.activeRunIds().flatMap((id) => {
      const run = runs.get(id)
      const parent = run?.parentRunId === undefined ? undefined : runs.get(run.parentRunId)
      // The child uses an isolated derived session for its own transcript. The
      // bootstrap route must carry the parent's session so the Task card can
      // be restored into the conversation that launched it.
      return run === undefined || run.parentRunId === undefined || parent === undefined ? [] : [{
        runId: run.runId,
        parentRunId: run.parentRunId,
        sessionId: parent.sessionId,
        workspaceId: parent.workspaceId,
        status: run.status,
        startedAt: run.startedAt
      }]
    }),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }
}

/**
 * 外链一律交给系统浏览器,且只放行 https。
 * 与 main/index.ts 里 setWindowOpenHandler 的策略保持一致 ——
 * 那边挡的是 window.open,这边挡的是渲染层显式请求。两个口子,一条规则。
 */
export async function openExternal(url: string): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new IpcError('unknown', `拒绝打开非 https 链接: ${url}`)
  }
  await shell.openExternal(url)
}

let sessionWindowOpener: ((workspaceId: string, sessionId: string) => void) | null = null

export function setSessionWindowOpener(opener: (workspaceId: string, sessionId: string) => void): void {
  sessionWindowOpener = opener
}

export function copyText(text: string): void {
  clipboard.writeText(text)
}

export function openSessionWindow(req: { workspaceId: string; sessionId: string }): void {
  if (sessionWindowOpener === null) throw new IpcError('unknown', '暂时无法打开新窗口')
  sessionWindowOpener(req.workspaceId, req.sessionId)
}

/** 跟随系统时,系统切换深浅色要能推到所有窗口 */
export function registerThemeBridge(): void {
  nativeTheme.on('updated', () => {
    if (store.getSettings().theme !== 'system') return
    windows.emitToAll('theme:changed', {
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    })
  })
}
