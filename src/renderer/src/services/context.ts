import type { ContextCheckpoint } from '../../../shared/agent/context-management'
import { invoke } from './ipc'

export function listContextCheckpoints(sessionId: string): Promise<ContextCheckpoint[]> {
  return invoke('context:list', { sessionId })
}

export function updateContextCheckpoint(checkpointId: string, note: string, revision: number): Promise<ContextCheckpoint> {
  return invoke('context:updateCheckpoint', { checkpointId, note, revision })
}

/** 手动压缩上下文。返回新检查点，以及压缩后估算的输入 token。 */
export function compactContext(sessionId: string): Promise<{ checkpoint: ContextCheckpoint; inputTokens: number }> {
  return invoke('context:compact', { sessionId })
}
