/**
 * OpenCoWork 会话(sessions/messages 两表)→ 本应用的规范化转录。
 *
 * ## 为什么比 opencode-transcript.ts 简单
 *
 * OpenCoWork 的消息内容已经是 Anthropic 式内容块数组(`text`/`thinking`/
 * `tool_use`/`tool_result`/`image`/...),`tool_use` 天然落在 assistant 消息、
 * `tool_result` 天然落在随后的 user 消息 —— 和本应用的块模型是同构的,不需要
 * 像 OpenCode 那样把「一条 part 里塞了调用+结果」拆成两条消息再重新配对。
 *
 * 保留的仍然是同一套「落单的 tool_call/tool_result 降级成可读正文」的兜底
 * (毕竟单条会话仍可能被截断导出、或用户手删了中间一条消息)。
 *
 * ## 不做的事
 *
 * - `image_error` / `agent_error` / `web_search` 三种块类型本应用没有一一
 *   对应的 ContentPart,降级成一行说明文字 + `tool.unencodable`。
 * - `system` 角色的消息(系统提示/内部占位)直接跳过,标
 *   `transcript.developer-content-skipped`,不当作一条对话轮次。
 * - 不联网下载图片:`image` 块只有 base64 内联时才落地,`url` 来源只记
 *   `attachment.external-url`。
 */
import type { ContentPart } from '../../shared/agent/message'
import { truncateToolOutput } from '../../shared/agent/message'
import type { ImportDiagnostic } from '../../shared/domain/import'
import type { ImportedMessage, ParsedTranscript, PendingImage } from './transcript'
import type { OpencoworkRawSession } from './opencowork'

export const OPENCOWORK_TRANSFORMER_VERSION = 1

export interface OpencoworkParsedTranscript extends ParsedTranscript {
  modelProvider?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `ToolResultBlock.content`: `string | Array<TextBlock|ImageBlock>` → 拼成一段可读文本。 */
function toolResultText(content: unknown, diagnostics: ImportDiagnostic[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  const lines: string[] = []
  for (const raw of content) {
    const block = object(raw)
    if (block['type'] === 'text') lines.push(str(block['text']) ?? '')
    else if (block['type'] === 'image') {
      lines.push('[image]')
      diagnostics.push({ code: 'tool.unencodable', detail: 'tool_result.image' })
    }
  }
  return lines.join('\n')
}

export function parseOpencoworkSession(raw: OpencoworkRawSession, options: { maxMessages: number }): OpencoworkParsedTranscript {
  const diagnostics: ImportDiagnostic[] = []
  const { session } = raw
  const messages: ImportedMessage[] = []
  const occurrences = new Map<string, number>()
  let title: string | undefined = session.title || undefined
  let startedAt: number | undefined
  let updatedAt: number | undefined
  let truncated = false

  const nextKey = (base: string): string => {
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    return `${base}:${occurrence}`
  }

  for (const message of raw.messages) {
    if (message.role === 'system') {
      diagnostics.push({ code: 'transcript.developer-content-skipped' })
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' || message.role === 'tool' ? 'user' : undefined
    if (!role) continue

    const blocks: unknown[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : []
    if (blocks.length === 0) continue

    const parts: ContentPart[] = []
    const images: PendingImage[] = []
    for (const entry of blocks) {
      const block = object(entry)
      const type = str(block['type'])
      if (type === 'text') {
        const text = str(block['text']) ?? ''
        if (text) parts.push({ type: 'text', text })
      } else if (type === 'thinking') {
        const text = str(block['thinking']) ?? ''
        if (text) parts.push({ type: 'thinking', text })
      } else if (type === 'tool_use') {
        const callId = str(block['id']) ?? ''
        const name = str(block['name']) ?? 'tool'
        if (callId) parts.push({ type: 'tool_call', callId, name, input: block['input'] ?? {} })
        else diagnostics.push({ code: 'tool.unencodable', detail: type })
      } else if (type === 'tool_result') {
        const callId = str(block['toolUseId']) ?? ''
        if (callId) {
          parts.push({ type: 'tool_result', callId, output: truncateToolOutput(toolResultText(block['content'], diagnostics)), isError: block['isError'] === true })
        } else {
          diagnostics.push({ code: 'tool.unencodable', detail: type })
        }
      } else if (type === 'image') {
        const source = object(block['source'])
        const mime = str(source['mediaType'])
        const base64 = str(source['data'])
        if (source['type'] === 'base64' && mime && base64) {
          images.push({ partIndex: parts.length, mime, base64 })
          parts.push({ type: 'image', mime, dataRef: '' })
        } else {
          parts.push({ type: 'text', text: '[图片:源侧为外部引用,未导入]' })
          diagnostics.push({ code: 'attachment.external-url' })
        }
      } else if (type === 'image_error' || type === 'agent_error') {
        parts.push({ type: 'text', text: `[${type}] ${str(block['message']) ?? ''}` })
        diagnostics.push({ code: 'tool.unencodable', detail: type })
      } else if (type === 'web_search') {
        parts.push({ type: 'text', text: `[web_search] ${str(block['query']) ?? ''}` })
        diagnostics.push({ code: 'tool.unencodable', detail: type })
      } else if (type) {
        parts.push({ type: 'text', text: `[${type}]` })
        diagnostics.push({ code: 'tool.unencodable', detail: type })
      }
    }
    if (parts.length === 0) continue
    if (messages.length >= options.maxMessages) {
      truncated = true
      break
    }
    const at = message.createdAt || startedAt || 0
    startedAt = Math.min(startedAt ?? at, at)
    updatedAt = Math.max(updatedAt ?? at, at)
    messages.push({ sourceId: nextKey(message.id), role, parts, createdAt: at, images })
    if (!title && role === 'user') {
      title = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim().split(/\r?\n/, 1)[0]
    }
  }
  if (truncated) diagnostics.push({ code: 'transcript.oversize' })

  // 配对修复:落单的 tool_call / tool_result 降级成可读正文(与 opencode-transcript.ts 同一套)。
  const pending = new Map<string, ContentPart>()
  const paired = new Set<ContentPart>()
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type === 'tool_call') pending.set(part.callId, part)
      if (part.type === 'tool_result') {
        const call = pending.get(part.callId)
        if (call) {
          paired.add(call)
          paired.add(part)
          pending.delete(part.callId)
        }
      }
    }
  let incomplete = false
  for (const message of messages)
    message.parts = message.parts.map((part) => {
      if ((part.type !== 'tool_call' && part.type !== 'tool_result') || paired.has(part)) return part
      incomplete = true
      return { type: 'text', text: part.type === 'tool_call' ? `${part.name} (${part.callId}): ${JSON.stringify(part.input)}` : `${part.callId}: ${JSON.stringify(part.output)}` }
    })
  if (incomplete) diagnostics.push({ code: 'transcript.tool-pair-incomplete' })

  return {
    sessionId: session.id,
    cwd: session.workingFolder,
    ...(title ? { title } : {}),
    ...(session.modelId ? { model: session.modelId } : {}),
    ...(session.providerId ? { modelProvider: session.providerId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
    diagnostics
  }
}
