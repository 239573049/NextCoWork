import type { AgentMessage } from '../../../../shared/agent/message'
import { fileRefMarkdown } from '../../../../shared/agent/message'
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
        case 'goal_status':
          break // UI-only: do not flush or create an input item.
        case 'text':
          if (part.text !== '') content.push({ type: message.role === 'user' ? 'input_text' : 'output_text', text: part.text })
          break
        case 'image':
          content.push({ type: 'input_image', image_url: part.dataRef, detail: 'auto' })
          break
        case 'file_ref':
          // ★ 不读文件、不传字节 —— 只把路径当 markdown 链接告诉模型,它自己用工具去读。
          content.push({ type: message.role === 'user' ? 'input_text' : 'output_text', text: fileRefMarkdown(part) })
          break
        case 'thinking': {
          const opaque = record(part.opaque)
          const item = record(opaque?.item)
          if (opaque?.protocol === 'openai-responses' && item?.type === 'reasoning') {
            flush()
            input.push(reasoningInputItem(item))
          }
          break
        }
        case 'tool_call':
          flush()
          input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) })
          break
        case 'tool_result': {
          flush()
          const images = part.output.images ?? []
          input.push({
            type: 'function_call_output',
            call_id: part.callId,
            output: images.length === 0
              ? part.output.content
              : [
                  { type: 'input_text', text: part.output.content },
                  ...images.map((image) => ({ type: 'input_image', image_url: image.dataRef, detail: 'auto' }))
                ]
          })
          break
        }
        // ★ `error` / `goal_status` / `subagent` 只属于 UI 那一轨 —— 落到 default,
        //   一个字节都不上行(理由见 `encode/anthropic.ts` 里对应的那两条 return null)。
        default:
          break
      }
    }
    flush()
  }
  return input
}

/**
 * 回传 reasoning item 时,只带**输入侧**认得的那几个字段。
 *
 * ★★ `block_opaque` 里存的是上游原样的 **output** item,除了要搬运的密文,
 * 还带着 `status: 'completed'` 这类只属于输出侧的字段。官方接口对它宽容,
 * 第三方网关会直接 400(`Unknown parameter: 'input[246].status'`)——
 * 而且是**整段历史都带着它**,一旦出现,这个会话之后每一轮都发不出去。
 *
 * ★ 白名单而不是把 `status` 单独删掉:网关以后再挑剔别的输出字段,
 * 不会把我们打回同一个坑。反过来,`encrypted_content` 少传一个字节,
 * 无状态续轮就丢掉整条推理链,所以这四个字段一个都不能漏。
 */
const REASONING_INPUT_FIELDS = ['type', 'id', 'summary', 'content', 'encrypted_content'] as const

function reasoningInputItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of REASONING_INPUT_FIELDS) {
    if (item[key] !== undefined) out[key] = structuredClone(item[key])
  }
  return out
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
