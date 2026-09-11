import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunRequest } from '../../shared/agent/run-request'
import { visibleText } from '../../shared/agent/message'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/domain/workspace'
import { closeDatabase } from '../db'
import { nodeHost } from '../kernel/host'
import { RunHandle } from '../kernel/run-registry'
import { chunk, sse } from '../kernel/upstream/__tests__/openai-fixtures'
import { getRouter, installHost, resetRuntimeForTest, runAgent, setSessionChangeListener } from '../runtime'
import { SESSION_TITLE_PROMPT } from '../session-title'
import { store } from '../state/store'

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  runId: 'run', sessionId: 'session', workspaceId: 'workspace', model: 'deepseek-title-test', depth: 0,
  input: [{ type: 'text', text: '帮我实现异步会话标题。' }], thinking: 'off', mode: 'normal',
  permissionMode: 'ask', webSearch: false, skillIds: [], ...overrides
})

beforeEach(() => { resetRuntimeForTest(); closeDatabase() })
afterEach(() => { resetRuntimeForTest(); closeDatabase() })

async function setup(titleFailure = false) {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const requests: Array<{ kind: 'title' | 'chat'; body: Record<string, unknown> }> = []
  const base = nodeHost()
  const host = nodeHost({
    fs: { ...base.fs, exists: async () => false, readDir: async () => [] },
    spawn: async () => ({ code: 1, stdout: '', stderr: '' }),
    fetch: vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const isTitle = body.messages.some((message: { role: string; content: unknown }) => message.role === 'system' && message.content === SESSION_TITLE_PROMPT)
      requests.push({ kind: isTitle ? 'title' : 'chat', body })
      if (isTitle) {
        await ready
        if (titleFailure) return new Response('Unavailable', { status: 400 })
        return sse(chunk({ content: '异步会话标题' }, 'stop'), '[DONE]')
      }
      return sse(chunk({ content: 'Conversation finished while the title request is pending.' }, 'stop'), '[DONE]')
    })
  })
  installHost(host)
  await host.secrets.set('title-test-key', 'not-a-real-api-key')
  store.putWorkspace({ id: 'workspace', name: 'Test', rootPath: '/title-test', createdAt: 1, lastOpenedAt: 1, settings: DEFAULT_WORKSPACE_SETTINGS })
  store.putProvider({ id: 'title-provider', name: 'Test', protocol: 'openai-chat', baseUrl: 'https://title-test.invalid',
    credentialRef: 'title-test-key', priority: 0, enabled: true })
  store.putAlias({ alias: 'deepseek-title-test', upstreamModel: 'deepseek-title-test', providerId: 'title-provider',
    capabilities: { tools: true, vision: false, thinking: true, caching: false }, contextWindow: 128_000, maxOutputTokens: 8_192 })
  const session = store.createSession({ id: 'session', workspaceId: 'workspace', title: '新对话' })
  const changed = vi.fn()
  setSessionChangeListener(changed)
  return { host, release, requests, session, changed }
}

describe('run startup cancellation', () => {
  it('rejects an unknown workspace before local file access, execution, or model requests', async () => {
    const { host, release, requests } = await setup()
    const reads = vi.spyOn(host.fs, 'readDir')
    const commands = vi.spyOn(host, 'spawn')
    const req = request({ workspaceId: 'missing' })
    try { await expect(runAgent(new RunHandle(req), req)).rejects.toThrow('unbound') } finally { release() }
    expect(reads).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it.each(['scan', 'git'] as const)('stops during a stalled %s and never starts a late model request', async (stage) => {
    const { host, release, requests } = await setup()
    let releaseOperation!: () => void
    let waiting = false
    const blocked = new Promise<void>((resolve) => { releaseOperation = resolve })
    if (stage === 'scan') {
      vi.spyOn(host.fs, 'exists').mockImplementation(async () => {
        waiting = true
        await blocked
        return false
      })
    } else {
      vi.spyOn(host, 'spawn').mockImplementation(async () => {
        waiting = true
        await blocked
        return { code: 1, stdout: '', stderr: '' }
      })
    }
    const req = request()
    const handle = new RunHandle(req)
    const running = runAgent(handle, req)
    try {
      await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 200, interval: 1 })
      handle.abort({ by: 'user' })
      await vi.waitFor(() => expect(handle.status).toBe('aborted'), { timeout: 200, interval: 1 })
      await running
      expect(handle.endedAt).toBeDefined()
    } finally {
      releaseOperation()
      release()
      await running
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(requests).toEqual([])
    expect(store.getHistory(req.sessionId)).toEqual([])
    expect(handle.since(0).filter((event) => event.type === 'run_end')).toHaveLength(1)
  })
})

describe('first message title wiring', () => {
  it('starts and completes the Agent while the title is unresolved, then broadcasts the generated title', async () => {
    const { release, requests, changed } = await setup()
    const req = request()
    const handle = new RunHandle(req)
    await runAgent(handle, req)
    expect(handle.status).toBe('done')
    expect(requests.map((item) => item.kind)).toEqual(['chat', 'title'])
    expect(store.getSession(req.sessionId)?.title).toBe('帮我实现异步会话标题。')
    expect(store.getHistory(req.sessionId).map(visibleText)).toEqual([
      '帮我实现异步会话标题。', 'Conversation finished while the title request is pending.'
    ])
    release()
    await vi.waitFor(() => expect(store.getSession(req.sessionId)?.title).toBe('异步会话标题'))
    expect(changed).toHaveBeenCalledWith({ kind: 'metadata', sessionIds: ['session'], workspaceId: 'workspace', renamed: { sessionId: 'session', title: '异步会话标题' } })

    const followup = request({ runId: 'followup', input: [{ type: 'text', text: '第二条消息。' }] })
    await runAgent(new RunHandle(followup), followup)
    expect(requests.map((item) => item.kind)).toEqual(['chat', 'title', 'chat'])
    expect(store.getSession(req.sessionId)?.title).toBe('异步会话标题')
  })

  it('a failed title request does not fail the Agent or change its provider health', async () => {
    const { release, requests } = await setup(true)
    const req = request()
    const handle = new RunHandle(req)
    await runAgent(handle, req)
    release()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(handle.status).toBe('done')
    expect(getRouter().health()).toEqual([expect.objectContaining({ consecutiveFailures: 0, healthy: true })])
    expect(store.getSession(req.sessionId)?.title).toBe('帮我实现异步会话标题。')
  })

  it.each(['custom title', 'subagent', 'existing history', 'continuation'])('does not title a %s', async (scenario) => {
    const { requests } = await setup()
    if (scenario === 'custom title') store.renameSession('session', '用户指定的名字')
    if (scenario === 'existing history') {
      store.commitMessage('session', { id: 'earlier', role: 'user', parts: [{ type: 'text', text: 'Earlier' }], createdAt: 1, schemaVersion: 1 })
    }
    const req = request({ ...(scenario === 'subagent' ? { depth: 1 } : {}), ...(scenario === 'continuation' ? { input: [] } : {}) })
    await runAgent(new RunHandle(req), req)
    expect(requests.every((item) => item.kind === 'chat')).toBe(true)
  })
})
