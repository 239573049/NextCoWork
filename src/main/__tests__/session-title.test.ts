import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderStreamEvent } from '../../shared/agent/stream'
import { userMessage } from '../../shared/agent/message'
import type { ModelAlias } from '../../shared/domain/provider'
import { agentError } from '../../shared/agent/error'
import { closeDatabase } from '../db'
import type { SessionUpstream } from '../kernel/agent-session'
import { nodeHost } from '../kernel/host'
import { SessionTitleGenerator } from '../session-title'
import { EMPTY_INNER, innerTabKey, store } from '../state/store'

const message = userMessage('first-message', [{ type: 'text', text: '帮我检查登录页面的权限问题，并补上必要的修复。' }], 1)
const alias: ModelAlias = {
  alias: 'model', upstreamModel: 'deepseek-test', providerId: 'provider', contextWindow: 128_000, maxOutputTokens: 8_192,
  capabilities: { tools: true, thinking: true, vision: false, caching: false },
  thinkingConfig: { mode: 'toggle', defaultEnabled: true }
}
const end: ProviderStreamEvent = { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
const title: ProviderStreamEvent = { type: 'text_delta', index: 1, text: '“修复登录权限问题”' }
let generator: SessionTitleGenerator

beforeEach(() => closeDatabase())
afterEach(() => { generator?.clear(); vi.useRealTimers(); closeDatabase() })

function setup(options: { events?: ProviderStreamEvent[]; timeoutMs?: number; model?: ModelAlias } = {}) {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  let signal!: AbortSignal
  const stream = vi.fn<SessionUpstream['stream']>(async function* (_request, abort) {
    signal = abort
    await ready
    yield* options.events ?? [{ type: 'thinking_delta', index: 0, text: 'Hidden reasoning must not become the title' }, title, end]
  })
  const onChange = vi.fn()
  const logger = { ...nodeHost().logger, warn: vi.fn() }
  generator = new SessionTitleGenerator({
    upstream: { stream, listModels: () => [options.model ?? alias],
      resolveModel: (model) => [options.model ?? alias].find((m) => m.alias === model) },
    getSession: store.getSession,
    putSession: store.putSession, onChange, logger, ...('timeoutMs' in options ? { timeoutMs: options.timeoutMs } : {})
  })
  const session = store.createSession({ id: 'session', workspaceId: 'workspace' })
  return { session, stream, onChange, logger, release, signal: () => signal }
}

describe('background session titles', () => {
  it('uses a supported low effort when the model cannot disable reasoning', () => {
    const { session, stream } = setup({ model: { ...alias,
      thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'max' }, reasoningEfforts: ['low', 'high', 'max'] } })
    generator.start(session, message, alias.alias)
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: 'low', maxOutputTokens: 2048,
      reasoning: { mode: 'effort', enabled: true, explicit: true, effort: 'low' }
    }), expect.any(AbortSignal), expect.anything())
  })
  it('immediately sets a preview, generates without tools/thinking, and only commits the completed visible title', async () => {
    const { session, stream, onChange, release } = setup()
    expect(generator.start(session, message, alias.alias)).toBeUndefined()
    expect(store.getSession(session.id)?.title).toBe(message.parts[0]?.type === 'text' ? message.parts[0].text : '')
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      tools: [], maxOutputTokens: 256, reasoning: { mode: 'toggle', enabled: false, explicit: true },
      messages: [message]
    }), expect.any(AbortSignal), expect.objectContaining({ sessionId: session.id, runId: expect.stringMatching(/^title_/) }))
    release()
    await vi.waitFor(() => expect(store.getSession(session.id)?.title).toBe('修复登录权限问题'))
    expect(store.getHistory(session.id)).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('deduplicates pending jobs and never changes an existing custom title', () => {
    const { session, stream } = setup()
    generator.start(session, message, alias.alias)
    generator.start(session, message, alias.alias)
    const custom = store.createSession({ id: 'custom', workspaceId: 'workspace', title: 'My project' })
    generator.start(custom, message, alias.alias)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(store.getSession('custom')?.title).toBe('My project')
  })

  it('uses the first image when the first message has no text', async () => {
    const { session, stream, release } = setup()
    const image = userMessage('image-message', [{ type: 'image', dataRef: 'ncw://session/session/diagram.png', mime: 'image/png' }], 1)
    generator.start(session, image, alias.alias)
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ messages: [image] }), expect.any(AbortSignal), expect.anything())
    release()
    await vi.waitFor(() => expect(store.getSession(session.id)?.title).toBe('修复登录权限问题'))
  })

  it.each(['My manual name', '新对话', '帮我检查登录页面的权限问题，并补上必要的修复。'])('preserves a manual rename while pending: %s', async (name) => {
    const { session, onChange, release } = setup()
    generator.start(session, message, alias.alias)
    store.renameSession(session.id, name)
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(store.getSession(session.id)).toMatchObject({ title: name, titleSource: 'manual' })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a placeholder that was explicitly renamed before the first message', () => {
    const { session, stream } = setup()
    store.renameSession(session.id, '新对话')
    generator.start(store.getSession(session.id)!, message, alias.alias)
    expect(stream).not.toHaveBeenCalled()
  })

  it('preserves newer metadata and does not reorder the sidebar when a title arrives late', async () => {
    const { session, release } = setup()
    generator.start(session, message, alias.alias)
    store.putSession({ ...store.getSession(session.id)!, archived: true, favorited: true, model: 'another model', updatedAt: 999 })
    release()
    await vi.waitFor(() => expect(store.getSession(session.id)?.title).toBe('修复登录权限问题'))
    expect(store.getSession(session.id)).toMatchObject({ archived: true, favorited: true, model: 'another model', updatedAt: 999 })
  })

  it('does not resurrect a deleted conversation', async () => {
    const { session, release, onChange } = setup()
    generator.start(session, message, alias.alias)
    store.deleteSession(session.id)
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(store.getSession(session.id)).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['API error', [{ type: 'error', error: agentError('provider', 'Unavailable') }]],
    ['incomplete stream', [title]],
    ['truncation', [title, { ...end, stopReason: 'max_tokens' }]],
    ['reasoning only', [{ type: 'thinking_delta', index: 0, text: 'Do not use this' }, end]],
    ['multiline answer', [{ type: 'text_delta', index: 0, text: 'Sure!\nHere is a title' }, end]],
    ['tool request', [{ type: 'tool_call_start', index: 0, callId: 'unexpected', name: 'Write' }, end]]
  ] as Array<[string, ProviderStreamEvent[]]>)('keeps the preview after %s', async (_label, events) => {
    const { session, release, onChange } = setup({ events })
    generator.start(session, message, alias.alias)
    const preview = store.getSession(session.id)?.title
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(store.getSession(session.id)?.title).toBe(preview)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'shutdown'])('aborts on %s and ignores a late response', async (reason) => {
    vi.useFakeTimers()
    const { session, release, signal, onChange } = setup({ timeoutMs: 50 })
    generator.start(session, message, alias.alias)
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(50)
    else generator.clear()
    expect(signal().aborted).toBe(true)
    release()
    await vi.runAllTimersAsync()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('resolves saved tab names from sessions, even when an old layout is persisted after generation', () => {
    const { session } = setup()
    store.renameSession(session.id, 'Canonical session name')
    store.setKv(innerTabKey(session.workspaceId), { ...EMPTY_INNER, tabs: [
      { id: 'chat', kind: 'chat', title: '新对话', ref: { sessionId: session.id } },
      { id: 'doc', kind: 'doc', title: 'README.md', ref: { path: '/workspace/README.md' } }
    ], activeTabId: 'chat' })
    const restored = store.getInnerTabs(session.workspaceId)
    expect(restored.tabs.map((tab) => tab.title)).toEqual(['Canonical session name', 'README.md'])
    expect(restored.activeTabId).toBe('chat')
  })
})
