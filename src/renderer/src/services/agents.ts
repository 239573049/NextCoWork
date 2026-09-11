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
