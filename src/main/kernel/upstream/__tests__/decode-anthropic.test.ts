import { describe, expect, it } from 'vitest'
import type { ProviderStreamEvent } from '../../../../shared/agent/stream'
import { anthropicErrorToAgentError, decodeAnthropic, toStopReason } from '../decode/anthropic'
import type { SseEvent } from '../sse'

/** 把一串 Anthropic 事件对象喂给解码器 */
async function decode(objs: unknown[]): Promise<ProviderStreamEvent[]> {
  async function* src(): AsyncGenerator<SseEvent> {
    for (const o of objs) {
      const data = typeof o === 'string' ? o : JSON.stringify(o)
      const event = typeof o === 'object' && o !== null ? ((o as { type?: string }).type ?? 'message') : 'message'
      yield { event, data }
    }
  }
  const out: ProviderStreamEvent[] = []
  for await (const ev of decodeAnthropic(src())) out.push(ev)
  return out
}

const START = {
  type: 'message_start',
  message: { id: 'msg_1', model: 'claude-fable-5-1', usage: { input_tokens: 100, output_tokens: 1 } }
}
const STOP = { type: 'message_stop' }

describe('decodeAnthropic · 文本', () => {
  it('最小完整流', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      STOP
    ])
    expect(out).toEqual([
      { type: 'message_start', model: 'claude-fable-5-1' },
      { type: 'text_delta', index: 0, text: '你' },
      { type: 'text_delta', index: 0, text: '好' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7 } }
    ])
  })

  it('content_block_start 自带的非空 text 也要发出去', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '预置' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out).toContainEqual({ type: 'text_delta', index: 0, text: '预置' })
  })

  it('空 text 不产生噪声事件', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out.filter((e) => e.type === 'text_delta')).toEqual([])
  })

  it('ping 被忽略', async () => {
    const out = await decode([START, { type: 'ping' }, STOP])
    expect(out.map((e) => e.type)).toEqual(['message_start', 'message_end'])
  })
})

describe('decodeAnthropic · 工具调用', () => {
  it('start / delta / end 齐全,index 与 callId 都对', async () => {
    const out = await decode([
      START,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: {} }
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th":"a"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      STOP
    ])
    expect(out.slice(1, -1)).toEqual([
      { type: 'tool_call_start', index: 0, callId: 'toolu_A', name: 'read_file' },
      { type: 'tool_call_delta', index: 0, callId: 'toolu_A', argsDelta: '{"pa' },
      { type: 'tool_call_delta', index: 0, callId: 'toolu_A', argsDelta: 'th":"a"}' },
      { type: 'tool_call_end', index: 0, callId: 'toolu_A' }
    ])
    expect(out.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'tool_use' })
  })

  /** 契约允许 delta 数量为 0(无参工具) —— start/end 仍必须成对出现 */
  it('零个 delta 的工具调用仍有 start 和 end', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'now' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out.map((e) => e.type)).toEqual(['message_start', 'tool_call_start', 'tool_call_end', 'message_end'])
  })

  /** 两个并行工具调用靠 index 归位 —— 这就是 index 不能省的原因 */
  it('并行工具调用不串台', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'x' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'y' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '0' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out.filter((e) => e.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', index: 1, callId: 'b', argsDelta: '1' },
      { type: 'tool_call_delta', index: 0, callId: 'a', argsDelta: '0' }
    ])
  })

  /**
   * ★ 漏了 content_block_start 时,**不能**编一个 callId ——
   * 编出来的 id 回传时匹配不上任何 tool_use,直接 400。丢掉这个 delta 是更小的伤。
   */
  it('没有 start 的 input_json_delta 被丢弃而不是伪造 callId', async () => {
    const out = await decode([
      START,
      { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } },
      STOP
    ])
    expect(out.some((e) => e.type === 'tool_call_delta')).toBe(false)
  })
})

describe('decodeAnthropic · 思考与透传', () => {
  it('signature_delta 累积后作为 block_opaque 发出', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'Er' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'gAB' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out).toContainEqual({ type: 'thinking_delta', index: 0, text: '嗯' })
    expect(out).toContainEqual({ type: 'block_opaque', index: 0, opaque: { signature: 'ErgAB' } })
  })

  it('thinking_delta 读的是 thinking 字段不是 text', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', text: '错字段' } },
      STOP
    ])
    expect(out.some((e) => e.type === 'thinking_delta')).toBe(false)
  })

  it('redacted_thinking 整块透传', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'EvQB..' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out).toContainEqual({ type: 'block_opaque', index: 0, opaque: { redacted: 'EvQB..' } })
  })

  it('没有 signature 的块不发 block_opaque', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_stop', index: 0 },
      STOP
    ])
    expect(out.some((e) => e.type === 'block_opaque')).toBe(false)
  })
})

describe('decodeAnthropic · usage 与 stopReason', () => {
  it('input/cache 来自 message_start,output 来自 message_delta', async () => {
    const out = await decode([
      {
        type: 'message_start',
        message: {
          model: 'm',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 3000
          }
        }
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 55 } },
      STOP
    ])
    expect(out.at(-1)).toEqual({
      type: 'message_end',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 55,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 3000
      }
    })
  })

  /**
   * ★ output_tokens 是**累计值**。写成 `+=` 的话,上游多发一条 message_delta
   * 成本就翻倍 —— 而且是静默的,数字看着很合理。
   */
  it('多条 message_delta 时 output_tokens 取最后一个而不是累加', async () => {
    const out = await decode([
      START,
      { type: 'message_delta', delta: {}, usage: { output_tokens: 30 } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 64 } },
      STOP
    ])
    expect(out.at(-1)).toMatchObject({ stopReason: 'max_tokens', usage: { outputTokens: 64 } })
  })

  it('解析 5 分钟与 1 小时缓存写入明细，并保留顶层聚合值', async () => {
    const out = await decode([
      {
        type: 'message_start',
        message: {
          model: 'm',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 300,
            cache_creation: {
              ephemeral_5m_input_tokens: 100,
              ephemeral_1h_input_tokens: 200
            }
          }
        }
      },
      STOP
    ])
    expect(out.at(-1)).toMatchObject({
      type: 'message_end',
      usage: {
        cacheCreationInputTokens: 300,
        cacheCreation1hInputTokens: 200
      }
    })
  })

  it('顶层聚合缺失时用 5m + 1h 补出总写入量', async () => {
    const out = await decode([
      {
        type: 'message_start',
        message: {
          model: 'm',
          usage: {
            input_tokens: 10,
            cache_creation: {
              ephemeral_5m_input_tokens: 40,
              ephemeral_1h_input_tokens: 60
            },
            cache_read_input_tokens: 7
          }
        }
      },
      STOP
    ])
    expect(out.at(-1)).toEqual({
      type: 'message_end',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cacheCreationInputTokens: 100,
        cacheCreation1hInputTokens: 60,
        cacheReadInputTokens: 7
      }
    })
  })

  it('未知 stop_reason 退化成 end_turn 而不是抛错', () => {
    expect(toStopReason('pause_turn')).toBe('end_turn')
    expect(toStopReason(undefined)).toBe('end_turn')
    expect(toStopReason('refusal')).toBe('refusal')
  })
})

describe('decodeAnthropic · 畸形与错误', () => {
  /** OpenAI 兼容网关常在末尾多发一行 `data: [DONE]` */
  it('非 JSON 的 data 被跳过而不是抛出', async () => {
    const out = await decode([START, '[DONE]', STOP])
    expect(out.map((e) => e.type)).toEqual(['message_start', 'message_end'])
  })

  it('JSON 但不是对象的 data 被跳过', async () => {
    const out = await decode([START, '42', '"x"', 'null', STOP])
    expect(out.map((e) => e.type)).toEqual(['message_start', 'message_end'])
  })

  it('未知事件类型被忽略', async () => {
    const out = await decode([START, { type: 'something_new_in_2027', payload: 1 }, STOP])
    expect(out.map((e) => e.type)).toEqual(['message_start', 'message_end'])
  })

  it('流中的 error 事件被归一化', async () => {
    const out = await decode([
      START,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      STOP
    ])
    expect(out).toContainEqual({
      type: 'error',
      error: { code: 'provider', message: 'Overloaded', retryable: true }
    })
  })

  /**
   * ★ 流结束了但没有 message_stop = 连接被掐断。
   * 不补这条,session 会等一个永远不来的 message_end,
   * 表现是「回复停在半句话上,转圈不停」。
   */
  it('缺少 message_stop 时补一条可重试的网络错误', async () => {
    const out = await decode([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '半句' } }
    ])
    expect(out.at(-1)).toEqual({
      type: 'error',
      error: { code: 'network', message: '上游连接在响应完成前断开', retryable: true }
    })
  })

  it('完整结束时不补那条错误', async () => {
    const out = await decode([START, STOP])
    expect(out.some((e) => e.type === 'error')).toBe(false)
  })

  it('压根没开始的空流不补错误(那是 router 的事)', async () => {
    expect(await decode([])).toEqual([])
  })
})

describe('anthropicErrorToAgentError', () => {
  const body = (type: string, message: string): unknown => ({ type: 'error', error: { type, message } })

  it('401/403 → auth 且不可重试', () => {
    for (const s of [401, 403]) {
      const e = anthropicErrorToAgentError(s, body('authentication_error', 'invalid x-api-key'))
      expect(e).toMatchObject({ code: 'auth', retryable: false, status: s })
    }
  })

  it('429 → rate_limit 且可重试', () => {
    expect(anthropicErrorToAgentError(429, body('rate_limit_error', 'slow down'))).toMatchObject({
      code: 'rate_limit',
      retryable: true
    })
  })

  /** ★ 上下文超长在 Anthropic 是 400,只能靠 message 认 —— 认出来 UI 才能提示 /compact */
  it('400 + prompt too long → context_length', () => {
    const e = anthropicErrorToAgentError(
      400,
      body('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum')
    )
    expect(e.code).toBe('context_length')
  })

  it('其余 400 → provider 且不可重试', () => {
    expect(anthropicErrorToAgentError(400, body('invalid_request_error', 'bad tool schema'))).toMatchObject({
      code: 'provider',
      retryable: false
    })
  })

  it('5xx / 529 → provider 且可重试', () => {
    for (const s of [500, 502, 529]) {
      expect(anthropicErrorToAgentError(s, body('api_error', 'boom')), `status ${s}`).toMatchObject({
        code: 'provider',
        retryable: true
      })
    }
  })

  it('响应体不是预期形状时仍给出可用的错误', () => {
    const e = anthropicErrorToAgentError(418, '<html>gateway</html>')
    expect(e.code).toBe('provider')
    expect(e.message).toContain('418')
    expect(e.status).toBe(418)
  })

  it('缓存字段被纯文本 400 明确拒绝时分类为 cache_unsupported', () => {
    const e = anthropicErrorToAgentError(400, 'cache_control is not supported', {
      cacheTtl: '5m',
      providerName: '中转站 A'
    })
    expect(e).toMatchObject({ code: 'cache_unsupported', status: 400, retryable: false })
    expect(e.message).toContain('中转站 A')
    expect(e.message).toContain('5 分钟')
    expect(e.message).toContain('cache_control is not supported')
  })

  it('422 的错误类型包含 ttl 时也分类为 cache_unsupported', () => {
    const e = anthropicErrorToAgentError(
      422,
      { type: 'error', error: { type: 'invalid_ttl', message: 'invalid request' } },
      { cacheTtl: '1h', providerName: 'Relay' }
    )
    expect(e.code).toBe('cache_unsupported')
    expect(e.message).toContain('Relay')
    expect(e.message).toContain('invalid request')
  })

  it('只有错误类型没有 message 时仍保留上游原始类型', () => {
    const e = anthropicErrorToAgentError(
      400,
      { error: { type: 'cache_control_not_supported' } },
      { cacheTtl: '5m', providerName: 'Relay' }
    )
    expect(e.code).toBe('cache_unsupported')
    expect(e.message).toContain('cache_control_not_supported')
  })

  it('error 字段为纯文本时保留中转站原始错误', () => {
    const e = anthropicErrorToAgentError(
      422,
      { error: 'cache_control is not supported by this relay' },
      { cacheTtl: '1h', providerName: 'Relay' }
    )
    expect(e.code).toBe('cache_unsupported')
    expect(e.message).toContain('cache_control is not supported by this relay')
  })

  it('无标准 message/type 的缓存拒绝 JSON 也保留原始摘要', () => {
    const e = anthropicErrorToAgentError(
      400,
      { details: { reason: 'cache_control unsupported by relay' } },
      { cacheTtl: '5m', providerName: 'Relay' }
    )
    expect(e.code).toBe('cache_unsupported')
    expect(e.message).toContain('cache_control unsupported by relay')
  })

  it('缓存关闭时普通 400 不会被误判为 cache_unsupported', () => {
    expect(
      anthropicErrorToAgentError(400, { error: { message: 'cache_control is not supported' } }, { cacheTtl: 'off' })
    ).toMatchObject({ code: 'provider', retryable: false })
  })

  it('运行时未知 TTL 按关闭处理，不会误判缓存不兼容', () => {
    expect(
      anthropicErrorToAgentError(
        400,
        { error: { message: 'cache_control is not supported' } },
        { cacheTtl: '90d' as never }
      )
    ).toMatchObject({ code: 'provider', retryable: false })
  })

  it('普通错误消息中的相似子串不会被误判为缓存不兼容', () => {
    expect(
      anthropicErrorToAgentError(400, { error: { message: 'little parameter is invalid' } }, { cacheTtl: '5m' })
    ).toMatchObject({ code: 'provider', retryable: false })
  })
})
