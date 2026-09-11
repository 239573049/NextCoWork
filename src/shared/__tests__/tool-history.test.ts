import { describe, expect, it } from 'vitest'
import { assistantMessage, toolResultMessage } from '../agent/message'
import { applyEvent, applyEvents, emptyTranscript, subagentsFromMessages, toolsFromMessages } from '../agent/transcript'

const calls = assistantMessage('calls', [
  { type: 'tool_call', callId: 'list', name: 'LS', input: { path: '/workspace' } },
  { type: 'tool_call', callId: 'read', name: 'Read', input: { file_path: '/workspace/Program.cs' } }
], 100)
const results = toolResultMessage('results', [
  { type: 'tool_result', callId: 'list', output: { content: 'Program.cs\nsrc/' }, isError: false },
  { type: 'tool_result', callId: 'read', output: { content: 'Permission denied', truncated: true, originalBytes: 100_000 }, isError: true }
], 200)

describe('tool state from durable history', () => {
  it('restores names, arguments, success/error and full result metadata without inventing timing', () => {
    const tools = toolsFromMessages([calls, results])
    expect(tools['list']).toMatchObject({ name: 'LS', input: { path: '/workspace' }, status: 'ok', output: { content: 'Program.cs\nsrc/' } })
    expect(tools['read']).toMatchObject({ name: 'Read', input: { file_path: '/workspace/Program.cs' }, status: 'error',
      output: { content: 'Permission denied', truncated: true, originalBytes: 100_000 } })
    expect(tools['list']?.startedAt).toBeUndefined()
    expect(tools['list']?.endedAt).toBeUndefined()
  })

  it('a persisted call is pending until a result or actual execution event arrives', () => {
    expect(toolsFromMessages([calls])['list']?.status).toBe('pending')
    const running = { callId: 'list', name: 'LS', input: { path: '/workspace' }, status: 'running' as const, startedAt: 110, progress: 'Scanning' }
    const tools = toolsFromMessages([calls], { list: running })
    expect(tools['list']).toEqual(running)
    expect(tools['list']?.output).toBeUndefined()
  })

  it('committed tool results restore state even when tool_start/tool_end events were not replayed', () => {
    const transcript = applyEvents(emptyTranscript(), [
      { type: 'message_commit', message: calls }, { type: 'message_commit', message: results },
      { type: 'run_end', status: 'done' }
    ])
    expect(transcript.tools['list']?.status).toBe('ok')
    expect(transcript.tools['read']?.output?.content).toBe('Permission denied')
  })

  it('retains real elapsed time and approved arguments while clearing obsolete progress', () => {
    const live = applyEvents(emptyTranscript(), [
      { type: 'tool_start', callId: 'list', toolName: 'LS', input: { path: '/approved' }, at: 110 },
      { type: 'tool_progress', callId: 'list', progress: { callId: 'list', message: 'Scanning' } },
      { type: 'tool_end', callId: 'list', output: { content: 'Program.cs\nsrc/' }, isError: false, at: 140 }
    ]).tools
    const tools = toolsFromMessages([calls, results], live)
    expect(tools['list']).toMatchObject({ status: 'ok', input: { path: '/approved' }, startedAt: 110, endedAt: 140 })
    expect(tools['list']?.progress).toBeUndefined()
    expect(live['list']?.input).toEqual({ path: '/approved' })
  })

  it('a saved result settles a stale running state', () => {
    const live = applyEvent(emptyTranscript(), { type: 'tool_start', callId: 'read', toolName: 'Read', input: {}, at: 110 }).tools
    expect(toolsFromMessages([calls, results], live)['read']).toMatchObject({ status: 'error', output: { content: 'Permission denied' } })
  })

  it('retains tool identity from live events when the saved snapshot only contains the result', () => {
    const live = applyEvent(emptyTranscript(), { type: 'tool_start', callId: 'read', toolName: 'Read', input: { file_path: '/approved.cs' }, at: 110 }).tools
    expect(toolsFromMessages([results], live)['read']).toMatchObject({ name: 'Read', status: 'error', input: { file_path: '/approved.cs' } })
  })

  it('history replacement drops removed calls and never retains their outputs', () => {
    const previous = toolsFromMessages([calls, results])
    expect(toolsFromMessages([], previous)).toEqual({})
    const replacement = assistantMessage('new', [{ type: 'text', text: 'New history' }], 300)
    expect(toolsFromMessages([replacement], previous)).toEqual({})
  })

  it('preserves a result with empty content and pairs a result seen before its call metadata', () => {
    const output = toolResultMessage('empty', [{ type: 'tool_result', callId: 'list', output: { content: '' }, isError: false }], 200)
    expect(toolsFromMessages([output, calls])['list']).toMatchObject({ name: 'LS', input: { path: '/workspace' }, status: 'ok', output: { content: '' } })
  })

  it('keeps event snapshots and live inputs immutable while matching the event reducer', () => {
    const previous = applyEvent(emptyTranscript(), { type: 'message_commit', message: calls })
    Object.freeze(previous.tools)
    for (const tool of Object.values(previous.tools)) Object.freeze(tool)
    const snapshot = structuredClone(previous.tools)
    const next = applyEvent(previous, { type: 'message_commit', message: results })
    expect(next.tools).toEqual(toolsFromMessages([calls, results]))
    expect(next.tools).not.toBe(previous.tools)
    expect(previous.tools).toEqual(snapshot)
    expect(toolsFromMessages([calls, results], previous.tools)).toEqual(next.tools)
    expect(previous.tools).toEqual(snapshot)
  })

  it('rebuilds a large interleaved history without losing any calls or results', () => {
    const messages = Array.from({ length: 5000 }, (_, index) => {
      const callId = `call-${index}`
      return [
        assistantMessage(`request-${index}`, [{ type: 'tool_call', callId, name: 'Read', input: { index } }], index * 2),
        toolResultMessage(`result-${index}`, [{ type: 'tool_result', callId, output: { content: `result ${index}` }, isError: index % 2 === 0 }], index * 2 + 1)
      ]
    }).flat()
    const tools = toolsFromMessages(messages)
    expect(Object.keys(tools)).toHaveLength(5000)
    expect(tools['call-0']).toMatchObject({ status: 'error', output: { content: 'result 0' } })
    expect(tools['call-4999']).toMatchObject({ status: 'ok', input: { index: 4999 }, output: { content: 'result 4999' } })
  })

  it('rebuilds child cards without downgrading terminal results or mutating event snapshots', () => {
    const finished = toolResultMessage('finished', [{ type: 'tool_result', callId: 'task', output: { content: 'done' }, isError: false,
      subagent: { childRunId: 'child', status: 'done', summary: 'Finished' } }], 1)
    const background = toolResultMessage('background', [{ type: 'tool_result', callId: 'task', output: { content: 'started' }, isError: false,
      subagent: { childRunId: 'child', status: 'running', background: true } }], 2)
    const before = applyEvent(emptyTranscript(), { type: 'message_commit', message: finished })
    Object.freeze(before.subagents)
    Object.freeze(before.subagents['task'])
    const snapshot = structuredClone(before.subagents)
    const next = applyEvent(before, { type: 'message_commit', message: background })
    const rebuilt = subagentsFromMessages([finished, background])
    expect(rebuilt).toEqual(next.subagents)
    expect(rebuilt['task']).toMatchObject({ status: 'done', summary: 'Finished', background: true })
    expect(before.subagents).toEqual(snapshot)
    const live = { ...snapshot, detached: { ...snapshot['task']!, callId: 'detached', childRunId: 'detached-run', status: 'running' as const } }
    expect(subagentsFromMessages([finished], live)['detached']).toBe(live.detached)
  })
})
