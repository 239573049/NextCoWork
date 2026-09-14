import type { AgentDraft } from '../../../shared/domain/agent-def'
import type { AgentListItem } from '../../../shared/domain/markdown-resource'
import { invoke, on } from './ipc'

export function listAgents(workspaceId?: string): Promise<AgentListItem[]> {
  return invoke('agents:list', workspaceId === undefined ? {} : { workspaceId })
}

export function agentDiagnostics(workspaceId?: string): Promise<Array<{ path: string; message: string }>> {
  return invoke('agents:diagnostics', workspaceId === undefined ? {} : { workspaceId })
}

export function setAgentEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke('agents:setEnabled', { name, enabled })
}

export function onAgentsChanged(callback: () => void): () => void {
  return on('agents:changed', callback)
}

/** 生成一份草稿。★ 不落盘 —— 返回的东西要先填进表单让用户过目。 */
export function generateAgent(requirement: string, workspaceId?: string): Promise<AgentDraft> {
  return invoke('agents:generate', { requirement, ...(workspaceId === undefined ? {} : { workspaceId }) })
}
