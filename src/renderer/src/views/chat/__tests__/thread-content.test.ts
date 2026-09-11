import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../../shared/agent/message'
import { emptyTranscript, toolsFromMessages, type TranscriptState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { Thread } from '../Thread'
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

describe('completed turn rendering', () => {
  it('retains the process subtree and user expansion when another turn starts or is removed', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const container = document.getElementById('root')!
    const root = createRoot(container)
    const messages = [
      userMessage('first-user', [{ type: 'text', text: 'Inspect' }], 1),
      ...Array.from({ length: 250 }, (_, index) => [
        assistantMessage(`step-${index}`, [
          { type: 'text', text: `Intermediate ${index}` },
          { type: 'tool_call', callId: `call-${index}`, name: 'Read', input: {} }
        ], index * 2 + 2),
        toolResultMessage(`result-${index}`, [{ type: 'tool_result', callId: `call-${index}`, output: { content: 'ok' }, isError: false }], index * 2 + 3)
      ]).flat(),
      assistantMessage('answer', [{ type: 'text', text: 'Final answer' }], 1000)
    ]
    const transcript = { ...emptyTranscript(), messages, tools: toolsFromMessages(messages), status: 'done' as const }
    const render = async (current: TranscriptState, runId: string | null = null): Promise<void> => {
      await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'en-US', children:
        createElement(Thread, { transcript: current, runId, lastSeq: 0, queued: 0, model: undefined, providerName: undefined }) })))
    }
    try {
      await render(transcript)
      const process = container.querySelector('[data-testid="run-process-block"]')!
      const answer = [...container.querySelectorAll('p')].find((element) => element.textContent === 'Final answer')
      expect(process.getAttribute('data-open')).toBe('false')
      expect(container.textContent).not.toContain('Intermediate')
      const next = { ...transcript, messages: [...messages, userMessage('next-user', [{ type: 'text', text: 'Continue' }], 1001)], status: 'running' as const }
      await render(next, 'next-run')
      expect(container.querySelector('[data-testid="run-process-block"]')).toBe(process)
      expect(container.textContent).not.toContain('Intermediate')
      expect([...container.querySelectorAll('p')].find((element) => element.textContent === 'Final answer')).toBe(answer)
      await act(async () => (process.querySelector('button') as HTMLButtonElement).click())
      const intermediate = [...container.querySelectorAll('p')].find((element) => element.textContent === 'Intermediate 0')
      expect(intermediate).toBeDefined()
      await render({ ...next, status: 'error' })
      await render(transcript)
      expect(container.querySelector('[data-testid="run-process-block"]')).toBe(process)
      expect(process.getAttribute('data-open')).toBe('true')
      expect([...container.querySelectorAll('p')].find((element) => element.textContent === 'Intermediate 0')).toBe(intermediate)
      for (const status of ['error', 'aborted'] as const) {
        const failedMessages = [
          userMessage(`${status}-user`, [{ type: 'text', text: 'Inspect' }], 1),
          ...messages.slice(1, 3),
          messages.at(-1)!
        ]
        await render({ ...transcript, messages: failedMessages, status })
        expect(container.querySelector('[data-testid="run-process-block"]')).toBeNull()
        await render({ ...transcript, messages: [
          ...failedMessages, userMessage(`${status}-retry`, [{ type: 'text', text: 'Retry' }], 1001)
        ], status: 'running' }, `${status}-retry-run`)
        expect(container.querySelector('[data-testid="run-process-block"]')).toBeNull()
        expect(container.textContent).toContain('Intermediate 0')
      }
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})
