/**
 * 斜杠命令的 handler —— 「磁盘上那些 md」和「输入框里那张清单」之间的接线员。
 *
 * ★ **每次都重扫**,不返回缓存。用户刚往 `.next-cowork/commands/` 里放了一个
 * 文件就敲 `/`,而「关掉窗口再打开」并不是他会想到要做的事。
 * 扫描是两次 readDir,一次弹层的成本可以忽略。
 */
import { join } from 'node:path'
import type { CommandDefinition } from '../../shared/domain/command'
import type { CommandListItem } from '../../shared/domain/markdown-resource'
import { scanCommands, type CommandScanInput } from '../kernel/command/load'
import { getHost, getWorkspaceEnvironment } from '../runtime'
import { store } from '../state/store'
import { broadcastResourceChanged } from './markdown-resource'

async function roots(workspaceId?: string): Promise<Omit<CommandScanInput, 'fs'>> {
  const host = getHost()
  const environment = workspaceId ? getWorkspaceEnvironment(workspaceId) : undefined
  return {
    globalRoot: join(host.paths.userData(), 'commands'),
    projectRoot: environment?.rootPath ? await environment.path.resolveWithin(environment.rootPath, '.next-cowork/commands') : '',
    ...(environment?.remote ? { projectFs: environment.fs, projectPath: environment.path } : {})
  }
}

/**
 * 给**运行期**用的清单 —— 已经滤掉用户关掉的那些。
 *
 * ★ 过滤在这一层，不在 `scanCommands` 里：内核不认识 kv，而「这条命令存在吗」
 *   和「我想不想用它」是两个问题。扫描器只回答前一个。
 */
export async function listCommands(req: { workspaceId?: string }): Promise<CommandDefinition[]> {
  const result = await scanCommands({ fs: getHost().fs, ...await roots(req.workspaceId) })
  const disabled = new Set(store.getDisabledCommandNames())
  return result.commands.filter((c) => !disabled.has(c.name))
}

/** 给**管理界面**用的清单 —— 关掉的那些也要列出来，否则用户没法再打开它。 */
export async function listAllCommands(req: { workspaceId?: string }): Promise<CommandListItem[]> {
  const result = await scanCommands({ fs: getHost().fs, ...await roots(req.workspaceId) })
  const disabled = new Set(store.getDisabledCommandNames())
  return result.commands.map((c) => ({
    name: c.name,
    description: c.description,
    scope: c.scope,
    source: c.source,
    ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
    enabled: !disabled.has(c.name)
  }))
}

export function setCommandEnabled(req: { name: string; enabled: boolean }): void {
  store.setCommandEnabled(req.name, req.enabled)
  broadcastResourceChanged('command')
}

export async function commandDiagnostics(
  req: { workspaceId?: string }
): Promise<Array<{ path: string; message: string }>> {
  const result = await scanCommands({ fs: getHost().fs, ...await roots(req.workspaceId) })
  return result.diagnostics.map((item) => ({ path: item.path, message: item.message }))
}
