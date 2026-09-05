import type { ContextCheckpoint } from '../../../shared/agent/context-management'
import { invoke } from './ipc'

export function listContextCheckpoints(sessionId: string): Promise<ContextCheckpoint[]> {
  return invoke('context:list', { sessionId })
}

export function updateContextCheckpoint(checkpointId: string, note: string, revision: number): Promise<ContextCheckpoint> {
  return invoke('context:updateCheckpoint', { checkpointId, note, revision })
}
