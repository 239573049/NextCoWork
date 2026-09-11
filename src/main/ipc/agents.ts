/**
 * 子代理的 handler —— 扩展面板里那张清单的来源。
 *
 * 在这之前子代理**完全没有 IPC**：只有 `runtime.refreshAgents()` 在每次 run
 * 之前扫一遍喂给 `Task` 工具，用户想看看自己装了些什么只能去翻目录。
 *
 * ★ 和 `refreshAgents` 的分别：那一个有副作用（替换注册表、重建 Task 工具），
 *   是运行期的一环；这里只读，纯粹回答「磁盘上有哪些」。共用 `scanAgents`，
 *   但绝不在这里碰注册表 —— 打开一次管理面板就重建一次 Task 工具，会让
 *   正在跑的 run 的工具表在中途换掉。
 */
import { join } from 'node:path'
import type { AgentListItem } from '../../shared/domain/markdown-resource'
import { AGENTS_DIR, PROJECT_AGENTS_PREFIX, scanAgents, type AgentScanInput } from '../kernel/agent/load'
import { getHost, getWorkspaceEnvironment } from '../runtime'
import { store } from '../state/store'
import { broadcastResourceChanged } from './markdown-resource'

async function roots(workspaceId?: string): Promise<Omit<AgentScanInput, 'fs'>> {
  const host = getHost()
  const environment = workspaceId ? getWorkspaceEnvironment(workspaceId) : undefined
  const remote = environment?.remote ? environment : undefined
  return {
    globalRoot: join(host.paths.userData(), AGENTS_DIR),
    projectRoot: environment?.rootPath
      ? remote
        ? await remote.path.resolveWithin(remote.rootPath, `${PROJECT_AGENTS_PREFIX}/${AGENTS_DIR}`)
        : join(environment.rootPath, PROJECT_AGENTS_PREFIX, AGENTS_DIR)
      : '',
    ...(remote ? { projectFs: remote.fs, projectPath: remote.path } : {})
  }
}

export async function listAgents(req: { workspaceId?: string }): Promise<AgentListItem[]> {
  const result = await scanAgents({ fs: getHost().fs, ...(await roots(req.workspaceId)) })
  const disabled = new Set(store.getDisabledAgentNames())
  return result.agents.map((a) => ({
    name: a.name,
    description: a.description,
    scope: a.source.kind,
    source: a.source.kind === 'builtin' ? '' : a.source.path,
    ...(a.tools !== undefined ? { tools: [...a.tools] } : {}),
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.permissionMode !== undefined ? { permissionMode: a.permissionMode } : {}),
    enabled: !disabled.has(a.name)
  }))
}

export async function agentDiagnostics(
  req: { workspaceId?: string }
): Promise<Array<{ path: string; message: string }>> {
  const result = await scanAgents({ fs: getHost().fs, ...(await roots(req.workspaceId)) })
  return result.diagnostics.map((item) => ({ path: item.path, message: item.message }))
}

export function setAgentEnabled(req: { name: string; enabled: boolean }): void {
  store.setAgentEnabled(req.name, req.enabled)
  broadcastResourceChanged('agent')
}
