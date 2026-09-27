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
        case 'compact_boundary':
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
          const replay = opaque?.protocol === 'openai-responses' && item !== undefined && item.type === 'reasoning'
            ? reasoningInputItem(item)
            : undefined
          /*
            ★★ **转录里这条思考只要有正文,`input` 里就必须有一个带正文的 reasoning item。**
            DeepSeek 的思考模式把这条写成了硬校验:带 tools 的请求,历史每一轮的
            reasoning_text 必须完整回传,缺失即 400 ——
            `The \`reasoning_text\` in the thinking mode must be passed back to the API`。

            而 opaque 只是回传的载体,不是思考正文的唯一来源。三种情况下旧逻辑
            (按协议键门控、只认 opaque)会一个字节都不上行,表现是**界面上思考好好的、
            转录也完整,请求却 400,且本地全程零报错**:
            - 流在 `output_item.done` 之前被打断,或网关不发 reasoning 的 done 事件;
            - 会话里混进另一条协议产生的思考轮次(中途换过模型/供应商),协议键对不上;
            - 上游 item 经上面的字段白名单过滤后没剩下任何正文(只剩 id 之类)。
            这三种情况全文都还在 `part.text` 里 —— 本条分支的需求就是把它补回上行链路。

            ★ 有 summary / content 正文 / encrypted_content 的 item **一个字节都不改**:
            那条路径是官方 OpenAI 那侧验证过的;给它再补一份 content 等于回传两份正文,
            输入 token 随之翻倍。合成/补全出来的只带 content:不编造 id、不搬
            encrypted_content(那是上游签发给它自己的密文,换个服务商毫无意义)。
          */
          if (replay !== undefined) {
            flush()
            input.push(!reasoningCarriesText(replay) && part.text !== ''
              ? { ...replay, content: [{ type: 'reasoning_text', text: part.text }] }
              : replay)
          } else if (part.text !== '') {
            flush()
            input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: part.text }] })
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

/**
 * 回传物里还有没有**上游读得动的**推理正文。
 *
 * 需求:没有的话,调用方必须用转录里的 `part.text` 补 `content`,否则思考模式的
 * 上游会以「reasoning_text 必须回传」400 拒掉整轮(见 `case 'thinking'` 那段注释)。
 *
 * ★ 判成「有」的三种载体各有各的读者:`content` 是纯文本、`summary` 和
 * `encrypted_content` 只对签发它们的那家有意义 —— 但共同点是**回传物里确实带着
 * 上游给过的推理信息**,原样发出去就是零改动路径。补 content 的判断只需要回答
 * 「这条 item 是不是空的」,不需要分辨对面是谁:编码器看不到供应商,那是 router
 * 那一层的事实。
 */
function reasoningCarriesText(item: Record<string, unknown>): boolean {
  if (typeof item['encrypted_content'] === 'string' && item['encrypted_content'] !== '') return true
  for (const key of ['content', 'summary']) {
    const parts = item[key]
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const text = record(part)?.text
      if (typeof text === 'string' && text !== '') return true
    }
  }
  return false
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
