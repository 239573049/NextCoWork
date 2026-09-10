/**
 * 斜杠命令的 handler —— 「磁盘上那些 md」和「输入框里那张清单」之间的接线员。
 *
 * ★ **每次都重扫**,不返回缓存。用户刚往 `.next-cowork/commands/` 里放了一个
 * 文件就敲 `/`,而「关掉窗口再打开」并不是他会想到要做的事。
 * 扫描是两次 readDir,一次弹层的成本可以忽略。
 */
import { join } from 'node:path'
import type { CommandDefinition } from '../../shared/domain/command'
import { scanCommands } from '../kernel/command/load'
import { getHost } from '../runtime'
import { store } from '../state/store'

function roots(workspaceId?: string): { globalRoot: string; projectRoot: string } {
  const host = getHost()
  const workspaceRoot = workspaceId ? store.getWorkspace(workspaceId)?.rootPath : undefined
  return {
    globalRoot: join(host.paths.userData(), 'commands'),
    projectRoot: workspaceRoot ? join(workspaceRoot, '.next-cowork', 'commands') : ''
  }
}

export async function listCommands(req: { workspaceId?: string }): Promise<CommandDefinition[]> {
  const result = await scanCommands({ fs: getHost().fs, ...roots(req.workspaceId) })
  return result.commands
}

export async function commandDiagnostics(
  req: { workspaceId?: string }
): Promise<Array<{ path: string; message: string }>> {
  const result = await scanCommands({ fs: getHost().fs, ...roots(req.workspaceId) })
  return result.diagnostics.map((item) => ({ path: item.path, message: item.message }))
}
