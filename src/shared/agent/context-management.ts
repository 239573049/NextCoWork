import type { AgentMessage } from './message'

export type ContextCheckpointSource = 'model' | 'mechanical' | 'manual' | 'auto'
export type ContextStatusPhase = 'preparing' | 'ready' | 'fallback' | 'error'

export interface ContextSearchHit {
  messageId: string
  role: AgentMessage['role']
  createdAt: number
  snippet: string
}

export interface ContextCheckpoint {
  id: string
  sessionId: string
  windowIndex: number
  note: string
  source: ContextCheckpointSource
  coveredFromMessageId?: string
  coveredThroughMessageId?: string
  inputTokensBefore?: number
  inputTokensAfter?: number
  searchHits?: ContextSearchHit[]
  createdAt: number
  updatedAt: number
  revision: number
}

export interface ContextStatus {
  phase: ContextStatusPhase
  windowIndex?: number
}

/** 发送给摘要模型的旧历史边界，避免把内部状态混入 AgentMessage。 */
export interface ContextCompactionInput {
  messages: readonly AgentMessage[]
  previousNote?: string
  force: boolean
}
