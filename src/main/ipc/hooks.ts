/**
 * Hooks 的 handler —— 两份 settings 文件和扩展面板之间的接线员。
 *
 * 分工同 `ipc/skills.ts`:形状转换在内核(`kernel/hook/load.ts`),文件读写在
 * `kernel/local-settings.ts`,这里只做三件事 —— 算路径、铸 id、广播。
 *
 * ★ 本阶段**只管存**。事件触发点和命令执行是下一阶段的事,现在配好的 hook
 *   一条也不会响。这个隔离是故意的:执行引擎要动 `runtime.ts` 的审批闸和
 *   `agent-session.ts` 的工具循环,风险比存储高一个量级,不该和存储一起上。
 */
import type { HookDefinition, HookEvent, HookListItem, HookScope } from '../../shared/domain/hook'
import type { HookRunReport } from '../kernel/hook/run'
import { recentHookFailures, testHook } from '../hooks'
import { EnvironmentError } from '../environment/errors'
import {
  assignIds,
  hasMissingIds,
  hookListFrom,
  mergeHookLists,
  removeHook,
  setHookEnabled,
  upsertHook
} from '../kernel/hook/load'
import {
  globalSettingsPath,
  localSettingsPath,
  readGlobalSettings,
  readLocalSettings,
  writeHooks
} from '../kernel/local-settings'
import { getHost, getWorkspaceEnvironment } from '../runtime'
import { ulid } from '../../shared/util/id'
import { windows } from '../window/registry'

function broadcast(): void {
  windows.emitToAll('hooks:changed', undefined)
}

/** 项目级那份文件的路径。没有工作区时返回空串。 */
function projectPathOf(workspaceId?: string): string {
  if (!workspaceId) return ''
  const environment = getWorkspaceEnvironment(workspaceId)
  return environment.rootPath === '' ? '' : localSettingsPath(environment.rootPath)
}

/**
 * 读一层，顺便把手写条目缺的 id 补上。
 *
 * ★ 「读列表」在这里可能写一次文件，看着像副作用失控，但没有别的地方能做：
 *   用户手写的条目不可能自带 ULID，而开关和删除都需要一个稳定的键。
 *   补齐是幂等的 —— 补完之后再读就不会再写了。
 */
async function readLayer(
  scope: HookScope,
  path: string,
  workspaceRoot: string
): Promise<HookListItem[]> {
  if (path === '') return []
  const host = getHost()
  const settings = scope === 'global'
    ? await readGlobalSettings(host.fs, host.paths.userData(), host.logger)
    : await readLocalSettings(host.fs, workspaceRoot, host.logger)

  if (hasMissingIds(settings.hooks)) {
    const filled = assignIds(settings.hooks, ulid)
    const out = await writeHooks(host.fs, path, () => filled, host.logger)
    if (out.ok) return hookListFrom(filled, scope, path)
    // 写不进去（文件坏了 / 只读）也要让用户看见这些 hook，只是它们还没有稳定 id。
    host.logger.warn(`[hooks] ${path} 的 id 补齐失败：${out.reason}`)
  }
  return hookListFrom(settings.hooks, scope, path)
}

export async function listHooks(req: { workspaceId?: string }): Promise<HookListItem[]> {
  const host = getHost()
  const globalPath = globalSettingsPath(host.paths.userData())
  const projectPath = projectPathOf(req.workspaceId)
  const workspaceRoot = req.workspaceId ? getWorkspaceEnvironment(req.workspaceId).rootPath : ''

  const [globalHooks, projectHooks] = await Promise.all([
    readLayer('global', globalPath, ''),
    readLayer('project', projectPath, workspaceRoot)
  ])
  return mergeHookLists(globalHooks, projectHooks)
}

function pathFor(scope: HookScope, workspaceId?: string): string {
  if (scope === 'global') return globalSettingsPath(getHost().paths.userData())
  const path = projectPathOf(workspaceId)
  if (path === '') throw new EnvironmentError('unbound')
  return path
}

export async function saveHook(req: {
  scope: HookScope
  workspaceId?: string
  hook: Omit<HookDefinition, 'id'> & { id?: string }
}): Promise<HookListItem> {
  const host = getHost()
  const path = pathFor(req.scope, req.workspaceId)
  const id = req.hook.id !== undefined && req.hook.id !== '' ? req.hook.id : ulid()
  const hook: HookDefinition = { ...req.hook, id }

  const out = await writeHooks(host.fs, path, (hooks) => upsertHook(hooks, hook), host.logger)
  if (!out.ok) {
    throw new Error(out.reason === 'unreadable' ? '这个设置文件读不懂，拒绝覆盖' : '写入失败')
  }
  broadcast()
  return { ...hook, scope: req.scope, sourcePath: path }
}

export async function deleteHook(req: { scope: HookScope; workspaceId?: string; id: string }): Promise<void> {
  const host = getHost()
  const path = pathFor(req.scope, req.workspaceId)
  const out = await writeHooks(host.fs, path, (hooks) => removeHook(hooks, req.id), host.logger)
  if (!out.ok) throw new Error(out.reason === 'unreadable' ? '这个设置文件读不懂，拒绝覆盖' : '写入失败')
  broadcast()
}

export async function setHookEnabledIpc(req: {
  scope: HookScope
  workspaceId?: string
  id: string
  enabled: boolean
}): Promise<void> {
  const host = getHost()
  const path = pathFor(req.scope, req.workspaceId)
  const out = await writeHooks(host.fs, path, (hooks) => setHookEnabled(hooks, req.id, req.enabled), host.logger)
  if (!out.ok) throw new Error(out.reason === 'unreadable' ? '这个设置文件读不懂，拒绝覆盖' : '写入失败')
  broadcast()
}

export async function hookDiagnostics(req: { workspaceId?: string }): Promise<Array<{ path: string; message: string }>> {  // 归一化会把读不懂的条目**静默丢掉**（那是刻意的，一条坏 hook 不该让整个文件作废），
  // 所以「文件里有几条 vs 认出来几条」的差值就是诊断的来源。
  const host = getHost()
  const out: Array<{ path: string; message: string }> = []
  const layers: Array<[HookScope, string, string]> = [
    ['global', globalSettingsPath(host.paths.userData()), '']
  ]
  const projectPath = projectPathOf(req.workspaceId)
  if (projectPath !== '') {
    layers.push(['project', projectPath, getWorkspaceEnvironment(req.workspaceId as string).rootPath])
  }

  for (const [scope, path, root] of layers) {
    try {
      const settings = scope === 'global'
        ? await readGlobalSettings(host.fs, host.paths.userData(), host.logger)
        : await readLocalSettings(host.fs, root, host.logger)
      const recognized = hookListFrom(settings.hooks, scope, path).length
      const raw = await countRawHooks(path)
      if (raw > recognized) {
        out.push({ path, message: `有 ${String(raw - recognized)} 条钩子读不懂，已忽略（检查 command 和 matcher）` })
      }
    } catch {
      out.push({ path, message: '读不了这个文件' })
    }
  }
  // 运行期的失败也算诊断 —— 钩子失败不阻断运行，这是用户唯一能发现
  // 「我那条钩子一直在报错」的地方。
  return [...out, ...recentHookFailures()]
}

/**
 * 试运行。跑的是弹层里此刻的草稿，不读磁盘 —— 理由见 `main/hooks.ts` 的 `testHook`。
 */
export async function testHookIpc(req: {
  workspaceId?: string
  scope: HookScope
  event: HookEvent
  command: string
  timeoutMs: number
}): Promise<HookRunReport> {
  if (!req.workspaceId) throw new EnvironmentError('unbound')
  return testHook({
    environment: getWorkspaceEnvironment(req.workspaceId),
    event: req.event,
    command: req.command,
    timeoutMs: req.timeoutMs,
    scope: req.scope
  })
}

/** 文件里 hooks 段下一共写了几条（不做任何校验）。 */
async function countRawHooks(path: string): Promise<number> {
  const host = getHost()
  if (!(await host.fs.exists(path))) return 0
  try {
    const raw = JSON.parse(await host.fs.readFile(path)) as { hooks?: Record<string, unknown[]> }
    const hooks = raw.hooks
    if (hooks === null || typeof hooks !== 'object') return 0
    return Object.values(hooks).reduce<number>((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
  } catch {
    return 0
  }
}
