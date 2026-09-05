import { agentError, type AgentError } from '../../../../shared/agent/error'
import type { TokenUsage } from '../../../../shared/agent/stream'

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** OpenAI totals include cache reads; the canonical/priceOf input count excludes them. */
export class OpenAIUsage {
  private input: number | undefined
  private misses: number | undefined
  private cached: number | undefined
  private output = 0
  private reasoning: number | undefined

  update(value: unknown): void {
    const u = record(value)
    if (u === undefined) return
    this.input = count(u.prompt_tokens) ?? count(u.input_tokens) ?? this.input
    this.misses = count(u.prompt_cache_miss_tokens) ?? this.misses
    this.cached = count(record(u.prompt_tokens_details)?.cached_tokens)
      ?? count(record(u.input_tokens_details)?.cached_tokens)
      ?? count(u.prompt_cache_hit_tokens) ?? this.cached
    this.output = count(u.completion_tokens) ?? count(u.output_tokens) ?? this.output
    this.reasoning = count(record(u.completion_tokens_details)?.reasoning_tokens)
      ?? count(record(u.output_tokens_details)?.reasoning_tokens)
      ?? count(u.reasoning_tokens) ?? this.reasoning
  }

  snapshot(): TokenUsage {
    const cached = this.input === undefined ? this.cached : Math.min(this.cached ?? 0, this.input)
    return {
      inputTokens: this.input === undefined ? this.misses ?? 0 : this.input - (cached ?? 0),
      outputTokens: this.output,
      ...(this.cached === undefined ? {} : { cacheReadInputTokens: cached ?? 0 }),
      ...(this.reasoning === undefined ? {} : { reasoningTokens: this.reasoning })
    }
  }
}

/** Used for both HTTP errors and errors delivered inside a successful SSE connection. */
export function openAIErrorToAgentError(status: number | undefined, body: unknown): AgentError {
  const root = record(body)
  const detail = record(root?.error) ?? root
  const code = string(detail?.code) ?? string(detail?.type) ?? ''
  const message = (string(detail?.message) ?? string(root?.error) ?? string(body)
    ?? `Upstream request failed${status === undefined ? '' : ` (HTTP ${status})`}`).slice(0, 4096)
  const extra = status === undefined ? {} : { status }
  if (status === 401 || status === 403 || /invalid_api_key|authentication|permission_denied/.test(code)) {
    return agentError('auth', message, { ...extra, retryable: false })
  }
  if (/context_length|context_window|prompt_too_long/.test(code)
    || /maximum context length|context.{0,30}(exceed|too (long|large))|prompt is too long/i.test(message)) {
    return agentError('context_length', message, { ...extra, retryable: false })
  }
  if (/insufficient_quota|billing|balance/.test(code)) {
    return agentError('provider', message, { ...extra, retryable: false })
  }
  if (status === 429 || /rate_limit/.test(code)) return agentError('rate_limit', message, extra)
  return agentError('provider', message, {
    ...extra,
    retryable: (status !== undefined && (status >= 500 || status === 408 || status === 409))
      || /server_error|overloaded|temporarily_unavailable/.test(code)
  })
}

export function malformedResponse(detail: string): AgentError {
  return agentError('provider', `Invalid upstream response: ${detail}`, {
    retryable: false, messageKey: 'agent.error.invalidResponse'
  })
}

export function interruptedResponse(): AgentError {
  return agentError('network', 'The upstream connection closed before the response completed.', {
    messageKey: 'agent.error.incompleteResponse'
  })
}
