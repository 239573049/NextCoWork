import type { ProviderStreamEvent, StopReason } from '../../../../shared/agent/stream'
import type { SseEvent } from '../sse'
import { count, interruptedResponse, malformedResponse, OpenAIUsage, openAIErrorToAgentError, record, string } from './openai-common'

interface Segment { index: number; text: string }
interface Item {
  index: number
  kind: string
  id: string
  callId: string
  name: string
  args: string
  started: boolean
  opaqueSent: boolean
  segments: Map<number, Segment>
}

class InvalidResponse extends Error {}

// Reserve a namespace per output item. A late content part must stay before the
// next output item even when parallel events arrive in a different order.
const INDEX_STRIDE = 1_000_000

/** Responses output_index, content_index and call_id are three separate namespaces. */
export async function* decodeOpenAIResponses(events: AsyncIterable<SseEvent>): AsyncGenerator<ProviderStreamEvent> {
  const items = new Map<number, Item>()
  const usage = new OpenAIUsage()
  let started = false
  let refused = false

  function itemAt(outputIndex: number, kind: string): Item {
    if (outputIndex >= INDEX_STRIDE) throw new InvalidResponse('output_index exceeds supported range')
    let item = items.get(outputIndex)
    if (item === undefined) {
      item = { index: outputIndex * INDEX_STRIDE, kind, id: '', callId: '', name: '', args: '', started: false, opaqueSent: false, segments: new Map() }
      items.set(outputIndex, item)
    } else if (item.kind !== kind) throw new InvalidResponse('output item type changed')
    return item
  }

  function* text(item: Item, partIndex: number, value: string, complete: boolean): Generator<ProviderStreamEvent> {
    if (partIndex >= INDEX_STRIDE) throw new InvalidResponse('content index exceeds supported range')
    let segment = item.segments.get(partIndex)
    if (segment === undefined) {
      segment = { index: item.index + partIndex, text: '' }
      item.segments.set(partIndex, segment)
    }
    if (complete && !value.startsWith(segment.text)) throw new InvalidResponse('completed text does not match streamed text')
    const delta = complete ? value.slice(segment.text.length) : value
    segment.text += delta
    if (delta !== '') yield { type: item.kind === 'reasoning' ? 'thinking_delta' : 'text_delta', index: segment.index, text: delta }
  }

  function* argumentsDelta(item: Item, value: string, complete: boolean): Generator<ProviderStreamEvent> {
    if (!item.started) {
      if (item.callId === '' || item.name === '') throw new InvalidResponse('missing function call identity')
      item.started = true
      yield { type: 'tool_call_start', index: item.index, callId: item.callId, name: item.name }
    }
    if (complete && !value.startsWith(item.args)) throw new InvalidResponse('completed arguments do not match streamed arguments')
    const delta = complete ? value.slice(item.args.length) : value
    item.args += delta
    if (delta !== '') yield { type: 'tool_call_delta', index: item.index, callId: item.callId, argsDelta: delta }
  }

  function* acceptItem(raw: unknown, outputIndex: number, complete: boolean): Generator<ProviderStreamEvent> {
    const value = record(raw)
    const kind = string(value?.type)
    if (kind === undefined || value === undefined) throw new InvalidResponse('missing output item type')
    const item = itemAt(outputIndex, kind)
    const id = string(value.id)
    if (id !== undefined) {
      if (item.id !== '' && item.id !== id) throw new InvalidResponse('output item identity changed')
      item.id = id
    }
    if (kind === 'function_call') {
      const callId = string(value.call_id) ?? item.callId
      const name = string(value.name) ?? item.name
      if (item.started && (item.callId !== callId || item.name !== name)) throw new InvalidResponse('function identity changed')
      item.callId = callId
      item.name = name
      yield* argumentsDelta(item, string(value.arguments) ?? '', true)
    } else if (kind === 'message' && Array.isArray(value.content)) {
      for (const [index, part] of value.content.entries()) {
        const content = record(part)
        if (content?.type === 'refusal') refused = true
        const body = string(content?.text) ?? string(content?.refusal)
        if (body !== undefined) yield* text(item, index, body, true)
      }
    } else if (kind === 'reasoning') {
      if (Array.isArray(value.summary)) {
        for (const [index, part] of value.summary.entries()) {
          const body = string(record(part)?.text)
          if (body !== undefined) yield* text(item, index, body, true)
        }
      }
      if (complete && !item.opaqueSent) {
        item.opaqueSent = true
        // Preserve the complete item, including encrypted_content, exactly once.
        yield { type: 'block_opaque', index: item.index, opaque: { protocol: 'openai-responses', item: structuredClone(value) } }
      }
    }
  }

  try {
    for await (const event of events) {
      if (event.data.trim() === '[DONE]') break
      if (event.data.trim() === '') continue
      let data: Record<string, unknown> | undefined
      try { data = record(JSON.parse(event.data)) } catch { throw new InvalidResponse('invalid Responses JSON') }
      if (data === undefined) continue
      const type = string(data.type) ?? event.event
      const response = record(data.response) ?? (data.object === 'response' ? data : undefined)
      if (type === 'error' || (data.error !== undefined && response === undefined) || type === 'response.failed'
        || response?.status === 'failed') {
        yield { type: 'error', error: openAIErrorToAgentError(undefined, response ?? data) }
        return
      }
      if (!started && (response !== undefined || type.startsWith('response.'))) {
        started = true
        yield { type: 'message_start', model: string(response?.model) ?? '<unknown>' }
      }
      usage.update(response?.usage)
      const outputIndex = count(data.output_index)
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        if (outputIndex === undefined) throw new InvalidResponse('missing output_index')
        yield* acceptItem(data.item, outputIndex, type.endsWith('.done'))
      } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const item = outputIndex === undefined ? undefined : items.get(outputIndex)
        if (item?.kind !== 'function_call') throw new InvalidResponse('arguments arrived before function call')
        yield* argumentsDelta(item, string(type.endsWith('.done') ? data.arguments : data.delta) ?? '', type.endsWith('.done'))
      } else if (type === 'response.output_text.delta' || type === 'response.output_text.done'
        || type === 'response.refusal.delta' || type === 'response.refusal.done'
        || type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done') {
        if (outputIndex === undefined) throw new InvalidResponse('missing output_index')
        const reasoning = type.includes('reasoning_summary')
        const isRefusal = type.includes('refusal')
        if (isRefusal) refused = true
        const item = itemAt(outputIndex, reasoning ? 'reasoning' : 'message')
        const done = type.endsWith('.done')
        const value = string(done ? (isRefusal ? data.refusal : data.text) : data.delta)
        if (value === undefined) throw new InvalidResponse('missing text delta')
        yield* text(item, count(reasoning ? data.summary_index : data.content_index) ?? 0, value, done)
      }

      if (type === 'response.completed' || type === 'response.incomplete' || data.object === 'response') {
        if (response === undefined) throw new InvalidResponse('missing terminal response')
        if (Array.isArray(response.output)) {
          for (const [index, value] of response.output.entries()) yield* acceptItem(value, index, true)
        }
        const incomplete = type === 'response.incomplete' || response.status === 'incomplete'
        const reason = string(record(response.incomplete_details)?.reason)
        if (incomplete && reason !== 'max_output_tokens' && reason !== 'content_filter') {
          yield { type: 'error', error: malformedResponse(`incomplete response: ${reason ?? 'unknown'}`) }
          return
        }
        if (data.object === 'response' && response.status !== 'completed' && !incomplete) {
          throw new InvalidResponse('non-terminal JSON response')
        }
        const calls = [...items.values()].filter((item) => item.kind === 'function_call')
        const stopReason: StopReason = incomplete && reason === 'max_output_tokens' ? 'max_tokens'
          : refused || reason === 'content_filter' ? 'refusal' : calls.length > 0 ? 'tool_use' : 'end_turn'
        if (stopReason === 'tool_use') {
          if (new Set(calls.map((call) => call.callId)).size !== calls.length) throw new InvalidResponse('duplicate call_id')
          for (const call of calls) {
            yield { type: 'tool_call_end', index: call.index, callId: call.callId }
          }
        }
        yield { type: 'message_end', stopReason, usage: usage.snapshot() }
        return
      }
    }
  } catch (error) {
    if (!(error instanceof InvalidResponse)) throw error
    yield { type: 'error', error: malformedResponse(error.message) }
    return
  }
  yield { type: 'error', error: interruptedResponse() }
}
