import type { ContextCheckpoint } from '../../shared/agent/context-management'
import { store } from '../state/store'

export function listContextCheckpoints(req: { sessionId: string }): ContextCheckpoint[] {
  return store.listContextCheckpoints(req.sessionId)
}

export function updateContextCheckpoint(req: { checkpointId: string; note: string; revision: number }): ContextCheckpoint {
  const note = req.note.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32_000)
  if (note === '') throw new Error('上下文笔记不能为空')
  return store.updateContextCheckpoint(req.checkpointId, note, req.revision, Date.now())
}
