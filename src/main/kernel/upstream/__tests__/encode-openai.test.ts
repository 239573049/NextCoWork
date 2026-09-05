import { describe, expect, it } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../shared/agent/message'
import { encodeOpenAIChat } from '../encode/openai-chat'
import { encodeOpenAIResponses } from '../encode/openai-responses'
import { REQUEST, reasoningItem } from './openai-fixtures'

const history = [
  ...REQUEST.messages,
  assistantMessage('a', [
    { type: 'thinking', text: '检查参数。', opaque: { protocol: 'openai-chat', field: 'reasoning_content' } },
    { type: 'text', text: '查询中' },
    { type: 'tool_call', callId: 'call-1', name: 'Echo', input: { text: 'hello' } },
    { type: 'tool_call', callId: 'call-2', name: 'Echo', input: {} }
  ], 0),
  toolResultMessage('t', [
    { type: 'tool_result', callId: 'call-1', isError: false, output: { content: 'hello' } },
    { type: 'tool_result', callId: 'call-2', isError: true, output: { content: 'denied' } }
  ], 0)
]

describe('OpenAI request encoders', () => {
  it('encodes the complete Chat tool conversation, preserving reasoning across later user turns', () => {
    const before = structuredClone(history)
    const encoded = encodeOpenAIChat({ ...REQUEST, messages: [...history, userMessage('u2', [{ type: 'text', text: '继续' }], 0)] }, 'deepseek-reasoner', 'test-key')
    expect(encoded.path).toBe('/chat/completions')
    expect(encoded.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer test-key' })
    expect(encoded.body).toMatchObject({ model: 'deepseek-reasoner', stream: true, stream_options: { include_usage: true }, max_tokens: 8192,
      tools: [{ type: 'function', function: { name: 'Echo', parameters: REQUEST.tools[0]?.inputSchema } }],
      messages: [
        { role: 'system', content: REQUEST.system }, { role: 'user', content: '你好' },
        { role: 'assistant', content: '查询中', reasoning_content: '检查参数。', tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'Echo', arguments: '{"text":"hello"}' } },
          { id: 'call-2', type: 'function', function: { name: 'Echo', arguments: '{}' } }
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: 'hello' },
        { role: 'tool', tool_call_id: 'call-2', content: 'denied' }, { role: 'user', content: '继续' }
      ]
    })
    expect(history).toEqual(before)
  })

  it.each(['gpt-5', 'gpt-5.4', 'openai/gpt-5', 'o3', 'o4-mini'])('uses max_completion_tokens for %s', (model) => {
    const body = encodeOpenAIChat(REQUEST, model, 'k').body
    expect(body).toHaveProperty('max_completion_tokens', 8192)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('omits UI-only and foreign thinking blocks and preserves empty reasoning with tool calls', () => {
    const messages = [assistantMessage('a', [
      { type: 'thinking', text: 'private', opaque: { signature: 'sig' } },
      { type: 'thinking', text: '', opaque: { protocol: 'openai-chat', field: 'reasoning_content' } },
      { type: 'error', error: { code: 'provider', message: 'UI only', retryable: false } },
      { type: 'tool_call', callId: 'c', name: 'Echo', input: {} }
    ], 0)]
    expect(encodeOpenAIChat({ ...REQUEST, system: '', messages }, 'glm-test', 'k').body).toMatchObject({ messages: [
      { role: 'assistant', content: null, reasoning_content: '' }
    ] })
    expect(JSON.stringify(encodeOpenAIChat({ ...REQUEST, messages }, 'glm-test', 'k').body)).not.toContain('private')
  })

  it('encodes Responses stateless reasoning and tool receipts using call_id, not item id', () => {
    const messages = structuredClone(history)
    messages[1]!.parts[0] = { type: 'thinking', text: '检查参数。', opaque: { protocol: 'openai-responses', item: reasoningItem } }
    const encoded = encodeOpenAIResponses({ ...REQUEST, messages }, 'gpt-test', 'k')
    expect(encoded.path).toBe('/responses')
    expect(encoded.body).toMatchObject({ model: 'gpt-test', instructions: REQUEST.system,
      stream: true, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 8192,
      tools: [{ type: 'function', name: 'Echo', strict: false }]
    })
    const input = (encoded.body as { input: unknown[] }).input
    expect(input[1]).toEqual(reasoningItem)
    expect(input).toContainEqual({ type: 'function_call', call_id: 'call-1', name: 'Echo', arguments: '{"text":"hello"}' })
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: 'hello' })
    expect(JSON.stringify(encoded.body)).not.toContain('reasoning_content')
  })

  it('encodes vision blocks and omits tools for tool-free requests', () => {
    const request = { ...REQUEST, tools: [], messages: [userMessage('u', [
      { type: 'text', text: '看图' }, { type: 'image', mime: 'image/png', dataRef: 'data:image/png;base64,aGVsbG8=' }
    ], 0)] }
    expect(encodeOpenAIChat(request, 'm', 'k').body).toMatchObject({ messages: [
      { role: 'system' }, { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }
    ] })
    expect(encodeOpenAIResponses(request, 'm', 'k').body).toMatchObject({ input: [
      { role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] }
    ] })
    for (const encode of [encodeOpenAIChat, encodeOpenAIResponses]) {
      expect(encode(request, 'm', 'k').body).not.toHaveProperty('tools')
      expect(encode(request, 'm', 'k').body).not.toHaveProperty('tool_choice')
    }
  })
})
