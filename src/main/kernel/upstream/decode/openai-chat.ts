import type { ProviderStreamEvent, StopReason } from '../../../../shared/agent/stream'
import type { SseEvent } from '../sse'
import { count, interruptedResponse, malformedResponse, OpenAIUsage, openAIErrorToAgentError, record, string } from './openai-common'

interface Call {
  index: number
  id: string
  name: string
  args: string
  started: boolean
}

/** Chat Completions flattens text/reasoning and independently indexes tool calls. */
export async function* decodeOpenAIChat(events: AsyncIterable<SseEvent>): AsyncGenerator<ProviderStreamEvent> {
  const usage = new OpenAIUsage()
  const calls = new Map<number, Call>()
  let nextIndex = 0
  let textIndex: number | undefined
  let thinkingIndex: number | undefined
  let started = false
  let finish: string | undefined
  let refused = false

  function* startCall(call: Call): Generator<ProviderStreamEvent> {
    if (call.started || call.id === '' || call.name === '') return
    call.started = true
    yield { type: 'tool_call_start', index: call.index, callId: call.id, name: call.name }
    if (call.args !== '') yield { type: 'tool_call_delta', index: call.index, callId: call.id, argsDelta: call.args }
    call.args = ''
  }

  for await (const event of events) {
    if (event.data.trim() === '[DONE]') break
    if (event.data.trim() === '') continue
    let data: Record<string, unknown> | undefined
    try { data = record(JSON.parse(event.data)) } catch {
      yield { type: 'error', error: malformedResponse('invalid Chat Completions JSON') }
      return
    }
    if (data === undefined) continue
    if (data.error !== undefined || event.event === 'error') {
      yield { type: 'error', error: openAIErrorToAgentError(undefined, data) }
      return
    }
    usage.update(data.usage)
    if (!Array.isArray(data.choices)) continue
    const choice = data.choices.map(record).find((c, i) => c?.index === 0 || (i === 0 && c?.index === undefined))
    if (choice === undefined) continue // usage-only chunk, or another choice
    if (!started) {
      started = true
      yield { type: 'message_start', model: string(data.model) ?? '<unknown>' }
    }
    const delta = record(choice.delta) ?? record(choice.message)
    if (finish !== undefined && delta !== undefined && Object.keys(delta).length > 0) {
      yield { type: 'error', error: malformedResponse('content after finish_reason') }
      return
    }
    if (delta !== undefined) {
      const thinking = string(delta.reasoning_content)
      if (thinking !== undefined) {
        if (thinkingIndex === undefined) {
          thinkingIndex = nextIndex++
          yield { type: 'block_opaque', index: thinkingIndex, opaque: { protocol: 'openai-chat', field: 'reasoning_content' } }
        }
        if (thinking !== '') yield { type: 'thinking_delta', index: thinkingIndex, text: thinking }
      }
      const refusal = string(delta.refusal)
      if (refusal) refused = true
      const text = string(delta.content) ?? refusal
      if (text !== undefined && text !== '') {
        textIndex ??= nextIndex++
        yield { type: 'text_delta', index: textIndex, text }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const [position, raw] of delta.tool_calls.entries()) {
          const tool = record(raw)
          const fn = record(tool?.function)
          // Non-streaming message.tool_calls omits index; streaming deltas must identify it.
          const upstreamIndex = count(tool?.index) ?? (choice.message !== undefined ? position : undefined)
          if (tool === undefined || (tool.function !== undefined && fn === undefined) || upstreamIndex === undefined
            || (tool.type !== undefined && tool.type !== 'function')) {
            yield { type: 'error', error: malformedResponse('invalid tool call') }
            return
          }
          let call = calls.get(upstreamIndex)
          if (call === undefined) {
            call = { index: nextIndex++, id: '', name: '', args: '', started: false }
            calls.set(upstreamIndex, call)
          }
          const id = string(tool.id) ?? ''
          const name = string(fn?.name) ?? ''
          if (call.started && ((id !== '' && id !== call.id) || (name !== '' && name !== call.name))) {
            yield { type: 'error', error: malformedResponse('tool identity changed during streaming') }
            return
          }
          if (!call.started) {
            if (id !== call.id) call.id += id
            if (name !== call.name) call.name += name
          }
          const args = string(fn?.arguments) ?? ''
          if (call.started) {
            if (args !== '') yield { type: 'tool_call_delta', index: call.index, callId: call.id, argsDelta: args }
          } else {
            call.args += args
            if (args !== '') yield* startCall(call)
          }
        }
      }
    }
    finish = string(choice.finish_reason) ?? finish
  }

  // EOF without a finish_reason is never success, even if a relay sent [DONE].
  if (!started || finish === undefined) {
    yield { type: 'error', error: interruptedResponse() }
    return
  }
  const stopReason: StopReason = finish === 'length' ? 'max_tokens'
    : finish === 'content_filter' || refused ? 'refusal'
      : finish === 'tool_calls' || (finish === 'stop' && calls.size > 0) ? 'tool_use' : 'end_turn'
  if (stopReason === 'tool_use') {
    if (calls.size === 0 || [...calls.values()].some((call) => call.id === '' || call.name === '')
      || new Set([...calls.values()].map((call) => call.id)).size !== calls.size) {
      yield { type: 'error', error: malformedResponse('missing or duplicate tool call identity') }
      return
    }
    for (const call of calls.values()) {
      yield* startCall(call)
      yield { type: 'tool_call_end', index: call.index, callId: call.id }
    }
  }
  yield { type: 'message_end', stopReason, usage: usage.snapshot() }
}
