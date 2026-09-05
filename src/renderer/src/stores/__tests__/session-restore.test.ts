import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, RunSnapshot } from '../../../../shared/agent/event'
import { assistantMessage, userMessage } from '../../../../shared/agent/message'
import { liveText } from '../../../../shared/agent/transcript'

vi.mock('../../services/agent', () => ({
  startRun: vi.fn(), attachRun: vi.fn(), abortRun: vi.fn(), onAgentEvent: vi.fn(() => () => {})
}))
vi.mock('../../services/app', () => ({
  getSessionInput: vi.fn(async () => null), persistSessionInput: vi.fn()
}))
vi.mock('../../services/sessions', () => ({ getSession: vi.fn() }))

import { attachRun } from '../../services/agent'
import { getSession } from '../../services/sessions'
import { adoptActiveRuns, adoptActiveSubagents, releaseSession, sessionStore, useRunIndex } from '../session'

const user = userMessage('old-user', [{ type: 'text', text: 'Earlier question' }], 0)
const answer = assistantMessage('old-answer', [{ type: 'text', text: 'Earlier answer' }], 1)
const reference = { runId: 'restored-run', sessionId: 'restored-session', workspaceId: 'workspace' }
const snapshot = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  ...reference, depth: 0, status: 'running', seq: 3, pendingInteractions: [], children: [],
  events: [
    { type: 'message_commit', message: answer },
    { type: 'stream', delta: { type: 'message_start', model: 'deepseek-test' } },
    { type: 'stream', delta: { type: 'text_delta', index: 0, text: 'Live reply' } }
  ], ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockResolvedValue({
    session: { id: reference.sessionId, workspaceId: reference.workspaceId, title: 'Test', model: 'deepseek-test',
      mode: 'normal', thinking: 'auto', rootPathAtCreation: '/workspace', status: 'running',
      archived: false, favorited: false, createdAt: 0, updatedAt: 1 },
    messages: [user, answer]
  })
  vi.mocked(attachRun).mockResolvedValue(snapshot())
})

afterEach(() => {
  sessionStore(reference.sessionId).getState().applyEvents([{ type: 'run_end', status: 'aborted' }])
  releaseSession(reference.sessionId)
})

describe('active conversation recovery', () => {
  const usageEvent = (outputTokens: number): AgentEvent => ({ type: 'stream', delta: {
    type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens }
  } })

  it('rebuilds usage from a full snapshot without adding already received usage again', async () => {
    let resolve!: (value: RunSnapshot) => void
    vi.mocked(attachRun).mockImplementation(() => new Promise((r) => { resolve = r }))
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(attachRun).toHaveBeenCalled())
    store.getState().applyEnvelope({ runId: reference.runId, seq: 1, events: [usageEvent(144)] })
    resolve(snapshot({ seq: 2, events: [usageEvent(144), usageEvent(256)] }))
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(2))
    expect(store.getState().transcript.usage).toEqual({ inputTokens: 200, outputTokens: 400 })
  })

  it('reattaches from the latest cursor when a usage snapshot overlaps live events', async () => {
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(3))
    let resolve!: (value: RunSnapshot) => void
    vi.mocked(attachRun).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    vi.mocked(attachRun).mockResolvedValueOnce(snapshot({ seq: 5, events: [usageEvent(256)] }))
    // seq 5 reveals a gap and starts attach(3); seq 4 arrives during that request.
    store.getState().applyEnvelope({ runId: reference.runId, seq: 5, events: [usageEvent(256)] })
    store.getState().applyEnvelope({ runId: reference.runId, seq: 4, events: [usageEvent(144)] })
    resolve(snapshot({ seq: 5, events: [usageEvent(144), usageEvent(256)] }))
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(5))
    expect(attachRun).toHaveBeenLastCalledWith(reference.runId, 4)
    expect(store.getState().transcript.usage).toEqual({ inputTokens: 200, outputTokens: 400 })
  })

  it('restores a lazily opened conversation, merges persisted history, and ignores duplicate envelopes', async () => {
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(3))
    expect(attachRun).toHaveBeenCalledWith(reference.runId, 0)
    expect(store.getState().transcript.messages).toEqual([user, answer])
    expect(liveText(store.getState().transcript)).toBe('Live reply')
    store.getState().applyEnvelope({ runId: reference.runId, seq: 3, events: [
      { type: 'stream', delta: { type: 'text_delta', index: 0, text: 'Live reply' } }
    ] })
    expect(liveText(store.getState().transcript)).toBe('Live reply')
    expect(store.getState().activeRunId).toBe(reference.runId)
  })

  it('also attaches an already-created store when bootstrap adopts its active run', async () => {
    const store = sessionStore(reference.sessionId)
    adoptActiveRuns([reference])
    await vi.waitFor(() => expect(store.getState().lastSeq).toBe(3))
    expect(store.getState().activeRunId).toBe(reference.runId)
    expect(liveText(store.getState().transcript)).toBe('Live reply')
  })

  it.each(['done', 'error', 'aborted'] as const)('clears both running indicators if the task becomes %s while reattaching', async (status) => {
    vi.mocked(attachRun).mockResolvedValue(snapshot({ status, seq: 4, events: [
      ...snapshot().events, { type: 'run_end', status }
    ] }))
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(store.getState().activeRunId).toBeNull())
    expect(store.getState().transcript.status).toBe(status)
    expect(useRunIndex.getState()).toEqual([])
  })

  it('preserves newer stream events when an older attach snapshot arrives late', async () => {
    let resolve!: (value: RunSnapshot) => void
    vi.mocked(attachRun).mockImplementation(() => new Promise((r) => { resolve = r }))
    adoptActiveRuns([reference])
    const store = sessionStore(reference.sessionId)
    await vi.waitFor(() => expect(attachRun).toHaveBeenCalled())
    store.getState().applyEnvelope({ runId: reference.runId, seq: 4, events: [
      ...snapshot().events, { type: 'stream', delta: { type: 'text_delta', index: 0, text: ' continued' } }
    ] })
    resolve(snapshot())
    await vi.waitFor(() => expect(store.getState().transcript.messages).toHaveLength(2))
    expect(store.getState().lastSeq).toBe(4)
    expect(liveText(store.getState().transcript)).toBe('Live reply continued')
  })

  it('restores a background child and its final telemetry after renderer reload', async () => {
    const parent = { runId: 'detached-parent', sessionId: 'detached-session', workspaceId: 'workspace' }
    const child = { runId: 'detached-child', parentRunId: parent.runId, sessionId: parent.sessionId, workspaceId: parent.workspaceId }
    const parentSnapshot: RunSnapshot = {
      ...parent,
      depth: 0,
      status: 'done',
      seq: 2,
      pendingInteractions: [],
      children: [child.runId],
      events: [
        {
          type: 'subagent_start',
          callId: 'task-detached',
          childRunId: child.runId,
          description: '后台查配置',
          subagentType: 'researcher',
          background: true,
          at: 10
        },
        { type: 'run_end', status: 'done', at: 20 }
      ]
    }
    const childSnapshot: RunSnapshot = {
      ...child,
      depth: 1,
      status: 'done',
      seq: 2,
      pendingInteractions: [],
      children: [],
      events: [
        { type: 'message_commit', message: assistantMessage('detached-answer', [{ type: 'text', text: '后台结果' }], 30) },
        { type: 'run_end', status: 'done', at: 30 }
      ]
    }
    vi.mocked(getSession).mockResolvedValue({
      session: { id: parent.sessionId, workspaceId: parent.workspaceId, title: 'Detached', model: 'deepseek-test',
        mode: 'normal', thinking: 'auto', rootPathAtCreation: '/workspace', status: 'idle',
        archived: false, favorited: false, createdAt: 0, updatedAt: 1 },
      messages: []
    })
    vi.mocked(attachRun).mockImplementation(async (runId) => runId === parent.runId ? parentSnapshot : childSnapshot)

    adoptActiveSubagents([child])
    const store = sessionStore(parent.sessionId)
    await vi.waitFor(() => expect(store.getState().transcript.subagents['task-detached']?.status).toBe('done'))

    expect(store.getState().transcript.subagents['task-detached']).toMatchObject({
      childRunId: child.runId,
      background: true,
      summary: '后台结果',
      startedAt: 10,
      endedAt: 30
    })
    expect(attachRun).toHaveBeenCalledWith(parent.runId, 0)
    expect(attachRun).toHaveBeenCalledWith(child.runId, 0)
    releaseSession(parent.sessionId)
  })
})
