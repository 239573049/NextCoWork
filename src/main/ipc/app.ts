/**
 * 应用级 handler:握手 + 外链。
 *
 * 握手时序照协议 §7:`window:ready` → `app:getBootstrap` → 首屏 → 增量事件。
 * Bootstrap **一次拿全**,而不是让渲染层开局打七八个 invoke —— 那样会出现
 * 「设置到了但工作区还没到」的中间态,每个组件都得写一遍 loading 分支。
 */
import { app, clipboard, dialog, nativeTheme, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bootstrap } from '../../shared/domain/bootstrap'
import { runs } from '../kernel/run-registry'
import type { ResolvedTheme, ThemePreference } from '../../shared/domain/settings'
import type { WindowKind } from '../../shared/domain/tab'
import { EMPTY_OUTER, outerTabKey, store } from '../state/store'
import { windows } from '../window/registry'
import { IpcError } from './errors'
import type { ClientUpdateInfo, UpdateCheckResult } from '../../shared/domain/update'

const UPDATE_API = 'https://nextco.work/api/client/updates/latest'

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [withoutBuild = '0.0.0', build] = value.replace(/^v/, '').split('+')
    const [core = '0.0.0', pre = ''] = withoutBuild.split('-')
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [], build }
  }
  const a = parse(left); const b = parse(right)
  for (let i = 0; i < 3; i += 1) { const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0); if (diff !== 0) return diff }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const av = a.pre[i]; const bv = b.pre[i]
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1
    const an = /^\d+$/.test(av); const bn = /^\d+$/.test(bv)
    if (an && bn && av !== bv) return Number(av) - Number(bv)
    if (an !== bn) return an ? -1 : 1
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  try {
    const response = await fetch(`${UPDATE_API}?platform=${platform}&architecture=${architecture}&channel=stable`, { signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return { status: 'current', currentVersion }
    if (!response.ok) return { status: 'unavailable', currentVersion, message: `HTTP ${response.status}` }
    const envelope = await response.json() as { data?: ClientUpdateInfo } | ClientUpdateInfo
    const candidate = 'data' in envelope ? envelope.data : envelope
    const update = candidate !== undefined && typeof candidate === 'object' && 'version' in candidate
      ? candidate as ClientUpdateInfo
      : undefined
    if (!update || typeof update.version !== 'string' || typeof update.downloadUrl !== 'string') return { status: 'unavailable', currentVersion, message: 'Invalid update response' }
    if (compareVersions(update.version, currentVersion) <= 0) return { status: 'current', currentVersion }
    if (!update.downloadUrl.startsWith('https://')) return { status: 'unavailable', currentVersion, message: 'Invalid download URL' }
    return { status: 'available', currentVersion, update }
  } catch (error) {
    return { status: 'unavailable', currentVersion, message: error instanceof Error ? error.message : 'Network error' }
  }
}

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

/**
 * 另存为。渲染层给的是**文件名建议**,不是路径 —— 落点由用户在系统对话框里定,
 * 所以这条通道不需要工作区边界校验:能写到哪儿是系统对话框说了算。
 *
 * ★ 建议名要过一遍清洗。它来自模型输出(导出时取回复首行当标题),里面出现
 * `/` 或 `..` 时 `join` 会把默认落点悄悄挪到别的目录 —— 用户在对话框里
 * 未必看得出来自己正要存到哪。取消返回 null,调用方据此区分「没存」和「存失败」。
 */
export async function saveTextFile(req: { defaultName: string; text: string }): Promise<{ path: string } | null> {
  const safeName = req.defaultName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 120) || 'export.md'
  const result = await dialog.showSaveDialog({
    title: '导出为 Markdown',
    defaultPath: join(app.getPath('downloads'), safeName),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, req.text, 'utf8')
  return { path: result.filePath }
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
