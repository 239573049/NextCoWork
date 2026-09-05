import { describe, expect, it, vi } from 'vitest'
import type { RunRequest } from '../../../../shared/agent/run-request'
import type { ModelAlias, ThinkingConfig, UpstreamProtocol } from '../../../../shared/domain/provider'
import { AgentSession } from '../../agent-session'
import { nodeHost } from '../../host'
import { RunHandle } from '../../run-registry'
import { ToolRegistry } from '../../tool/registry'
import { UpstreamRouter } from '../router'
import { chunk, messageItem, responseDone, sse } from './openai-fixtures'

function reply(protocol: UpstreamProtocol): Response {
  if (protocol === 'openai-chat') return sse(chunk({ content: 'Done.' }, 'stop'), '[DONE]')
  if (protocol === 'openai-responses') return sse(responseDone([messageItem]))
  return sse(
    { type: 'message_start', message: { model: 'deepseek-v4-pro', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  )
}

const cases: Array<{ protocol: UpstreamProtocol; model: string; config?: ThinkingConfig; field: string; value: unknown }> = [
  { protocol: 'anthropic', model: 'deepseek-v4-pro', field: 'thinking', value: { type: 'disabled' } },
  { protocol: 'openai-chat', model: 'deepseek-v4-pro', field: 'thinking', value: { type: 'disabled' } },
  { protocol: 'openai-chat', model: 'z-ai/glm-5.3-flash', field: 'thinking', value: { type: 'disabled' } },
  { protocol: 'anthropic', model: 'claude-sonnet-4', config: { mode: 'budget', defaultEnabled: true }, field: 'thinking', value: { type: 'disabled' } },
  { protocol: 'openai-chat', model: 'gpt-5.2', config: { mode: 'effort', defaultEnabled: true }, field: 'reasoning_effort', value: 'none' },
  { protocol: 'openai-responses', model: 'gpt-5.2', config: { mode: 'effort', defaultEnabled: true }, field: 'reasoning', value: { effort: 'none' } }
]

describe.each(cases)('conversation Off → $protocol / $model', ({ protocol, model, config, field, value }) => {
  it.each([false, true])('sends explicit disable through the real agent/router even with saved patches: %s', async (withPatches) => {
    const bodies: Array<Record<string, unknown>> = []
    const host = nodeHost({ fetch: vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return reply(protocol)
    }) })
    await host.secrets.set('test-key-ref', 'not-a-real-api-key')
    const alias: ModelAlias = {
      alias: model, upstreamModel: model, providerId: 'p', contextWindow: 128000, maxOutputTokens: 8192,
      // Reproduce old imported aliases: thinking=false with no ThinkingConfig.
      capabilities: { tools: false, thinking: config !== undefined, vision: false, caching: false },
      ...(config === undefined ? {} : { thinkingConfig: config, reasoningEfforts: ['none', 'high'] as const }),
      ...(withPatches ? { requestAdapter: { preset: 'auto' as const, patches: [
        { op: 'add' as const, path: '/thinking', value: { type: 'enabled', budget_tokens: 4096 } },
        { op: 'add' as const, path: '/reasoning_effort', value: 'high' },
        { op: 'add' as const, path: '/extra_body', value: { enable_thinking: true, thinking: { type: 'enabled' }, keep: 'ordinary parameter' } },
        { op: 'add' as const, path: '/temperature', value: 0.5 }
      ] } } : {})
    }
    const router = new UpstreamRouter(host, {
      providers: () => [{ id: 'p', name: 'Test', protocol, baseUrl: 'https://local.test', credentialRef: 'test-key-ref', priority: 0, enabled: true }],
      aliases: () => [alias], failoverEnabled: () => false
    })
    const request: RunRequest = {
      runId: 'off-run', sessionId: 'off-session', workspaceId: 'w', depth: 0, model,
      input: [{ type: 'text', text: 'Reply without thinking.' }], thinking: 'off', mode: 'normal',
      permissionMode: 'ask', webSearch: false, skillIds: []
    }
    const handle = new RunHandle(request)
    await new AgentSession({ host, upstream: router, tools: new ToolRegistry(), workspaceRoot: '/workspace' }, handle, request).run()
    expect(handle.status).toBe('done')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.[field]).toEqual(value)
    if (withPatches) {
      expect(bodies[0]?.extra_body).toEqual({ keep: 'ordinary parameter' })
      expect(bodies[0]?.temperature).toBe(0.5)
    }
    expect(JSON.stringify(bodies[0])).not.toContain('"type":"enabled"')
    if (field === 'thinking') expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })
})
