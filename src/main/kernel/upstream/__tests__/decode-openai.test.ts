import { describe, expect, it } from 'vitest'
import { BlockAccumulator } from '../../block-accumulator'
import { decodeOpenAIChat } from '../decode/openai-chat'
import { decodeOpenAIResponses } from '../decode/openai-responses'
import { openAIErrorToAgentError } from '../decode/openai-common'
import { chunk, collect, events, functionItem, messageItem, reasoningItem, responseDone } from './openai-fixtures'
import type { ProviderStreamEvent } from '../../../../shared/agent/stream'

function accumulated(output: ProviderStreamEvent[]): ReturnType<BlockAccumulator['finalize']> {
  const accumulator = new BlockAccumulator()
  output.forEach((e) => accumulator.apply(e))
  return accumulator.finalize()
}

describe('OpenAI Chat Completions decoding', () => {
  it('separates DeepSeek reasoning_content, content and trailing cache/reasoning usage', async () => {
    const output = await collect(decodeOpenAIChat(events(
      chunk({ role: 'assistant', content: null, reasoning_content: '' }),
      chunk({ reasoning_content: '让我' }), chunk({ reasoning_content: '思考。', content: '你好' }),
      chunk({ content: '！' }), chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 20 } } }, '[DONE]'
    )))
    expect(accumulated(output).parts).toEqual([
      { type: 'thinking', text: '让我思考。', opaque: { protocol: 'openai-chat', field: 'reasoning_content' } },
      { type: 'text', text: '你好！' }
    ])
    expect(output.at(-1)).toEqual({ type: 'message_end', stopReason: 'end_turn', usage: {
      inputTokens: 40, outputTokens: 30, cacheReadInputTokens: 60, reasoningTokens: 20
    } })
  })

  it('assembles interleaved parallel tool arguments without colliding with reasoning or text', async () => {
    const output = await collect(decodeOpenAIChat(events(
      chunk({ reasoning_content: '查两处。', content: '开始查询。', tool_calls: [
        { index: 0, id: 'a', type: 'function', function: { name: 'Echo', arguments: '{"text":' } },
        { index: 1, id: 'b', type: 'function', function: { name: 'Echo', arguments: '{"text":"二' } }
      ] }),
      chunk({ tool_calls: [
        { index: 1, function: { arguments: '"}' } }, { index: 0, function: { arguments: '"一"}' } }
      ] }), chunk({}, 'tool_calls'), '[DONE]'
    )))
    const result = accumulated(output)
    expect(result.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call', 'tool_call'])
    expect(result.calls).toEqual([
      { ok: true, callId: 'a', name: 'Echo', input: { text: '一' } },
      { ok: true, callId: 'b', name: 'Echo', input: { text: '二' } }
    ])
    expect(output.at(-1)).toMatchObject({ stopReason: 'tool_use' })
  })

  it('buffers fragmented tool metadata and closes argument-free calls', async () => {
    const output = await collect(decodeOpenAIChat(events(
      chunk({ tool_calls: [{ index: 0, id: 'call', function: { name: 'Ec' } }] }),
      chunk({ tool_calls: [{ index: 0, id: '-1', function: { name: 'ho', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call-2', function: { name: 'NoArgs' } }] }),
      chunk({}, 'tool_calls'), '[DONE]'
    )))
    expect(accumulated(output).calls).toEqual([
      { ok: true, callId: 'call-1', name: 'Echo', input: {} },
      { ok: true, callId: 'call-2', name: 'NoArgs', input: {} }
    ])
  })

  it('accepts tool identity and function metadata in separate chunks', async () => {
    const output = await collect(decodeOpenAIChat(events(
      chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function' }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'Echo', arguments: '{"text":"ok"}' } }] }),
      chunk({}, 'tool_calls'), '[DONE]'
    )))
    expect(accumulated(output).calls).toEqual([{ ok: true, callId: 'call-1', name: 'Echo', input: { text: 'ok' } }])
  })

  it('accepts a complete JSON response with message.tool_calls', async () => {
    const output = await collect(decodeOpenAIChat(events({ model: 'deepseek-test', choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      reasoning_content: '先查一下。', content: null,
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'Echo', arguments: '{"text":"hi"}' } }]
    } }], usage: { prompt_tokens: 12, completion_tokens: 9 } })))
    expect(accumulated(output).calls[0]).toMatchObject({ callId: 'a', input: { text: 'hi' } })
    expect(output.at(-1)).toMatchObject({ type: 'message_end', usage: { inputTokens: 12, outputTokens: 9 } })
  })

  it.each([[], [chunk({ content: 'partial' })], [chunk({ content: 'partial' }), '[DONE]']])('does not turn a truncated stream into success: %j', async (...frames) => {
    const output = await collect(decodeOpenAIChat(events(...frames)))
    expect(output.at(-1)).toMatchObject({ type: 'error', error: { code: 'network' } })
    expect(output.some((e) => e.type === 'message_end')).toBe(false)
  })

  it('does not close partial tool calls on length or network termination', async () => {
    for (const finish of ['length', undefined]) {
      const frames = [chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Echo', arguments: '{"text":' } }] })]
      if (finish !== undefined) frames.push(chunk({}, finish))
      const output = await collect(decodeOpenAIChat(events(...frames)))
      expect(accumulated(output).calls).toEqual([])
      expect(output.at(-1)?.type).toBe(finish === 'length' ? 'message_end' : 'error')
    }
  })

  it('keeps malformed final JSON as a tool error for the agent to report', async () => {
    const output = await collect(decodeOpenAIChat(events(chunk({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'Echo', arguments: '{bad' } }
    ] }, 'tool_calls'), '[DONE]')))
    expect(accumulated(output).calls[0]).toMatchObject({ ok: false, raw: '{bad' })
  })

  it('rejects malformed SSE, missing IDs and duplicate IDs', async () => {
    for (const frames of [
      [chunk({ content: 'partial' }), '{bad', chunk({}, 'stop')],
      [chunk({ tool_calls: [{ index: 0, function: { name: 'Echo', arguments: '{}' } }] }, 'tool_calls')],
      [chunk({ tool_calls: [0, 1].map((index) => ({ index, id: 'same', function: { name: 'Echo', arguments: '{}' } })) }, 'tool_calls')]
    ]) {
      const output = await collect(decodeOpenAIChat(events(...frames)))
      expect(output.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider' } })
      expect(accumulated(output).calls).toEqual([])
    }
  })

  it('ignores extra choices and handles refusal', async () => {
    const output = await collect(decodeOpenAIChat(events({ model: 'm', choices: [
      { index: 1, delta: { content: 'not selected' }, finish_reason: 'stop' },
      { index: 0, delta: { refusal: 'Cannot help.' }, finish_reason: 'stop' }
    ] }, '[DONE]')))
    expect(accumulated(output).parts).toEqual([{ type: 'text', text: 'Cannot help.' }])
    expect(output.at(-1)).toMatchObject({ stopReason: 'refusal' })
  })

  it('classifies in-stream provider errors', async () => {
    const output = await collect(decodeOpenAIChat(events({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })))
    expect(output).toEqual([{ type: 'error', error: { code: 'rate_limit', message: 'slow down', retryable: true } }])
  })
})

describe('OpenAI Responses decoding', () => {
  it('decodes summaries, encrypted reasoning and function arguments without repeating done snapshots', async () => {
    const output = await collect(decodeOpenAIResponses(events(
      { type: 'response.created', response: { id: 'resp-1', model: 'gpt-test', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '检查' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '参数。' },
      { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
      { type: 'response.output_item.added', output_index: 1, item: { ...functionItem, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"text":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"hello"}' },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: functionItem.arguments },
      { type: 'response.output_item.done', output_index: 1, item: functionItem },
      responseDone([reasoningItem, functionItem])
    )))
    expect(accumulated(output).parts).toEqual([
      { type: 'thinking', text: '检查参数。', opaque: { protocol: 'openai-responses', item: reasoningItem } },
      { type: 'tool_call', callId: 'call-1', name: 'Echo', input: { text: 'hello' } }
    ])
    expect(output.filter((e) => e.type === 'tool_call_start')).toHaveLength(1)
    expect(output.filter((e) => e.type === 'tool_call_end')).toHaveLength(1)
    expect(output.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'tool_use', usage: {
      inputTokens: 40, cacheReadInputTokens: 60, outputTokens: 30, reasoningTokens: 20
    } })
  })

  it('supports completed-only and JSON responses', async () => {
    const terminal = responseDone([reasoningItem, messageItem]) as { response: unknown }
    for (const frame of [terminal, terminal.response]) {
      const output = await collect(decodeOpenAIResponses(events(frame)))
      expect(accumulated(output).parts.map((p) => p.type)).toEqual(['thinking', 'text'])
      expect(output.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
    }
  })

  it('retains encrypted-only reasoning and multiple text parts', async () => {
    const output = await collect(decodeOpenAIResponses(events(responseDone([
      { ...reasoningItem, summary: [] },
      { ...messageItem, content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }
    ]))))
    expect(accumulated(output).parts).toMatchObject([
      { type: 'thinking', text: '', opaque: { item: { encrypted_content: 'encrypted-reasoning' } } },
      { type: 'text', text: 'A' }, { type: 'text', text: 'B' }
    ])
  })

  it('does not execute calls from failed, truncated or token-limited responses', async () => {
    for (const tail of [[], [responseDone([functionItem], 'incomplete', 'max_output_tokens')], [
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'failed' } } }
    ]]) {
      const output = await collect(decodeOpenAIResponses(events(
        { type: 'response.output_item.added', output_index: 0, item: functionItem }, ...tail
      )))
      expect(accumulated(output).calls).toEqual([])
      expect(output.at(-1)?.type).toBe(tail[0] !== undefined && (tail[0] as { type: string }).type === 'response.incomplete' ? 'message_end' : 'error')
    }
  })

  it('rejects changed argument snapshots and errors without an initial event', async () => {
    const output = await collect(decodeOpenAIResponses(events(
      { type: 'response.output_item.added', output_index: 0, item: functionItem },
      responseDone([{ ...functionItem, arguments: '{"different":true}' }])
    )))
    expect(output.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider' } })
    expect(accumulated(output).calls).toEqual([])
    expect((await collect(decodeOpenAIResponses(events()))).at(-1)).toMatchObject({ type: 'error' })
  })
})

describe('OpenAI error classification', () => {
  it.each([
    [401, 'invalid_api_key', 'auth', false], [403, 'forbidden', 'auth', false],
    [429, 'rate_limit_exceeded', 'rate_limit', true], [429, 'insufficient_quota', 'provider', false],
    [400, 'context_length_exceeded', 'context_length', false], [422, 'invalid_request_error', 'provider', false],
    [503, 'server_error', 'provider', true]
  ] as const)('maps HTTP %s / %s', (status, code, expected, retryable) => {
    expect(openAIErrorToAgentError(status, { error: { code, message: 'upstream detail' } }))
      .toEqual({ code: expected, message: 'upstream detail', retryable, status })
  })
})
