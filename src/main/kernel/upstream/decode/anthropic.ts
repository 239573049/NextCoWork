/**
 * Anthropic SSE → ProviderStreamEvent。
 *
 * 方案 §5.1 的 `decodeUpstream` 三份之一。**归一化层的重量都在这里** ——
 * 上游的形状是「按 index 的内容块 + 增量」,我们的形状也是,所以这一份基本是直译;
 * OpenAI 那两份(步骤 13)要把扁平字段升成块模型,难得多。
 *
 * ★ 这个文件对**畸形输入**的态度是统一的:**跳过,不抛**。
 * 一个 decode 循环里的 throw 会穿过 router、穿过 session,最后变成一个
 * 「run 无声消失」——而它的起因可能只是上游多发了一行 `data: [DONE]`
 * (OpenAI 兼容网关常干这事)。跳过则最多丢一个事件,流还在。
 * 真正的致命错误走 `error` 事件,那条路是显式的。
 */
import { agentError, type AgentError } from '../../../../shared/agent/error'
import type { ProviderStreamEvent, StopReason, TokenUsage } from '../../../../shared/agent/stream'
import {
  normalizeAnthropicCacheTtl,
  type AnthropicCacheTtl
} from '../../../../shared/domain/provider'
import type { SseEvent } from '../sse'

// ─── 从 unknown 里安全取值 ───────────────────────────────────────────
// 上游返回的是 unknown,而 tsconfig 开了 strict + noUncheckedIndexedAccess。
// 与其在每个取值点写断言,不如在这里写四个 10 行的函数。

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}
function str(o: Record<string, unknown> | undefined, k: string): string | undefined {
  const v = o?.[k]
  return typeof v === 'string' ? v : undefined
}
function num(o: Record<string, unknown> | undefined, k: string): number | undefined {
  const v = o?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function sub(o: Record<string, unknown> | undefined, k: string): Record<string, unknown> | undefined {
  return rec(o?.[k])
}

const ERROR_BODY_SUMMARY_LIMIT = 4096
const CACHE_FIELD_PATTERN =
  /cache[_ -]?control|cache[_ -]?breakpoint|(?:^|[^a-z0-9])(ephemeral|ttl)(?:$|[^a-z0-9])/i

function errorBodySummary(value: string): string {
  if (value.length <= ERROR_BODY_SUMMARY_LIMIT) return value

  // If a large relay response buries the useful field name in `details`, keep
  // the bounded excerpt centred around that evidence instead of returning an
  // unrelated 4 KB prefix.
  const match = CACHE_FIELD_PATTERN.exec(value)
  if (match === null) return `${value.slice(0, ERROR_BODY_SUMMARY_LIMIT)}…`
  const before = Math.floor((ERROR_BODY_SUMMARY_LIMIT - match[0].length) / 3)
  const start = Math.max(0, match.index - before)
  const end = Math.min(value.length, start + ERROR_BODY_SUMMARY_LIMIT)
  const adjustedStart = Math.max(0, end - ERROR_BODY_SUMMARY_LIMIT)
  return `${adjustedStart > 0 ? '…' : ''}${value.slice(adjustedStart, end)}${end < value.length ? '…' : ''}`
}

/**
 * 错误响应不一定是 Anthropic 官方的 JSON 形状。
 *
 * 兼容中转站常见的几种返回分别是：
 *
 * - `{ error: { type, message } }`（官方形状）；
 * - `{ message, type }`（把 `error` 外壳剥掉）；
 * - 纯文本或 HTML（网关/反向代理自己的错误页）。
 *
 * 缓存兼容性错误的判定必须覆盖这三类，否则一个返回纯文本
 * `cache_control is not supported` 的中转站会被误当成普通 400，随后触发
 * 重试/切换，既违背配置错误语义，也可能重复产生费用。
 */
function errorDetails(
  body: unknown,
  status: number
): { message: string; kind: string; mentionsCacheField: boolean; raw: string } {
  const root = rec(body)
  const nested = sub(root, 'error')
  const nestedMessage = str(nested, 'message')
  const rootMessage = str(root, 'message')
  const errorValue = root?.['error']
  const errorText = typeof errorValue === 'string' ? errorValue.trim() : ''
  const text = typeof body === 'string' ? body.trim() : ''
  let serialized = ''
  if (body !== null && typeof body === 'object') {
    try {
      serialized = JSON.stringify(body)
    } catch {
      // Error bodies normally come from JSON.parse and cannot be cyclic; keep
      // the structured message fallback if a custom relay violates that.
    }
  }
  const raw = errorBodySummary(text !== '' ? text : serialized)
  const unboundedMessage =
    nestedMessage ??
    rootMessage ??
    (errorText !== ''
      ? errorText
      : raw === ''
        ? `上游返回 ${status}`
        : `上游返回 ${status}: ${raw}`)
  const message = errorBodySummary(unboundedMessage)
  const kind = str(nested, 'type') ?? str(root, 'type') ?? ''
  const mentionsCacheField = [message, kind, text, serialized]
    .some((value) => CACHE_FIELD_PATTERN.test(value))
  return { message, kind, mentionsCacheField, raw }
}

/**
 * 上游的 stop_reason → 我们的 StopReason。
 *
 * ★ 未知值映射成 `end_turn` 而不是抛错。上游随时可能加新的停止原因
 * (`pause_turn` 就是后来加的),而「多了一个我们不认识的停止原因」
 * 不该让用户的这一轮对话失败 —— 内容已经收到了。
 */
export function toStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
      return raw
    default:
      return 'end_turn'
  }
}

/**
 * Anthropic 的错误体 + HTTP 状态码 → AgentError。
 *
 * 导出给 UpstreamRouter 用:非 2xx 响应**不是 SSE**,是一个 JSON 体,
 * 由 router 拿着 Response 分类。分类规则写在这里是因为它属于「Anthropic 协议知识」,
 * 和 router 的「重试与切换策略」是两件事。
 */
export function anthropicErrorToAgentError(
  status: number,
  body: unknown,
  options: { cacheTtl?: AnthropicCacheTtl; providerName?: string } = {}
): AgentError {
  const { message, kind, mentionsCacheField, raw } = errorDetails(body, status)
  const cacheTtl = normalizeAnthropicCacheTtl(options.cacheTtl)

  if (
    (status === 400 || status === 422) &&
    cacheTtl !== 'off' &&
    mentionsCacheField
  ) {
    const ttl = cacheTtl === '1h' ? '1 小时' : '5 分钟'
    const provider = options.providerName === undefined ? '当前供应商' : `供应商「${options.providerName}」`
    // Some relays provide only an error type (for example
    // `cache_control_not_supported`) and omit `message`. Keep that raw type in
    // the actionable error so the user can identify the upstream limitation.
    const standardError =
      kind !== '' && !message.toLowerCase().includes(kind.toLowerCase())
        ? `${kind}: ${message}`
        : message
    // A relay may put the useful cache rejection only in a non-standard
    // `details` object while returning a generic official-looking message.
    // The full body participates in classification; include a bounded raw
    // summary as well so the actionable error does not discard that evidence.
    const upstreamError =
      raw !== '' &&
      CACHE_FIELD_PATTERN.test(raw) &&
      !CACHE_FIELD_PATTERN.test(`${message}\n${kind}`)
        ? `${standardError}; ${raw}`
        : standardError
    return agentError(
      'cache_unsupported',
      `${provider}拒绝了 Anthropic ${ttl}提示缓存配置：${upstreamError}。请在供应商设置中关闭或调整提示缓存。`,
      { status, retryable: false }
    )
  }

  if (status === 401 || status === 403) {
    return agentError('auth', message, { status, retryable: false })
  }
  if (status === 429) {
    return agentError('rate_limit', message, { status })
  }
  if (status === 400) {
    // ★ 上下文超长在 Anthropic 这里是 400 + invalid_request_error,
    // 只能靠 message 认。认出来 UI 才能提示 /compact;认不出来用户看到的是
    // 一句没有任何行动指引的「invalid request」。
    if (/prompt is too long|context.{0,20}too long|maximum.{0,20}tokens/i.test(message)) {
      return agentError('context_length', message, { status, retryable: false })
    }
    return agentError('provider', message, { status, retryable: false })
  }
  if (status === 529 || status >= 500) {
    // overloaded_error / api_error —— 上游自己的问题,可重试
    return agentError('provider', message, { status, retryable: true })
  }
  return agentError(
    'provider',
    kind === '' ? message : `${kind}: ${message}`,
    { status, retryable: false }
  )
}

/** SSE 流里的 `event: error`(不是 HTTP 错误 —— 那时连接已经是 200 了) */
function inStreamError(data: Record<string, unknown>): AgentError {
  const err = sub(data, 'error')
  const kind = str(err, 'type') ?? ''
  const message = str(err, 'message') ?? '上游在流中报错'
  if (kind === 'overloaded_error') return agentError('provider', message, { retryable: true })
  if (kind === 'rate_limit_error') return agentError('rate_limit', message)
  return agentError('provider', kind === '' ? message : `${kind}: ${message}`, { retryable: false })
}

/** 块类型只在 content_block_start 出现一次,后面的 delta/stop 只有 index */
type BlockKind = 'text' | 'thinking' | 'tool_use' | 'other'

export async function* decodeAnthropic(
  events: AsyncIterable<SseEvent>
): AsyncGenerator<ProviderStreamEvent> {
  const kinds = new Map<number, BlockKind>()
  const callIds = new Map<number, string>()
  /** thinking 块的签名可能分多个 signature_delta 到达,累积到 content_block_stop 再发 */
  const signatures = new Map<number, string>()

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: StopReason = 'end_turn'
  let sawStart = false
  let sawEnd = false

  for await (const ev of events) {
    let data: Record<string, unknown> | undefined
    try {
      data = rec(JSON.parse(ev.data))
    } catch {
      // `data: [DONE]` 之类的非 JSON 行。见文件头:跳过,不抛。
      continue
    }
    if (!data) continue

    // ★ 以 data.type 为准,不以 `event:` 字段为准。两者在 Anthropic 是一致的,
    // 但中间隔一层兼容网关时,`event:` 更容易被改写(或干脆不发)。
    const type = str(data, 'type') ?? ev.event

    switch (type) {
      case 'message_start': {
        const msg = sub(data, 'message')
        const u = sub(msg, 'usage')
        usage.inputTokens = num(u, 'input_tokens') ?? 0
        const cc = num(u, 'cache_creation_input_tokens')
        const cr = num(u, 'cache_read_input_tokens')
        const reasoning =
          num(u, 'thinking_tokens') ??
          num(u, 'reasoning_tokens') ??
          num(sub(u, 'output_tokens_details'), 'reasoning_tokens')
        const creation = sub(u, 'cache_creation')
        const write5m = num(creation, 'ephemeral_5m_input_tokens')
        const write1h = num(creation, 'ephemeral_1h_input_tokens')
        if (cc !== undefined) usage.cacheCreationInputTokens = cc
        else if (write5m !== undefined || write1h !== undefined) {
          usage.cacheCreationInputTokens = (write5m ?? 0) + (write1h ?? 0)
        }
        if (write1h !== undefined) usage.cacheCreation1hInputTokens = write1h
        if (cr !== undefined) usage.cacheReadInputTokens = cr
        if (reasoning !== undefined) usage.reasoningTokens = reasoning
        sawStart = true
        yield { type: 'message_start', model: str(msg, 'model') ?? '<unknown>' }
        break
      }

      case 'content_block_start': {
        const index = num(data, 'index')
        const block = sub(data, 'content_block')
        if (index === undefined || !block) break
        const kind = str(block, 'type')

        if (kind === 'tool_use') {
          const callId = str(block, 'id') ?? `call_${index}`
          kinds.set(index, 'tool_use')
          callIds.set(index, callId)
          yield {
            type: 'tool_call_start',
            index,
            callId,
            name: str(block, 'name') ?? '<unknown>'
          }
        } else if (kind === 'thinking') {
          kinds.set(index, 'thinking')
          // start 时 signature 一般是空串,真值走 signature_delta
          const sig = str(block, 'signature')
          if (sig !== undefined && sig !== '') signatures.set(index, sig)
          const text = str(block, 'thinking')
          if (text !== undefined && text !== '') yield { type: 'thinking_delta', index, text }
        } else if (kind === 'redacted_thinking') {
          // ★ 整块不透明,没有任何 delta,一次到位。它必须原样回传,
          // 否则下一轮 Anthropic 会认为思考链被篡改。
          kinds.set(index, 'other')
          yield { type: 'block_opaque', index, opaque: { redacted: str(block, 'data') ?? '' } }
        } else {
          kinds.set(index, kind === 'text' ? 'text' : 'other')
          const text = str(block, 'text')
          if (text !== undefined && text !== '') yield { type: 'text_delta', index, text }
        }
        break
      }

      case 'content_block_delta': {
        const index = num(data, 'index')
        const delta = sub(data, 'delta')
        if (index === undefined || !delta) break

        switch (str(delta, 'type')) {
          case 'text_delta': {
            const text = str(delta, 'text')
            if (text !== undefined) yield { type: 'text_delta', index, text }
            break
          }
          case 'thinking_delta': {
            // 注意字段名是 `thinking`,不是 `text`
            const text = str(delta, 'thinking')
            if (text !== undefined) yield { type: 'thinking_delta', index, text }
            break
          }
          case 'signature_delta': {
            const s = str(delta, 'signature')
            if (s !== undefined) signatures.set(index, (signatures.get(index) ?? '') + s)
            break
          }
          case 'input_json_delta': {
            const callId = callIds.get(index)
            const argsDelta = str(delta, 'partial_json')
            // callId 缺失说明我们漏了 content_block_start —— 丢掉这个 delta 好过
            // 编一个 callId:编出来的 id 回传时不匹配任何 tool_use,直接 400
            if (callId !== undefined && argsDelta !== undefined) {
              yield { type: 'tool_call_delta', index, callId, argsDelta }
            }
            break
          }
          default:
            break
        }
        break
      }

      case 'content_block_stop': {
        const index = num(data, 'index')
        if (index === undefined) break
        const sig = signatures.get(index)
        if (sig !== undefined && sig !== '') {
          signatures.delete(index)
          yield { type: 'block_opaque', index, opaque: { signature: sig } }
        }
        if (kinds.get(index) === 'tool_use') {
          const callId = callIds.get(index)
          if (callId !== undefined) {
            callIds.delete(index)
            yield { type: 'tool_call_end', index, callId }
          }
        }
        kinds.delete(index)
        break
      }

      case 'message_delta': {
        stopReason = toStopReason(str(sub(data, 'delta'), 'stop_reason'))
        // ★ output_tokens 只在这里给,而且是**累计值**不是增量 —— 直接赋值。
        // 写成 `+=` 的话,上游多发一条 message_delta(带 stop_sequence 时会)
        // 成本就翻倍了,而且是静默的。
        const out = num(sub(data, 'usage'), 'output_tokens')
        if (out !== undefined) usage.outputTokens = out
        const deltaUsage = sub(data, 'usage')
        // Some Anthropic-compatible gateways omit input usage from
        // message_start and provide the complete accounting in the terminal
        // message_delta instead. Preserve those API-reported fields.
        const input = num(deltaUsage, 'input_tokens')
        if (input !== undefined) usage.inputTokens = input
        const cacheRead = num(deltaUsage, 'cache_read_input_tokens')
        if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead
        const cacheCreate = num(deltaUsage, 'cache_creation_input_tokens')
        if (cacheCreate !== undefined) usage.cacheCreationInputTokens = cacheCreate
        const reasoning =
          num(deltaUsage, 'thinking_tokens') ??
          num(deltaUsage, 'reasoning_tokens') ??
          num(sub(deltaUsage, 'output_tokens_details'), 'reasoning_tokens')
        if (reasoning !== undefined) usage.reasoningTokens = reasoning
        break
      }

      case 'message_stop':
        sawEnd = true
        yield { type: 'message_end', stopReason, usage: { ...usage } }
        break

      case 'error':
        yield { type: 'error', error: inStreamError(data) }
        break

      case 'ping':
      default:
        break
    }
  }

  // ★ 流结束了但没收到 message_stop = 连接被中途掐断。
  // 不补这条的话,session 会等到一个永远不来的 message_end,表现是
  // 「回复停在半句话上,转圈不停」。中断走的是 throw,不会到这里。
  if (sawStart && !sawEnd) {
    yield {
      type: 'error',
      error: agentError('network', '上游连接在响应完成前断开', { retryable: true })
    }
  }
}
