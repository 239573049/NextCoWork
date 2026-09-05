import type { AgentErrorCode } from '../agent/error'
import type { StopReason } from '../agent/stream'
import type { UpstreamProtocol } from './provider'
import type { Currency } from './pricing'

/** Inclusive lower bound and exclusive upper bound for every usage query. */
export interface UsageWindow {
  from?: number
  to: number
}

export type UsageStatusFilter = 'all' | 'success' | 'failed'

/**
 * One row per upstream attempt. The row intentionally contains measurements
 * and routing metadata only: prompts, responses, credentials, and headers are
 * never part of the usage log.
 */
export interface UsageAttemptRecord {
  id: string
  at: number
  runId: string
  workspaceId: string
  sessionId: string
  attempt: number
  providerId: string
  providerName: string
  protocol: UpstreamProtocol | 'unknown'
  endpoint: string
  alias: string
  upstreamModel: string
  responseModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  thinkingTokens: number | null
  thinkingTokensEstimated: boolean
  latencyMs: number
  timeToFirstTokenMs: number | null
  ok: boolean
  httpStatus: number | null
  errorKind: AgentErrorCode | null
  errorMessage: string | null
  stopReason: StopReason | null
  costMicros: number | null
  currency: Currency | null
  pricingTier: number | null
  pricingWindow: string | null
  toolCalls: number
  toolErrors: number
}

/** Raw attempt emitted by the router before the pricing snapshot is attached. */
export type UnpricedUsageAttempt = Omit<
  UsageAttemptRecord,
  'costMicros' | 'currency' | 'pricingTier' | 'pricingWindow'
>

export interface UsageCostTotal {
  currency: Currency
  micros: number
}

export interface UsageSummary {
  requestCount: number
  successCount: number
  failedCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  thinkingTokens: number
  estimatedThinkingRequestCount: number
  totalTokens: number
  cacheHitRate: number | null
  averageLatencyMs: number | null
  averageTimeToFirstTokenMs: number | null
  toolCalls: number
  toolErrors: number
  costs: UsageCostTotal[]
}

export interface UsageRequestLogsQuery extends UsageWindow {
  query?: string
  status?: UsageStatusFilter
  offset?: number
  limit?: number
}

export interface UsageRequestLogsPage {
  items: UsageAttemptRecord[]
  total: number
  offset: number
  limit: number
}

export interface UsageDimensionStat {
  id: string
  label: string
  requestCount: number
  successCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  thinkingTokens: number
  averageLatencyMs: number | null
  averageTimeToFirstTokenMs: number | null
  toolCalls: number
  toolErrors: number
  costs: UsageCostTotal[]
}
