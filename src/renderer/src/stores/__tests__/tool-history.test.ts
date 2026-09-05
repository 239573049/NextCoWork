import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../shared/agent/message'
import type { AgentMessage } from '../../../../shared/agent/message'
import type { SessionDetail } from '../../../../shared/domain/session'
import type { RunSnapshot } from '../../../../shared/agent/event'

vi.mock('../../services/agent', () => ({
  startRun: vi.fn(), attachRun: vi.fn(), abortRun: vi.fn(), onAgentEvent: vi.fn(() => () => {})
}))
vi.mock('../../services/app', () => ({ getSessionInput: vi.fn(async () => null), persistSessionInput: vi.fn() }))
vi.mock('../../services/sessions', () => ({ getSession: vi.fn() }))

import { attachRun } from '../../services/agent'
import { getSession } from '../../services/sessions'
import { adoptActiveRuns, refreshHydratedSessions, releaseSession, sessionStore } from '../session'

const reference = { runId: 'history-run', sessionId: 'tool-history-session', workspaceId: 'workspace' }
const history: AgentMessage[] = [
  userMessage('question', [{ type: 'text', text: 'Inspect the project' }], 1),
  assistantMessage('calls', [
    { type: 'tool_call', callId: 'read', name: 'Read', input: { file_path: '/workspace/Program.cs' } },
    { type: 'tool_call', callId: 'list', name: 'LS', input: { path: '/workspace' } }
  ], 2),
  toolResultMessage('results', [
    { type: 'tool_result', callId: 'read', output: { content: 'var app = builder.Build();' }, isError: false },
    { type: 'tool_result', callId: 'list', output: { content: 'Not allowed' }, isError: true }
  ], 3),
  assistantMessage('answer', [{ type: 'text', text: 'Project inspected.' }], 4)
]

function detail(messages = history): SessionDetail {
  return { session: { id: reference.sessionId, workspaceId: reference.workspaceId, title: 'Project architecture', model: 'model',
    mode: 'normal', thinking: 'off', rootPathAtCreation: '/workspace', status: 'idle', archived: false, favorited: false, createdAt: 1, updatedAt: 4 }, messages }
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getSession).mockResolvedValue(detail()) })
afterEach(() => {
  sessionStore(reference.sessionId).getState().applyEvents([{ type: 'run_end', status: 'aborted' }])
  releaseSession(reference.sessionId)
})

function checkResults(): void {
  const tools = sessionStore(reference.sessionId).getState().transcript.tools
  expect(tools['read']).toMatchObject({ name: 'Read', status: 'ok', output: { content: 'var app = builder.Build();' } })
  expect(tools['list']).toMatchObject({ name: 'LS', status: 'error', output: { content: 'Not allowed' } })
}

describe('tool results after history refresh', () => {
  it('restores results on first load and after closing/reopening a completed session', async () => {
    sessionStore(reference.sessionId)
    await vi.waitFor(checkResults)
    expect(releaseSession(reference.sessionId)).toBe(true)
    sessionStore(reference.sessionId)
    await vi.waitFor(checkResults)
  })

  it('a session-change refresh keeps completed outputs, timing and clears old progress', async () => {
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(checkResults)
    store.getState().applyEvents([
      { type: 'tool_start', callId: 'read', toolName: 'Read', input: { file_path: '/workspace/Program.cs' }, at: 10 },
      { type: 'tool_end', callId: 'read', output: { content: 'var app = builder.Build();' }, isError: false, at: 20 },
      { type: 'run_end', status: 'done' }
    ])
    await refreshHydratedSessions()
    checkResults()
    expect(store.getState().transcript.tools['read']).toMatchObject({ startedAt: 10, endedAt: 20 })
  })

  it('history replacement clears removed tool results instead of reusing cached data', async () => {
    sessionStore(reference.sessionId)
    await vi.waitFor(checkResults)
    vi.mocked(getSession).mockResolvedValue(detail([]))
    await refreshHydratedSessions()
    expect(sessionStore(reference.sessionId).getState().transcript.tools).toEqual({})
  })

  it('a refresh response cannot overwrite a newer active run', async () => {
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(checkResults)
    let resolve!: (detail: SessionDetail) => void
    vi.mocked(getSession).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const refresh = refreshHydratedSessions()
    store.setState({ activeRunId: reference.runId })
    store.getState().applyEvents([{ type: 'tool_start', callId: 'current', toolName: 'LS', input: {}, at: 50 }])
    resolve(detail([]))
    await refresh
    checkResults()
    expect(store.getState().transcript.tools['current']?.status).toBe('running')
  })

  it('reattaching to a new run also restores tool results from earlier turns', async () => {
    vi.mocked(attachRun).mockResolvedValue({ ...reference, depth: 0, seq: 2, status: 'running', children: [], pendingInteractions: [], events: [
      { type: 'tool_start', callId: 'current', toolName: 'LS', input: { path: '/next' }, at: 50 }
    ] } satisfies RunSnapshot)
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(2))
    checkResults()
    expect(store.getState().transcript.tools['current']).toMatchObject({ name: 'LS', status: 'running', startedAt: 50 })
  })
})
