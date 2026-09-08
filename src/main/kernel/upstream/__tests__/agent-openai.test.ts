import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../shared/agent/event'
import type { AgentMessage } from '../../../../shared/agent/message'
import { orphanedToolCalls, visibleText } from '../../../../shared/agent/message'
import type { RunRequest } from '../../../../shared/agent/run-request'
import type { ModelAlias, UpstreamProtocol } from '../../../../shared/domain/provider'
import type { UnpricedUsageAttempt } from '../../../../shared/domain/usage'
import { applyEvents, emptyTranscript } from '../../../../shared/agent/transcript'
import { toolOk } from '../../../../shared/agent/tool'
import { AgentSession } from '../../agent-session'
import { nodeHost } from '../../host'
import { InteractionGate } from '../../interaction-gate'
import { RunHandle } from '../../run-registry'
import { ToolRegistry } from '../../tool/registry'
import { askUserTool } from '../../tool/builtin/interaction'
import { UpstreamRouter } from '../router'
import { chunk, functionItem, messageItem, reasoningItem, responseDone, sse } from './openai-fixtures'

const protocols = ['openai-chat', 'openai-responses'] as const
function callResponse(protocol: UpstreamProtocol, name = 'Echo', args = '{"text":"hello"}'): Response {
  return protocol === 'openai-chat' ? sse(
    chunk({ reasoning_content: '检查参数。' }), chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: args } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30,
      prompt_cache_hit_tokens: 60, completion_tokens_details: { reasoning_tokens: 20 } } }, '[DONE]'
  ) : sse(responseDone([reasoningItem, { ...functionItem, name, arguments: args }]))
}
function finalResponse(protocol: UpstreamProtocol): Response {
  return protocol === 'openai-chat' ? sse(chunk({ content: '完成' }, 'stop'), '[DONE]') : sse(responseDone([messageItem]))
}

function rig(protocol: typeof protocols[number], responses: Response[]) {
  const request: RunRequest = { runId: 'r1', sessionId: 's1', workspaceId: 'w1', depth: 0, input: [{ type: 'text', text: '开始' }],
    mode: 'normal', thinking: 'high', webSearch: false, permissionMode: 'ask', model: 'test', skillIds: [] }
  const alias: ModelAlias = { alias: 'test', providerId: 'p', upstreamModel: protocol === 'openai-chat' ? 'deepseek-test' : 'gpt-test',
    contextWindow: 200000, maxOutputTokens: 8192, capabilities: { tools: true, thinking: true, caching: true, vision: true },
    thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' } }
  const bodies: Array<Record<string, unknown>> = []
  const urls: string[] = []
  const ledger: UnpricedUsageAttempt[] = []
  const host = nodeHost({ fetch: vi.fn(async (url, init) => {
    urls.push(String(url))
    bodies.push(JSON.parse(String(init?.body)))
    const response = responses.shift()
    if (response === undefined) throw new Error('Unexpected request')
    return response
  }), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } })
  const ready = host.secrets.set('key', 'local-test-key')
  const router = new UpstreamRouter(host, { providers: () => [{ id: 'p', name: 'p', protocol, baseUrl: 'https://upstream.test/api/v3', credentialRef: 'key', priority: 0, enabled: true }], aliases: () => [alias], failoverEnabled: () => false }, { baseDelayMs: 0, onUsageAttempt: (entry) => ledger.push(entry) })
  const tools = new ToolRegistry()
  const execute = vi.fn(async (input) => toolOk(JSON.stringify(input)))
  tools.register({ internalId: 'Echo', description: 'Test tool', inputSchema: { type: 'object' }, readOnly: false, destructive: true, needsNetwork: false, source: { kind: 'builtin' }, execute })
  tools.register(askUserTool)
  const gate = new InteractionGate()
  const handle = new RunHandle(request)
  const events: AgentEvent[] = []
  const saved: AgentMessage[] = []
  handle.on((event) => events.push(event))
  const session = new AgentSession({ host, upstream: router, tools, workspaceRoot: '/workspace',
    onMessageCommit: (message) => saved.push(structuredClone(message)),
    approve: async ({ tool, callId, input }) => {
      if (tool.readOnly) return { kind: 'allow_once' }
      const response = await gate.request(handle, { kind: 'tool_permission', callId, toolName: tool.externalName, input, readOnly: false, destructive: true }, Date.now())
      return response.kind === 'tool_permission' ? response.decision : { kind: 'deny' }
    }, interact: (draft) => gate.request(handle, draft, Date.now())
  }, handle, request)
  return { request, host, router, tools, gate, handle, events, saved, session, execute, bodies, urls, ledger, ready }
}

describe.each(protocols)('%s real router → agent → interaction → tool → continuation', (protocol) => {
  it('waits for approval, executes edited input, persists reasoning and sends a valid continuation', async () => {
    const r = rig(protocol, [callResponse(protocol), finalResponse(protocol), finalResponse(protocol)])
    await r.ready
    const running = r.session.run()
    await vi.waitFor(() => expect(r.gate.list()).toHaveLength(1))
    expect(r.execute).not.toHaveBeenCalled()
    expect(r.bodies).toHaveLength(1)
    const pending = r.gate.list()[0]!
    expect(r.handle.snapshot(0).pendingInteractions).toEqual([pending])
    r.gate.respond({ id: pending.id, kind: 'tool_permission', decision: { kind: 'allow_edited', input: { text: 'edited' } } })
    await running
    expect(r.handle.status).toBe('done')
    expect(r.execute).toHaveBeenCalledExactlyOnceWith({ text: 'edited' }, expect.anything())
    expect(orphanedToolCalls([...r.session.history])).toEqual([])
    expect(r.saved).toEqual(r.session.history)
    const transcript = applyEvents(emptyTranscript(), r.events)
    expect(transcript.status).toBe('done')
    expect(transcript.live).toEqual([])
    // Compare the displayed total to actual decoded API usage across the tool
    // call and continuation, including after committed deltas are pruned.
    expect(transcript.usage?.outputTokens).toBe(protocol === 'openai-chat' ? 30 : 60)
    expect(transcript.usage?.outputTokens).toBe(r.ledger.reduce((sum, entry) => sum + entry.outputTokens, 0))
    expect(applyEvents(emptyTranscript(), r.handle.snapshot(0).events).usage).toEqual(transcript.usage)
    expect(transcript.messages.flatMap((m) => m.parts).filter((p) => p.type === 'thinking')).toHaveLength(1)
    expect(visibleText(r.saved.at(-1)!)).toBe('完成')
    expect(r.ledger[0]).toMatchObject({ inputTokens: 40, cacheReadTokens: 60, thinkingTokens: 20, thinkingTokensEstimated: false, toolCalls: 1, ok: true })
    expect(r.urls).toEqual(Array(2).fill(`https://upstream.test/api/v3/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`))
    if (protocol === 'openai-chat') {
      expect(r.bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
      expect(r.bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: 'assistant', reasoning_content: '检查参数。' }))
      expect(r.bodies[1]?.messages).toContainEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"text":"edited"}' })
    } else {
      expect(r.bodies[0]).toHaveProperty('reasoning.effort', 'high')
      expect(r.bodies[1]?.input).toContainEqual(reasoningItem)
      expect(r.bodies[1]?.input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"text":"edited"}' })
    }
    // Reloaded transcript, then a new user turn: reasoning metadata survives JSON storage.
    const nextRequest = { ...r.request, runId: 'r2', input: [{ type: 'text' as const, text: '继续' }] }
    const nextHandle = new RunHandle(nextRequest)
    const next = new AgentSession({ host: r.host, upstream: r.router, tools: r.tools, workspaceRoot: '/workspace',
      history: JSON.parse(JSON.stringify(r.saved)) }, nextHandle, nextRequest)
    await next.run()
    expect(nextHandle.status).toBe('done')
    expect(JSON.stringify(r.bodies[2])).toContain(protocol === 'openai-chat' ? 'reasoning_content' : 'encrypted-reasoning')
  })

  it('returns a denial to the model without executing the tool', async () => {
    const r = rig(protocol, [callResponse(protocol), finalResponse(protocol)])
    await r.ready
    const running = r.session.run()
    await vi.waitFor(() => expect(r.gate.list()).toHaveLength(1))
    r.gate.respond({ id: r.gate.list()[0]!.id, kind: 'tool_permission', decision: { kind: 'deny' } })
    await running
    expect(r.execute).not.toHaveBeenCalled()
    expect(r.handle.status).toBe('done')
    expect(JSON.stringify(r.bodies[1])).toContain('denied')
  })

  it('cancels during approval and closes unexecuted calls for the next user turn', async () => {
    const r = rig(protocol, [callResponse(protocol)])
    await r.ready
    const running = r.session.run()
    await vi.waitFor(() => expect(r.gate.list()).toHaveLength(1))
    r.handle.abort({ by: 'user' })
    await running
    expect(r.handle.status).toBe('aborted')
    expect(r.gate.list()).toEqual([])
    expect(r.execute).not.toHaveBeenCalled()
    expect(orphanedToolCalls([...r.session.history])).toEqual([])
  })

  it('asks the user and sends the actual answer back as a tool result', async () => {
    const r = rig(protocol, [callResponse(protocol, 'AskUserQuestion', '{"questions":[{"header":"Choose","question":"Choose one","options":[{"label":"A"},{"label":"B"}],"multiSelect":false,"allowFreeform":false}]}'), finalResponse(protocol)])
    await r.ready
    const running = r.session.run()
    await vi.waitFor(() => expect(r.gate.list()[0]?.kind).toBe('ask_user'))
    r.gate.respond({ id: r.gate.list()[0]!.id, kind: 'ask_user', answers: [['B']] })
    await running
    expect(r.handle.status).toBe('done')
    expect(JSON.stringify(r.bodies[1])).toContain('answer')
    expect(r.execute).not.toHaveBeenCalled()
  })

  it('never retries or executes partial tool output on a truncated stream', async () => {
    const response = protocol === 'openai-chat' ? sse(chunk({ reasoning_content: 'partial', tool_calls: [
      { index: 0, id: 'c', function: { name: 'Echo', arguments: '{"text":' } }
    ] })) : sse({ type: 'response.output_item.added', output_index: 0, item: functionItem })
    const r = rig(protocol, [response])
    await r.ready
    await r.session.run()
    expect(r.handle.status).toBe('error')
    expect(r.bodies).toHaveLength(1)
    expect(r.execute).not.toHaveBeenCalled()
    expect(orphanedToolCalls([...r.session.history])).toEqual([])
  })
})
