import type { AgentMessage } from '../../../../shared/agent/message'
import { REQUEST_PATH } from '../../../../shared/domain/baseurl'
import type { CanonicalRequest } from '../canonical'
import { record } from '../decode/openai-common'
import type { EncodedRequest } from './anthropic'

export function toOpenAIResponsesInput(messages: readonly AgentMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    let content: unknown[] = []
    const flush = (): void => {
      if (content.length === 0) return
      input.push({ role: message.role, content: message.role === 'assistant'
        ? content.map((part) => stringText(part)).join('') : content })
      content = []
    }
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          if (part.text !== '') content.push({ type: message.role === 'user' ? 'input_text' : 'output_text', text: part.text })
          break
        case 'image':
          content.push({ type: 'input_image', image_url: part.dataRef, detail: 'auto' })
          break
        case 'thinking': {
          const opaque = record(part.opaque)
          const item = record(opaque?.item)
          if (opaque?.protocol === 'openai-responses' && item?.type === 'reasoning') {
            flush()
            input.push(structuredClone(item))
          }
          break
        }
        case 'tool_call':
          flush()
          input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) })
          break
        case 'tool_result':
          flush()
          input.push({ type: 'function_call_output', call_id: part.callId, output: part.output.content })
          break
        default:
          break
      }
    }
    flush()
  }
  return input
}

function stringText(value: unknown): string {
  const text = record(value)?.text
  return typeof text === 'string' ? text : ''
}

export function encodeOpenAIResponses(req: CanonicalRequest, model: string, apiKey: string): EncodedRequest {
  return {
    path: REQUEST_PATH['openai-responses'],
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model,
      input: toOpenAIResponsesInput(req.messages),
      ...(req.system === '' ? {} : { instructions: req.system }),
      max_output_tokens: req.maxOutputTokens,
      stream: true,
      store: false,
      // Retain encrypted reasoning for stateless tool continuation, including ZDR accounts.
      include: ['reasoning.encrypted_content'],
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.tools.length === 0 ? {} : {
        tools: req.tools.map((tool) => ({
          type: 'function', name: tool.externalName, description: tool.description,
          parameters: tool.inputSchema, strict: false
        })),
        tool_choice: 'auto'
      })
    }
  }
}
