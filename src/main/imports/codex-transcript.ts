import { createHash } from 'node:crypto'
import type { ContentPart } from '../../shared/agent/message'
import { truncateToolOutput } from '../../shared/agent/message'
import type { ImportDiagnostic } from '../../shared/domain/import'
import type { ImportedMessage, ParsedTranscript } from './transcript'

export const CODEX_TRANSFORMER_VERSION = 1

export interface CodexParsedTranscript extends ParsedTranscript {
  modelProvider?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string' ? part : str(object(part)['text']) ?? '').filter(Boolean).join('\n')
}

function hostContent(text: string): boolean {
  return /^\s*(?:# AGENTS\.md instructions\b|<(?:permissions instructions|app-context|environment_context|skills_instructions|INSTRUCTIONS|user_instructions)>)/i.test(text)
}

function partsOf(payload: Record<string, unknown>, role: 'user' | 'assistant', diagnostics: ImportDiagnostic[]): ContentPart[] {
  const content = payload['content']
  const rows = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [payload]
  const parts: ContentPart[] = []
  for (const item of rows) {
    const row = object(item)
    const type = str(row['type']) ?? ''
    if (['input_text', 'output_text', 'text'].includes(type)) {
      const text = textOf(row['text'] ?? row['content'])
      if (role === 'user' && hostContent(text)) diagnostics.push({ code: 'transcript.developer-content-skipped' })
      else if (text) parts.push({ type: 'text', text })
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = str(row['call_id']) ?? str(row['id']) ?? ''
      const name = str(row['name']) ?? type
      let input: unknown = row['arguments'] ?? row['input'] ?? {}
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* keep plain text */ } }
      if (callId && role === 'assistant') parts.push({ type: 'tool_call', callId, name, input })
      else { parts.push({ type: 'text', text: `${name}: ${JSON.stringify(input)}` }); diagnostics.push({ code: 'tool.unencodable', detail: type }) }
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = str(row['call_id']) ?? ''
      const text = textOf(row['output'] ?? row['content'])
      if (callId && role === 'user') parts.push({ type: 'tool_result', callId, output: truncateToolOutput(text), isError: row['is_error'] === true })
      else { parts.push({ type: 'text', text: `${type}: ${text}` }); diagnostics.push({ code: 'tool.unencodable', detail: type }) }
    } else if (type === 'reasoning') {
      const summary = textOf(row['summary'])
      if (summary) parts.push({ type: 'text', text: summary })
    } else if (type) {
      parts.push({ type: 'text', text: `[${type}]` })
      diagnostics.push({ code: 'tool.unencodable', detail: type })
    }
  }
  return parts
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined }
  return undefined
}

/** Pure, tolerant rollout transformer. It never executes or resolves a recorded tool. */
export function parseCodexTranscript(lines: readonly string[], options: { fallbackSessionId: string; maxMessages: number }): CodexParsedTranscript {
  const diagnostics: ImportDiagnostic[] = []
  const messages: ImportedMessage[] = []
  const occurrences = new Map<string, number>()
  let sessionId = options.fallbackSessionId
  let cwd = ''
  let model: string | undefined
  let modelProvider: string | undefined
  let title: string | undefined
  let startedAt: number | undefined
  let updatedAt: number | undefined
  let unknown = 0

  for (let index = 0; index < lines.length; index += 1) {
    if (!(lines[index] ?? '').trim()) continue
    let raw: unknown
    try { raw = JSON.parse(lines[index] as string) } catch { diagnostics.push({ code: 'transcript.truncated-tail', detail: String(index + 1) }); continue }
    const row = object(raw)
    const type = str(row['type']) ?? ''
    const payload = row['payload'] === undefined ? row : object(row['payload'])
    if (type === 'session_meta') {
      sessionId = str(payload['id']) ?? str(payload['session_id']) ?? sessionId
      cwd = str(payload['cwd']) ?? cwd
      model = str(payload['model']) ?? model
      modelProvider = str(payload['model_provider']) ?? modelProvider
      title = str(payload['thread_name']) ?? str(payload['title']) ?? title
      startedAt = timestamp(payload['timestamp'] ?? row['timestamp']) ?? startedAt
      continue
    }
    if (type === 'turn_context') { model = str(payload['model']) ?? model; continue }
    if (['developer', 'world_state', 'compacted'].includes(type) || ['developer', 'system'].includes(String(payload['role']))) {
      diagnostics.push({ code: 'transcript.developer-content-skipped', detail: type || String(payload['role']) })
      continue
    }
    if (type === 'event_msg') continue
    const payloadType = str(payload['type']) ?? type
    const role = payload['role'] ?? (['function_call_output', 'custom_tool_call_output'].includes(payloadType) ? 'user' : ['function_call', 'custom_tool_call', 'reasoning', 'web_search_call', 'tool_search_call', 'image_generation_call'].includes(payloadType) ? 'assistant' : undefined)
    if (role !== 'user' && role !== 'assistant') { unknown += 1; continue }
    const parts = partsOf(payload, role, diagnostics)
    if (parts.length === 0) continue
    if (messages.length >= options.maxMessages) { diagnostics.push({ code: 'transcript.oversize' }); break }
    const stable = str(payload['id']) ?? str(row['id']) ?? createHash('sha256').update(JSON.stringify([role, parts])).digest('hex')
    const occurrence = occurrences.get(stable) ?? 0
    occurrences.set(stable, occurrence + 1)
    const at = timestamp(row['timestamp'] ?? payload['timestamp']) ?? startedAt ?? 0
    startedAt ??= at
    updatedAt = Math.max(updatedAt ?? at, at)
    messages.push({ sourceId: `${stable}:${occurrence}`, role, parts, createdAt: at, images: [] })
    if (!title && role === 'user') title = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim().split(/\r?\n/, 1)[0]
  }

  const pending = new Map<string, ContentPart>()
  const paired = new Set<ContentPart>()
  for (const message of messages) for (const part of message.parts) {
    if (part.type === 'tool_call') pending.set(part.callId, part)
    if (part.type === 'tool_result') {
      const call = pending.get(part.callId)
      if (call) { paired.add(call); paired.add(part); pending.delete(part.callId) }
    }
  }
  let incomplete = false
  for (const message of messages) message.parts = message.parts.map((part) => {
    if ((part.type !== 'tool_call' && part.type !== 'tool_result') || paired.has(part)) return part
    incomplete = true
    return { type: 'text', text: part.type === 'tool_call' ? `${part.name} (${part.callId}): ${JSON.stringify(part.input)}` : `${part.callId}: ${JSON.stringify(part.output)}` }
  })
  if (incomplete) diagnostics.push({ code: 'transcript.tool-pair-incomplete' })
  if (unknown) diagnostics.push({ code: 'transcript.schema-unknown', detail: String(unknown) })
  return { sessionId, cwd, ...(title ? { title } : {}), ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), messages, diagnostics }
}
