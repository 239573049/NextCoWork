import type { ScheduledRun, ScheduledTask, ScheduledTaskInput } from '../../../shared/domain/scheduled'
import { invoke, on } from './ipc'

export function listScheduledTasks(workspaceId?: string): Promise<ScheduledTask[]> {
  return invoke('scheduled:listTasks', workspaceId === undefined ? {} : { workspaceId })
}

export function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  return invoke('scheduled:getTask', { id })
}

export function createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  return invoke('scheduled:create', input)
}

export function updateScheduledTask(id: string, patch: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
  return invoke('scheduled:update', { id, patch })
}

export function deleteScheduledTask(id: string): Promise<void> {
  return invoke('scheduled:delete', { id })
}

export function setScheduledTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
  return invoke('scheduled:setEnabled', { id, enabled })
}

export function runScheduledTaskNow(id: string): Promise<ScheduledRun> {
  return invoke('scheduled:runNow', { id })
}

export function listScheduledRuns(taskId?: string, limit?: number): Promise<ScheduledRun[]> {
  return invoke('scheduled:listRuns', { ...(taskId === undefined ? {} : { taskId }), ...(limit === undefined ? {} : { limit }) })
}

export function getScheduledRun(id: string): Promise<ScheduledRun | null> {
  return invoke('scheduled:getRun', { id })
}

export function deleteScheduledRun(id: string): Promise<void> {
  return invoke('scheduled:deleteRun', { id })
}

export function onScheduledChanged(callback: (event: { kind: 'task' | 'run'; taskId?: string; runId?: string; status?: ScheduledRun['status'] }) => void): () => void {
  return on('scheduled:changed', callback)
}

export function onScheduledFocusRun(callback: (event: { runId: string }) => void): () => void {
  return on('scheduled:focusRun', callback)
}
