import type { CanonicalRequest } from '../canonical'
import type { SseEvent } from '../sse'

export const REQUEST: CanonicalRequest = {
  model: 'test-model', system: 'You are a helpful assistant.',
  messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 0, schemaVersion: 1 }],
  tools: [{
    internalId: 'Echo', externalName: 'Echo', description: 'Echo text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    readOnly: true, destructive: false, needsNetwork: false, source: { kind: 'builtin' }
  }],
  maxOutputTokens: 8192
}

export function chunk(delta: unknown, finish_reason: string | null = null): unknown {
  return { id: 'chat-1', model: 'deepseek-test', choices: [{ index: 0, delta, finish_reason }] }
}

export async function* events(...data: unknown[]): AsyncGenerator<SseEvent> {
  for (const value of data) yield { event: 'message', data: typeof value === 'string' ? value : JSON.stringify(value) }
}

export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of stream) out.push(item)
  return out
}

export function sse(...data: unknown[]): Response {
  return new Response(data.map((v) => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
}

export const reasoningItem = {
  type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: '检查参数。' }], encrypted_content: 'encrypted-reasoning'
}
export const functionItem = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'Echo', arguments: '{"text":"hello"}' }
export const messageItem = { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: '完成', annotations: [] }] }

export function responseDone(output: unknown[], status = 'completed', reason?: string): unknown {
  return { type: `response.${status}`, response: {
    id: 'resp-1', object: 'response', model: 'gpt-test', status, output,
    usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 20 } },
    ...(reason === undefined ? {} : { incomplete_details: { reason } })
  } }
}
