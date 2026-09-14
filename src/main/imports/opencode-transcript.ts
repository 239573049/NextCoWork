import type { ContentPart } from '../../shared/agent/message'
import { truncateToolOutput } from '../../shared/agent/message'
import type { ImportDiagnostic } from '../../shared/domain/import'
import type { ImportedMessage, ParsedTranscript } from './transcript'
import type { OpencodeRawSession } from './opencode'

/**
 * OpenCode 会话(session/message/part 三张表)→ 本应用的规范化转录。
 *
 * ## 为什么是纯函数
 *
 * 和 `transcript.ts` / `codex-transcript.ts` 一样,它不碰 SQLite、不 mint id。
 * 入参是已经从 DB 读出并 `JSON.parse` 过的行,出参是规范化消息 + 诊断 ——
 * 这样才能用几十行夹具在 vitest 里跑完,而不是先起一个真库。
 *
 * ## tool 怎么拆
 *
 * OpenCode 把一次工具调用的输入和输出塞在**同一条 assistant part** 里
 * (`{type:"tool", tool, callID, state:{input, output, status}}`)。而本应用
 * (同 Anthropic)要求 `tool_result` 出现在紧随的 **user** 消息里。所以一条
 * tool part 拆成两半:`tool_call` 留在 assistant 消息,`tool_result` 放进一条
 * 紧随其后的合成 user 消息。随后复用与 codex 相同的配对修复,落单的降级成正文。
 *
 * ## 不做的事
 *
 * - `step-start` / `step-finish` 是 OpenCode 的回合分隔标记,不是对话内容,丢弃。
 * - 不为落单的 `tool_call` 编一个成功结果 —— 那会在界面上变成一张
 *   「执行成功」的工具卡,而那次执行从没发生过。
 */
export const OPENCODE_TRANSFORMER_VERSION = 1

export interface OpencodeParsedTranscript extends ParsedTranscript {
  modelProvider?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  const row = object(value)
  return str(row['text']) ?? str(row['output']) ?? (value === undefined ? '' : JSON.stringify(value))
}

export function parseOpencodeSession(raw: OpencodeRawSession, options: { maxMessages: number }): OpencodeParsedTranscript {
  const diagnostics: ImportDiagnostic[] = []
  const { session } = raw
  const byMessage = new Map<string, typeof raw.parts>()
  for (const part of raw.parts) {
    const bucket = byMessage.get(part.messageId)
    if (bucket) bucket.push(part)
    else byMessage.set(part.messageId, [part])
  }

  const messages: ImportedMessage[] = []
  const occurrences = new Map<string, number>()
  let title = session.title || undefined
  let model = session.model?.modelID
  let modelProvider = session.model?.providerID
  let startedAt: number | undefined = session.createdAt || undefined
  let updatedAt: number | undefined = session.updatedAt || undefined
  let truncated = false

  const nextKey = (base: string): string => {
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    return `${base}:${occurrence}`
  }

  for (const message of raw.messages) {
    const role = str(message.data['role'])
    if (role !== 'user' && role !== 'assistant') continue
    model = str(message.data['modelID']) ?? model
    modelProvider = str(message.data['providerID']) ?? modelProvider

    const parts = (byMessage.get(message.id) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
    const mainParts: ContentPart[] = []
    const resultParts: ContentPart[] = []
    for (const part of parts) {
      const data = part.data
      const type = str(data['type'])
      if (type === 'text') {
        const text = str(data['text']) ?? ''
        if (text) mainParts.push({ type: 'text', text })
      } else if (type === 'reasoning') {
        const text = str(data['text']) ?? ''
        if (text) mainParts.push({ type: 'text', text })
      } else if (type === 'tool') {
        const callId = str(data['callID']) ?? str(data['id']) ?? ''
        const name = str(data['tool']) ?? 'tool'
        const state = object(data['state'])
        if (callId && role === 'assistant') {
          mainParts.push({ type: 'tool_call', callId, name, input: state['input'] ?? {} })
          resultParts.push({ type: 'tool_result', callId, output: truncateToolOutput(outputText(state['output'])), isError: state['status'] === 'error' })
        } else {
          mainParts.push({ type: 'text', text: `${name}: ${JSON.stringify(state['input'] ?? {})}` })
          diagnostics.push({ code: 'tool.unencodable', detail: type })
        }
      } else if (type === 'step-start' || type === 'step-finish') {
        continue
      } else if (type) {
        mainParts.push({ type: 'text', text: `[${type}]` })
        diagnostics.push({ code: 'tool.unencodable', detail: type })
      }
    }

    if (mainParts.length === 0 && resultParts.length === 0) continue
    if (messages.length >= options.maxMessages) {
      truncated = true
      break
    }
    const at = message.createdAt || startedAt || 0
    startedAt = Math.min(startedAt ?? at, at)
    updatedAt = Math.max(updatedAt ?? at, at)
    if (mainParts.length > 0) {
      messages.push({ sourceId: nextKey(message.id), role, parts: mainParts, createdAt: at, images: [] })
      if (!title && role === 'user') title = mainParts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim().split(/\r?\n/, 1)[0]
    }
    if (resultParts.length > 0 && messages.length < options.maxMessages) {
      messages.push({ sourceId: nextKey(`${message.id}:result`), role: 'user', parts: resultParts, createdAt: at, images: [] })
    }
  }
  if (truncated) diagnostics.push({ code: 'transcript.oversize' })

  // 配对修复:落单的 tool_call / tool_result 降级成可读正文。
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
    cwd: session.directory,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
    diagnostics
  }
}
