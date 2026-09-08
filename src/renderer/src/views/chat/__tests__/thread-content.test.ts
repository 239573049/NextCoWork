import { describe, expect, it } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../../shared/agent/message'
import { assistantSegments, assistantText, isAssistantTextBlock, threadRows } from '../thread-content'

describe('thread content grouping', () => {
  it('joins consecutive assistant tool messages across hidden tool receipts', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'tool_call', callId: 'bash', name: 'Bash', input: {} }], 4),
      toolResultMessage('r2', [{ type: 'tool_result', callId: 'bash', output: { content: 'ok' }, isError: false }], 5),
      assistantMessage('a3', [{ type: 'text', text: 'Done' }], 6)
    ]
    const rows = threadRows(messages, [], false)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant'])
    expect(rows[1]?.kind === 'assistant' ? rows[1].blocks.length : 0).toBe(3)
  })

  it('tags a merged assistant turn with the run that produced it', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)
    ]
    // The whole turn belongs to one run, so either committed message can carry it.
    const rows = threadRows(messages, [], false, { a1: 'run-1', a2: 'run-1' })
    expect(rows[1]?.kind === 'assistant' ? rows[1].runId : undefined).toBe('run-1')
  })

  it('carries a run recorded only on the tail of a partially migrated turn', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)
    ]
    expect(threadRows(messages, [], false, { a2: 'run-1' })[1])
      .toMatchObject({ kind: 'assistant', runId: 'run-1' })
  })

  it('leaves a turn from before the migration without a run', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 2)
    ]
    // Undefined means "unknown", which renders no usage at all — a placeholder
    // run id would instead render a confident, wrong zero.
    const rows = threadRows(messages, [], false)
    expect(rows[1]?.kind === 'assistant' ? rows[1].runId : 'set').toBeUndefined()
  })

  it('keeps the live reply keys aligned with the eventual committed parts', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const live = threadRows([user], [{ index: 0, kind: 'text', text: 'Working' }], true)
    const committed = threadRows([user, assistantMessage('a', [{ type: 'text', text: 'Working' }], 2)], [], false)
    const liveBlock = live[1]?.kind === 'assistant' ? live[1].blocks[0] : undefined
    const committedBlock = committed[1]?.kind === 'assistant' ? committed[1].blocks[0] : undefined
    expect(liveBlock?.key).toBe(committedBlock?.key)
  })

  it('marks thinking as finished once a later text block starts streaming', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const rows = threadRows([user], [
      { index: 0, kind: 'thinking', text: 'Reasoning' },
      { index: 1, kind: 'text', text: 'Inspecting repository...' }
    ], true)
    const row = rows[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return

    expect(row.blocks[0]?.streaming).toBe(false)
    expect(row.blocks[1]?.streaming).toBe(true)
    expect(assistantSegments(row.blocks, 'tool')[0]).toMatchObject({
      kind: 'process',
      items: [{ kind: 'thinking', streaming: false }]
    })
  })

  it('keeps a user-to-answer time range for historical duration fallback', () => {
    const rows = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1_000),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 4_500)
    ], [], false)
    const answer = rows[1]
    expect(answer?.kind).toBe('assistant')
    if (answer?.kind !== 'assistant') return
    expect(answer.startedAt).toBe(1_000)
    expect(answer.endedAt).toBe(4_500)
  })

  it('does not render tool receipts as user content and preserves prose order', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const blocks = threadRows([user, assistantMessage('a', [
      { type: 'tool_call', callId: 'read', name: 'Read', input: {} },
      { type: 'text', text: 'Done' }
    ], 2)], [], false)[1]
    expect(blocks?.kind).toBe('assistant')
    if (blocks?.kind !== 'assistant') return
    const segments = assistantSegments(blocks.blocks, 'tool')
    expect(segments.map((segment) => segment.kind)).toEqual(['process', 'block'])
  })

  it('recognizes the final non-empty assistant text block', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(isAssistantTextBlock(row.blocks[0]!)).toBe(true)
  })

  it('does not treat a thinking block as the final answer', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'thinking', text: 'Working' }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(isAssistantTextBlock(row.blocks[0]!)).toBe(false)
  })
})

describe('assistant turn plain text', () => {
  it('copies prose only, leaving thinking and tool calls out', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [
        { type: 'thinking', text: 'Let me look around first' },
        { type: 'text', text: 'Checked the config.' },
        { type: 'tool_call', callId: 'read', name: 'Read', input: {} }
      ], 2),
      toolResultMessage('r', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'It is fine.' }], 4)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('Checked the config.\n\nIt is fine.')
  })

  it('reads a still-streaming reply', () => {
    const row = threadRows([userMessage('u', [{ type: 'text', text: 'Hi' }], 1)],
      [{ index: 0, kind: 'text', text: 'Half a sen' }], true)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('Half a sen')
  })

  it('is empty for a turn that only ran tools', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Run it' }], 1),
      assistantMessage('a', [{ type: 'tool_call', callId: 'bash', name: 'Bash', input: {} }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('')
  })
})
