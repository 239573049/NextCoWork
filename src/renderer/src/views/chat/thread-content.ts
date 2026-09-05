import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly } from '../../../../shared/agent/message'
import type { LiveBlock, SubagentState } from '../../../../shared/agent/transcript'
import type { TimelineItem } from '../../../../shared/domain/tool-timeline'

export type AssistantBlock = {
  key: string
  part?: ContentPart
  liveBlock?: LiveBlock
  streaming: boolean
  cursor: boolean
}

export type ThreadRow =
  | { kind: 'user'; key: string; message: AgentMessage }
  | { kind: 'assistant'; key: string; blocks: AssistantBlock[]; startedAt?: number; endedAt?: number }

/** Tool receipts are invisible boundaries; consecutive model replies form one assistant turn. */
export function threadRows(messages: readonly AgentMessage[], live: readonly LiveBlock[], running: boolean): ThreadRow[] {
  const rows: ThreadRow[] = []
  let preceding = 'start'
  let precedingAt: number | undefined
  const assistant = (): Extract<ThreadRow, { kind: 'assistant' }> => {
    const last = rows.at(-1)
    if (last?.kind === 'assistant') return last
    const row: Extract<ThreadRow, { kind: 'assistant' }> = {
      kind: 'assistant', key: `reply:${preceding}`, blocks: [],
      ...(precedingAt === undefined ? {} : { startedAt: precedingAt })
    }
    rows.push(row)
    return row
  }

  for (const message of messages) {
    if (isToolResultOnly(message)) continue
    if (message.role === 'user') {
      rows.push({ kind: 'user', key: message.id, message })
    } else {
      const row = assistant()
      message.parts.forEach((part, index) => {
        // The first assistant message follows the visible user message, so its
        // keys match the live reply. Later assistant messages in the same turn
        // use their own ids to avoid collisions across hidden tool receipts.
        const keyPrefix = row.blocks.length === 0 ? preceding : message.id
        row.blocks.push({ key: `${keyPrefix}:${index}`, part, streaming: false, cursor: false })
      })
      row.endedAt = message.createdAt
    }
    preceding = message.id
    precedingAt = message.createdAt
  }

  if (live.length > 0 || rows.at(-1)?.kind !== 'assistant') {
    const row = assistant()
    live.forEach((liveBlock, index) => {
      // The preceding visible message is known before this reply's committed ID.
      // Matching keys retain Markdown controls and tool-group choices on commit.
      // A later block means the earlier one has finished; only the tail can still grow.
      const streaming = running && index === live.length - 1
      row.blocks.push({ key: `${preceding}:${index}`, liveBlock, streaming,
        cursor: running && index === live.length - 1 && liveBlock.kind === 'text' })
    })
  }
  return rows
}

export type AssistantSegment =
  | { kind: 'block'; key: string; block: AssistantBlock }
  | { kind: 'process'; key: string; items: TimelineItem[] }

/** A visible assistant text block that can safely remain outside a process summary. */
export function isAssistantTextBlock(block: AssistantBlock): boolean {
  if (block.part?.type === 'text') return block.part.text.trim() !== ''
  return block.liveBlock?.kind === 'text' && block.liveBlock.text.trim() !== ''
}

/** Keep prose, images and errors in place; only adjacent process blocks share a timeline. */
export function assistantSegments(
  blocks: readonly AssistantBlock[],
  fallbackToolName: string,
  subagents: Readonly<Record<string, SubagentState>> = {}
): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const block of blocks) {
    const { part, liveBlock, key } = block
    let item: TimelineItem | undefined
    if (part?.type === 'tool_result') continue
    if (part?.type === 'text' && part.text.trim() === '') continue
    if (part?.type === 'thinking') {
      if (part.text.trim() === '') continue
      item = { key, kind: 'thinking', text: part.text, streaming: false }
    } else if (part?.type === 'tool_call') {
      if (part.name.toLowerCase() === 'task' && subagents[part.callId] !== undefined) {
        item = { key: part.callId, kind: 'subagent', callId: part.callId,
          summary: part.input && typeof part.input === 'object' && typeof (part.input as Record<string, unknown>).description === 'string'
            ? (part.input as Record<string, unknown>).description as string : undefined,
          state: subagents[part.callId] }
      } else {
        item = { key: part.callId, kind: 'tool', callId: part.callId, name: part.name, input: part.input }
      }
    } else if (part?.type === 'subagent') {
      item = { key: part.callId, kind: 'subagent', callId: part.callId, summary: part.summary, state: subagents[part.callId] }
    } else if (liveBlock?.kind === 'thinking') {
      if (!block.streaming && liveBlock.text.trim() === '') continue
      item = { key, kind: 'thinking', text: liveBlock.text, streaming: block.streaming }
    } else if (liveBlock?.kind === 'tool_use') {
      const liveCallId = liveBlock.callId
      if (liveBlock.name?.toLowerCase() === 'task' && liveCallId !== undefined && subagents[liveCallId] !== undefined) {
        item = { key: liveCallId, kind: 'subagent', callId: liveCallId,
          summary: subagents[liveCallId]?.description, state: subagents[liveCallId] }
      } else {
        item = { key: liveCallId ?? key, kind: 'tool', callId: liveCallId,
          name: liveBlock.name ?? fallbackToolName, input: liveBlock.text }
      }
    } else if (liveBlock?.kind === 'text' && liveBlock.text.trim() === '') {
      continue
    }

    if (item === undefined) {
      segments.push({ kind: 'block', key, block })
    } else {
      const last = segments.at(-1)
      if (last?.kind === 'process') last.items.push(item)
      else segments.push({ kind: 'process', key: `process:${item.key}`, items: [item] })
    }
  }
  return segments
}
