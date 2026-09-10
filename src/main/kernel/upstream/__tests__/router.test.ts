import { describe, expect, it } from 'vitest'
import type { ProviderStreamEvent } from '../../../../shared/agent/stream'
import type { ModelAlias, UpstreamProvider } from '../../../../shared/domain/provider'
import { CLIENT_PROVIDER_ID } from '../../../../shared/domain/presets'
import type { UnpricedUsageAttempt } from '../../../../shared/domain/usage'
import { nodeHost, type KernelHost } from '../../host'
import type { CanonicalRequest } from '../canonical'
import { parseRetryAfter, UpstreamRouter, type ProviderConfigSource } from '../router'
import { chunk, sse, responseDone, messageItem } from './openai-fixtures'

describe('OpenAI protocol routing and recovery', () => {
  it('resolves Auto against each provider binding when their supported efforts differ', async () => {
    const r = rig({
      providers: [provider('chat', { protocol: 'openai-chat' }), provider('responses', { protocol: 'openai-responses', priority: 1 })],
      aliases: [
        { ...alias('m', 'chat'), thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' }, reasoningEfforts: ['high'] },
        { ...alias('m', 'responses'), thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'low' }, reasoningEfforts: ['low'] }
      ],
      responses: [fail(503), fail(503), fail(503), sse(responseDone([messageItem]))]
    })
    const output: ProviderStreamEvent[] = []
    for await (const event of r.router.stream({ ...REQ, thinkingLevel: 'auto',
      reasoning: { mode: 'effort', enabled: true, explicit: false, effort: 'high' }
    }, new AbortController().signal, { workspaceId: 'w' })) output.push(event)
    expect(r.bodies[0]?.reasoning_effort).toBe('high')
    expect(r.bodies[3]?.reasoning).toEqual({ effort: 'low' })
    expect(output.at(-1)).toMatchObject({ type: 'message_end' })
  })
  it('retries Chat before content and switches to Responses using its own wire format', async () => {
    const r = rig({
      providers: [provider('chat', { protocol: 'openai-chat' }), provider('responses', { protocol: 'openai-responses', priority: 1 })],
      aliases: [alias('m', 'chat'), alias('m', 'responses')],
      responses: [fail(503), fail(503), fail(503), sse(responseDone([messageItem]))]
    })
    const output = await drain(r.router)
    expect(r.calls).toEqual([
      'https://chat.example.com/chat/completions', 'https://chat.example.com/chat/completions',
      'https://chat.example.com/chat/completions', 'https://responses.example.com/responses'
    ])
    expect(r.bodies[0]).toHaveProperty('messages')
    expect(r.bodies[3]).toHaveProperty('input')
    expect(r.bodies[3]).not.toHaveProperty('messages')
    expect(r.bodies.every((body) => body.metadata === undefined)).toBe(true)
    expect(output.filter((event) => event.type === 'provider_retry')).toHaveLength(2)
    expect(output).toContainEqual(expect.objectContaining({ type: 'provider_switch' }))
    expect(output.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
  })

  it('never retries or switches after DeepSeek reasoning has reached the user', async () => {
    const r = rig({
      providers: [provider('chat', { protocol: 'openai-chat' }), provider('fallback', { priority: 1 })],
      aliases: [alias('m', 'chat'), alias('m', 'fallback')],
      responses: [sse(chunk({ reasoning_content: 'Thinking so far.' }), { error: { type: 'server_error', message: 'Interrupted' } })]
    })
    const output = await drain(r.router)
    expect(r.calls).toHaveLength(1)
    expect(output).toContainEqual(expect.objectContaining({ type: 'thinking_delta', text: 'Thinking so far.' }))
    expect(output.at(-1)).toMatchObject({ type: 'error' })
    expect(r.usageRecords[0]).toMatchObject({ ok: false })
  })

  it('accepts a compatible provider returning JSON instead of SSE', async () => {
    const r = rig({ providers: [provider('chat', { protocol: 'openai-chat' })], aliases: [alias('m', 'chat')],
      responses: [Response.json({ model: 'deepseek-test', choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', reasoning_content: 'Check.', content: 'Done.'
      } }], usage: { prompt_tokens: 10, completion_tokens: 8 } })]
    })
    const output = await drain(r.router)
    expect(output).toContainEqual(expect.objectContaining({ type: 'thinking_delta', text: 'Check.' }))
    expect(output.at(-1)).toMatchObject({ type: 'message_end', usage: { inputTokens: 10, outputTokens: 8 } })
  })

  it('does not count an empty decoded response as a successful request', async () => {
    // network 错误的重试上限是 MAX_NETWORK_ATTEMPTS(6),不是通用的 MAX_ATTEMPTS(3)
    const r = rig({
      providers: [provider('a')], aliases: [alias('m', 'a')],
      responses: [ok(''), ok(''), ok(''), ok(''), ok(''), ok('')]
    })
    expect((await drain(r.router)).at(-1)).toMatchObject({ type: 'error', error: { code: 'network' } })
    expect(r.usageRecords).toHaveLength(6)
    expect(r.usageRecords.every((attempt) => !attempt.ok)).toBe(true)
    expect(r.router.health()[0]?.healthy).toBe(false)
  })
})

// ─── 夹具 ────────────────────────────────────────────────────────────

function provider(id: string, over: Partial<UpstreamProvider> = {}): UpstreamProvider {
  return {
    id,
    name: id,
    protocol: 'anthropic',
    baseUrl: `https://${id}.example.com`,
    credentialRef: `ref:${id}`,
    priority: 0,
    enabled: true,
    ...over
  }
}

function alias(aliasName: string, providerId: string): ModelAlias {
  return {
    alias: aliasName,
    providerId,
    upstreamModel: `${aliasName}-upstream`,
    capabilities: { tools: true, vision: false, thinking: true, caching: true },
    contextWindow: 200_000,
    maxOutputTokens: 8192
  }
}

const REQ: CanonicalRequest = {
  model: 'm',
  system: '',
  messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 0, schemaVersion: 1 }],
  tools: [],
  maxOutputTokens: 1024
}

/** 一段完整的 Anthropic SSE 响应 */
function sseBody(parts: { text?: string; stop?: string } = {}): string {
  const lines = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m-up","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
  ]
  if (parts.text !== undefined) {
    lines.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: parts.text }
      })}\n\n`
    )
  }
  lines.push('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
  lines.push(
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${parts.stop ?? 'end_turn'}"},"usage":{"output_tokens":3}}\n\n`
  )
  lines.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  return lines.join('')
}

function thinkingSseBody(): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m-up","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'a long visible reasoning passage' }
    })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join('')
}

/** 一段**中途断掉**的 SSE:发了内容但没有 message_stop */
function truncatedBody(text: string): string {
  return (
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m-up","usage":{"input_tokens":5}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    })}\n\n`
  )
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function fail(status: number, type = 'api_error', message = 'boom', headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers })
}

interface Rig {
  router: UpstreamRouter
  host: KernelHost
  calls: string[]
  secretReads: string[]
  bodies: Array<Record<string, unknown>>
  headers: Array<Record<string, string>>
  usageRecords: UnpricedUsageAttempt[]
  now: { t: number }
}

function rig(opts: {
  providers: UpstreamProvider[]
  aliases: ModelAlias[]
  failover?: boolean
  keys?: Record<string, string | null>
  rateLimitFloorMs?: number
  responses: Array<Response | (() => Response) | Error>
}): Rig {
  const calls: string[] = []
  const secretReads: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const headers: Array<Record<string, string>> = []
  const usageRecords: UnpricedUsageAttempt[] = []
  const now = { t: 1_000_000 }
  let i = 0

  const host = nodeHost({
    clock: { now: () => now.t },
    secrets: {
      get: async (ref) => {
        secretReads.push(ref)
        const explicit = opts.keys?.[ref]
        return explicit === undefined ? 'sk-test' : explicit
      },
      set: async () => {},
      available: () => true
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input))
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      headers.push((init?.headers ?? {}) as Record<string, string>)
      const r = opts.responses[i++]
      if (r === undefined) throw new Error(`没有为第 ${i} 次调用准备响应`)
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r() : r
    }) as typeof fetch,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  })

  const config: ProviderConfigSource = {
    providers: () => opts.providers,
    aliases: () => opts.aliases,
    failoverEnabled: () => opts.failover ?? true
  }
  return {
    router: new UpstreamRouter(host, config, {
      baseDelayMs: 0,
      // 限流退避的默认基数是秒级(生产上必须如此),测试里压成 0 —— 否则每个
      // 429 用例都要真的睡上几秒。要断言退避本身的用例自己传一个小的非零值。
      rateLimitFloorMs: opts.rateLimitFloorMs ?? 0,
      onUsageAttempt: (record) => usageRecords.push(record)
    }),
    host,
    calls,
    secretReads,
    bodies,
    headers,
    usageRecords,
    now
  }
}

async function drain(r: UpstreamRouter, signal = new AbortController().signal): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of r.stream(REQ, signal, { workspaceId: 'ws-test' })) out.push(ev)
  return out
}

async function drainRequest(
  r: UpstreamRouter,
  request: CanonicalRequest,
  signal = new AbortController().signal
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of r.stream(request, signal, { workspaceId: 'ws-test' })) out.push(ev)
  return out
}

async function drainWithContext(
  r: UpstreamRouter,
  context: { workspaceId: string },
  signal = new AbortController().signal
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of r.stream(REQ, signal, context)) out.push(ev)
  return out
}

// ─── 用例 ────────────────────────────────────────────────────────────

describe('UpstreamRouter · 正常路径', () => {
  it('单 provider 流式贯通', async () => {
    const { router, calls } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: '你好' }))]
    })
    const out = await drain(router)
    expect(out.map((e) => e.type)).toEqual(['message_start', 'text_delta', 'message_end'])
    expect(calls).toEqual(['https://p1.example.com/v1/messages'])
  })

  it('每次上游尝试都记录路由、Token、状态和延迟元数据', async () => {
    const { router, usageRecords, now } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: '你好' }))]
    })

    const out: ProviderStreamEvent[] = []
    for await (const event of router.stream(REQ, new AbortController().signal, {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      sessionId: 'session-1'
    })) {
      out.push(event)
      if (event.type === 'message_start') now.t += 40
      if (event.type === 'text_delta') now.t += 60
    }

    expect(out.at(-1)?.type).toBe('message_end')
    expect(usageRecords).toHaveLength(1)
    expect(usageRecords[0]).toMatchObject({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      attempt: 1,
      providerId: 'p1',
      providerName: 'p1',
      protocol: 'anthropic',
      endpoint: 'https://p1.example.com/v1/messages',
      alias: 'm',
      upstreamModel: 'm-upstream',
      responseModel: 'm-up',
      inputTokens: 5,
      outputTokens: 3,
      ok: true,
      httpStatus: 200,
      stopReason: 'end_turn'
    })
    expect(usageRecords[0]?.latencyMs).toBe(100)
    expect(usageRecords[0]?.timeToFirstTokenMs).toBe(40)
  })

  /**
   * 界面上的「平均 TPS」要的是**每次请求各自的耗时**,而不是整轮墙钟 ——
   * 中间跑工具、等用户点「允许」的时间不能算进分母。只有路由器知道请求是
   * 什么时候发出去的,所以由它在转发 message_end 时补上这个数。
   */
  it('message_end 带上这一次请求的耗时,供渲染层累出平均 TPS', async () => {
    const { router, now } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: '你好' }))]
    })

    const out: ProviderStreamEvent[] = []
    for await (const event of router.stream(REQ, new AbortController().signal, { workspaceId: 'w' })) {
      out.push(event)
      if (event.type === 'message_start') now.t += 40
      if (event.type === 'text_delta') now.t += 60
    }

    // message_start 不带 —— 那时还没等过任何时间,也没有可报的速度
    expect(out[0]).toMatchObject({ type: 'message_start' })
    expect(out[0]).not.toHaveProperty('latencyMs')
    expect(out.at(-1)).toMatchObject({ type: 'message_end', latencyMs: 100 })
  })

  it('可见思考只记为明确标注的估算值，且不会超过总输出 Token', async () => {
    const { router, usageRecords } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(thinkingSseBody())]
    })

    await drain(router)

    expect(usageRecords[0]).toMatchObject({
      outputTokens: 3,
      thinkingTokens: 3,
      thinkingTokensEstimated: true
    })
  })

  /**
   * ★ 别名 → 上游真实模型名的翻译发生在路由器(§5.2)。
   * 把 alias 原样下发,每一个请求都会 404,而错误信息只会说「model not found」。
   */
  it('下发的是 upstreamModel 而不是 alias', async () => {
    const { router, bodies } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    expect(bodies[0]?.model).toBe('m-upstream')
    expect(bodies[0]?.stream).toBe(true)
  })

  it('Anthropic 请求始终带 metadata.user_id，缓存档位映射到实际请求体', async () => {
    const { router, bodies } = rig({
      providers: [
        provider('p1', {
          protocolOptions: { anthropic: { cacheTtl: '1h' } }
        })
      ],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    expect(bodies[0]?.metadata).toEqual({ user_id: 'ws-test' })
    expect(bodies[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('同一 alias 的每次 attempt 使用实际选中 Provider 自己的缓存档位', async () => {
    const { router, bodies } = rig({
      providers: [
        provider('p1', {
          priority: 0,
          protocolOptions: { anthropic: { cacheTtl: '5m' } }
        }),
        provider('p2', {
          priority: 1,
          protocolOptions: { anthropic: { cacheTtl: '1h' } }
        })
      ],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      // 普通参数错误允许切换；缓存不兼容错误则不会切换（另有专测）。
      responses: [fail(400, 'invalid_request_error', 'ordinary error'), ok(sseBody({ text: 'p2' }))]
    })
    await drain(router)
    expect(bodies[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(bodies[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(bodies[0]?.metadata).toEqual({ user_id: 'ws-test' })
    expect(bodies[1]?.metadata).toEqual({ user_id: 'ws-test' })
  })

  it('模型级 request-adapter 不能覆盖 Anthropic 的身份、TTL 或稳定断点', async () => {
    const a = alias('m', 'p1')
    a.requestAdapter = {
      preset: 'custom',
      patches: [
        { op: 'replace', path: '/metadata', value: { user_id: 'attacker' } },
        { op: 'replace', path: '/cache_control', value: { type: 'ephemeral', ttl: '5m' } },
        { op: 'add', path: '/system', value: 'adapter supplied stable prefix' }
      ]
    }
    const { router, bodies } = rig({
      providers: [provider('p1', { protocolOptions: { anthropic: { cacheTtl: '1h' } } })],
      aliases: [a],
      responses: [ok(sseBody({ text: 'x' }))]
    })

    await drain(router)

    expect(bodies[0]?.metadata).toEqual({ user_id: 'ws-test' })
    expect(bodies[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(bodies[0]?.system).toEqual([
      {
        type: 'text',
        text: 'adapter supplied stable prefix',
        cache_control: { type: 'ephemeral', ttl: '1h' }
      }
    ])
  })

  it('缓存关闭时 request-adapter 也不能注入 cache_control 或断点', async () => {
    const a = alias('m', 'p1')
    a.requestAdapter = {
      preset: 'custom',
      patches: [
        { op: 'replace', path: '/metadata', value: { user_id: 'attacker' } },
        { op: 'add', path: '/cache_control', value: { type: 'ephemeral', ttl: '1h' } },
        {
          op: 'add',
          path: '/system',
          value: [{ type: 'text', text: 'should not become a breakpoint', cache_control: { type: 'ephemeral' } }]
        }
      ]
    }
    const { router, bodies } = rig({
      providers: [provider('p1')],
      aliases: [a],
      responses: [ok(sseBody({ text: 'x' }))]
    })

    await drain(router)

    expect(bodies[0]?.metadata).toEqual({ user_id: 'ws-test' })
    expect(bodies[0]).not.toHaveProperty('cache_control')
    expect(bodies[0]?.system).toEqual([{ type: 'text', text: 'should not become a breakpoint' }])
  })

  it('目录 ThinkingConfig 在 Anthropic 请求体上真实生效', async () => {
    const a = alias('m', 'p1')
    a.thinkingConfig = {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'medium',
      parameterPath: 'reasoning_effort'
    }
    const { router, bodies } = rig({
      providers: [provider('p1')],
      aliases: [a],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drainRequest(router, {
      ...REQ,
      maxOutputTokens: 8_192,
      reasoning: { mode: 'effort', enabled: true, explicit: true, effort: 'xhigh' }
    })
    expect(bodies[0]?.thinking).toEqual({ type: 'enabled', budget_tokens: 7_168 })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('unsupported 模型即使 Patch 注入也不会发送 Think 字段', async () => {
    const a = alias('m', 'p1')
    a.thinkingConfig = { mode: 'unsupported', defaultEnabled: false }
    a.requestAdapter = {
      preset: 'custom',
      patches: [{ op: 'add', path: '/thinking', value: { type: 'enabled' } }]
    }
    const { router, bodies } = rig({
      providers: [provider('p1')], aliases: [a], responses: [ok(sseBody({ text: 'x' }))]
    })
    await drainRequest(router, { ...REQ, thinkingBudget: 4_096 })
    expect(bodies[0]).not.toHaveProperty('thinking')
  })

  it('非法 Patch 在读取响应前失败且不重试 HTTP', async () => {
    const a = alias('m', 'p1')
    a.requestAdapter = {
      preset: 'custom',
      patches: [{ op: 'add', path: '/model', value: 'other-model' }]
    }
    const { router, calls } = rig({ providers: [provider('p1')], aliases: [a], responses: [] })
    const out = await drain(router)
    expect(calls).toEqual([])
    expect(out.some((event) => event.type === 'provider_retry')).toBe(false)
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider', retryable: false } })
  })

  /** Anthropic 用 x-api-key,不是 Authorization: Bearer —— 写错就是 401 */
  it('凭证走 x-api-key 且带 anthropic-version', async () => {
    const { router, headers } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    expect(headers[0]).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' })
    expect(headers[0]?.authorization).toBeUndefined()
    // 自报家门(kernel/user-agent.ts)——漏了不会报错,只是请求匿名发出去
    expect(headers[0]?.['user-agent']).toMatch(/^NextCoWork\//)
  })

  /**
   * ★ 平台那条上游存的是登录 JWT,而平台网关按头分流:`x-api-key` 非空就去查
   * API Key 表,JWT 在那儿必然「API Key 无效或已停用」。所以那个头要删掉,
   * 不是覆盖成空。
   */
  it('NextCoWork 平台上游即使走 Anthropic 协议也用 Bearer,且不带 x-api-key', async () => {
    const { router, headers } = rig({
      providers: [provider(CLIENT_PROVIDER_ID)],
      aliases: [alias('m', CLIENT_PROVIDER_ID)],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    expect(headers[0]).toMatchObject({ authorization: 'Bearer sk-test', 'anthropic-version': '2023-06-01' })
    expect(headers[0]).not.toHaveProperty('x-api-key')
  })

  it('模型协议覆盖会让 Responses 供应商按 Anthropic endpoint、请求体和认证头调用', async () => {
    const { router, calls, headers, bodies, usageRecords } = rig({
      providers: [provider('responses', { protocol: 'openai-responses' })],
      aliases: [{ ...alias('m', 'responses'), protocolOverride: 'anthropic' }],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    expect(calls).toEqual(['https://responses.example.com/v1/messages'])
    expect(bodies[0]).toMatchObject({ model: 'm-upstream', messages: [{ role: 'user' }] })
    expect(headers[0]).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' })
    expect(headers[0]?.authorization).toBeUndefined()
    expect(usageRecords[0]?.protocol).toBe('anthropic')
  })

  it('成功后健康度上升、连败清零', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    const h = router.health()[0]
    expect(h).toMatchObject({ providerId: 'p1', healthy: true, consecutiveFailures: 0 })
    expect(h?.score).toBe(1)
  })

  it('listModels 只列出已启用 provider 的别名', () => {
    const { router } = rig({
      providers: [provider('p1'), provider('p2', { enabled: false })],
      aliases: [alias('m', 'p1'), alias('m2', 'p2')],
      responses: []
    })
    expect(router.listModels().map((a) => a.alias)).toEqual(['m'])
  })
})

describe('UpstreamRouter · 首字节边界(§5.3)', () => {
  /**
   * ★ 本文件最重要的一条。
   *
   * 上游已经吐了内容再切换 provider,会产生**重复输出和错位的工具调用** ——
   * 而且是在用户眼皮底下发生的。所以内容一开始,重试和切换就都关闭,
   * 失败变成硬错误由用户决定重发。
   */
  it('已有内容后不再重试、不再切换,直接硬错误', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      // 第一次:发了文字然后连接断掉(可重试的 network 错误)
      responses: [ok(truncatedBody('已经说了一半')), ok(sseBody({ text: '不该被用到' }))]
    })
    const out = await drain(router)

    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(1)
    expect(out.some((e) => e.type === 'provider_retry')).toBe(false)
    expect(out.some((e) => e.type === 'provider_switch')).toBe(false)
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'network' } })
    // 只发了一次请求 —— 第二个 provider 根本没被碰
    expect(calls).toHaveLength(1)
  })

  /** 反面:内容还没开始时,同一个可重试错误必须触发重试 */
  it('还没有内容时同样的错误会重试', async () => {
    const { router, calls } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(503), ok(sseBody({ text: '好' }))]
    })
    const out = await drain(router)
    expect(out).toContainEqual({ type: 'provider_retry', attempt: 1, delayMs: 0, reason: 'boom' })
    expect(out.at(-1)?.type).toBe('message_end')
    expect(calls).toHaveLength(2)
  })

  /** message_start 不算内容 —— 此时重试不会产生任何重复输出 */
  it('只收到 message_start 仍可切换', async () => {
    const bare =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"m-up","usage":{}}}\n\n'
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      // p1 是这类 network 错误,MAX_NETWORK_ATTEMPTS(6)次都吃了以后才会换供应商
      responses: [ok(bare), ok(bare), ok(bare), ok(bare), ok(bare), ok(bare), ok(sseBody({ text: '来自 p2' }))]
    })
    const out = await drain(router)
    expect(out.some((e) => e.type === 'provider_switch')).toBe(true)
    expect(out.at(-1)?.type).toBe('message_end')
    expect(calls.at(-1)).toContain('p2')
  })
})

describe('UpstreamRouter · 重试与切换', () => {
  it('不可重试的错误直接换下一个 provider,不在原地重试', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      responses: [fail(400, 'invalid_request_error', 'bad'), ok(sseBody({ text: 'ok' }))]
    })
    const out = await drain(router)
    expect(out.find((e) => e.type === 'provider_switch')).toMatchObject({ from: 'p1', to: 'p2' })
    expect(calls).toEqual([
      'https://p1.example.com/v1/messages',
      'https://p2.example.com/v1/messages'
    ])
  })

  it('重试到上限后换下一个 provider', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      responses: [fail(503), fail(503), fail(503), ok(sseBody({ text: 'ok' }))]
    })
    const out = await drain(router)
    expect(out.filter((e) => e.type === 'provider_retry')).toHaveLength(2) // 3 次尝试 = 2 次重试
    expect(calls.filter((c) => c.includes('p1'))).toHaveLength(3)
    expect(out.at(-1)?.type).toBe('message_end')
  })

  /** 没有 provider_retry / provider_switch,用户看到的就是白白冻结几十秒(§4.2) */
  it('重试与切换都对外可见', async () => {
    const { router } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      responses: [fail(500), fail(500), fail(500), ok(sseBody({ text: 'ok' }))]
    })
    const kinds = (await drain(router)).map((e) => e.type)
    expect(kinds.slice(0, 3)).toEqual(['provider_retry', 'provider_retry', 'provider_switch'])
  })

  it('全部候选失败时给出最后的错误', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(400, 'invalid_request_error', '工具 schema 非法')]
    })
    const out = await drain(router)
    expect(out).toEqual([
      { type: 'error', error: { code: 'provider', message: '工具 schema 非法', retryable: false, status: 400 } }
    ])
  })

  /** auth 比「最后一个网络错误」更值得展示:它有明确的行动(去设置页) */
  it('候选中出现过 auth 时优先报 auth', async () => {
    const { router } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      keys: { 'ref:p1': null },
      responses: [fail(400, 'invalid_request_error', '后面这个错误不该盖住 auth')]
    })
    const out = await drain(router)
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'auth' } })
  })

  it('缺密钥的 provider 不发请求,直接切下一个', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      keys: { 'ref:p1': null },
      responses: [ok(sseBody({ text: 'from p2' }))]
    })
    expect((await drain(router)).at(-1)?.type).toBe('message_end')
    expect(calls).toEqual(['https://p2.example.com/v1/messages'])
  })

  it('尊重 Retry-After 而不是自己的退避表', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(429, 'rate_limit_error', 'slow', { 'retry-after': '0' }), ok(sseBody({ text: 'x' }))]
    })
    const out = await drain(router)
    // reason 带着上游原话 —— 状态行要靠它说明「为什么在等」,而不是只说「正在重试」
    expect(out).toContainEqual({ type: 'provider_retry', attempt: 1, delayMs: 0, reason: 'slow' })
  })

  it('限流没给 Retry-After 时,退避走秒级的那条路,不是 500ms 那张表', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      rateLimitFloorMs: 40,
      responses: [fail(429, 'rate_limit_error', 'quota'), ok(sseBody({ text: 'x' }))]
    })
    const out = await drain(router)
    // rig 的 baseDelayMs 是 0,所以这个 40 只可能来自限流专用的那条计算
    expect(out).toContainEqual({ type: 'provider_retry', attempt: 1, delayMs: 40, reason: 'quota' })
    expect(out.at(-1)?.type).toBe('message_end')
  })

  it('一条流吃到限流,同一个路由器上的其它流在发请求之前就被挡住', async () => {
    const { router, calls } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      // 旁路模式(出厂默认):候选不做健康过滤,于是这里量的确实是闸门本身,
      // 而不是「连挂三次被判不健康」那条另一码事的路径
      failover: false,
      rateLimitFloorMs: 20,
      responses: [
        fail(429, 'rate_limit_error', 'quota'),
        fail(429, 'rate_limit_error', 'quota'),
        fail(429, 'rate_limit_error', 'quota'),
        ok(sseBody({ text: 'x' }))
      ]
    })
    // 第一条流把三次机会用光,并留下闸门(假时钟不推进,所以它必然还没到期)
    expect((await drain(router)).at(-1)).toMatchObject({ type: 'error', error: { code: 'rate_limit' } })
    expect(calls).toHaveLength(3)

    const second = await drain(router)
    /*
      ★ 断言的是**第一个**事件:第二条流一个请求都还没发就先等 ——
      并发子代理互相把配额打光,靠的正是这一下拦截,而不是各自事后重试。
    */
    expect(second[0]).toMatchObject({ type: 'provider_retry', reason: 'quota' })
    expect(calls).toHaveLength(4)
    expect(second.at(-1)?.type).toBe('message_end')
  })

  it('fetch 抛出被归一化成可重试的 network 错误', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [new Error('ECONNREFUSED'), ok(sseBody({ text: 'x' }))]
    })
    const out = await drain(router)
    expect(out.some((e) => e.type === 'provider_retry')).toBe(true)
    expect(out.at(-1)?.type).toBe('message_end')
  })

  it('OpenAI Chat 发送真实请求并解码响应', async () => {
    const { router, calls, bodies, headers, usageRecords } = rig({
      providers: [provider('p1', { protocol: 'openai-chat' })],
      aliases: [alias('m', 'p1')],
      responses: [ok('data: {"model":"m-up","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]
    })
    const out = await drain(router)
    expect(out.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
    expect(calls).toEqual(['https://p1.example.com/chat/completions'])
    expect(headers[0]).toMatchObject({ authorization: 'Bearer sk-test' })
    expect(headers[0]).not.toHaveProperty('x-api-key')
    expect(bodies[0]).not.toHaveProperty('metadata')
    expect(bodies[0]).not.toHaveProperty('cache_control')
    expect(usageRecords[0]).toMatchObject({ protocol: 'openai-chat', endpoint: calls[0], ok: true })
  })
})

describe('UpstreamRouter · Anthropic 缓存兼容性错误', () => {
  it('明确拒绝 cache_control 时只发一次请求，不重试、不切换且不记健康失败', async () => {
    const { router, calls, bodies } = rig({
      providers: [
        provider('p1', {
          name: 'Relay A',
          priority: 0,
          protocolOptions: { anthropic: { cacheTtl: '5m' } }
        }),
        provider('p2', {
          name: 'Relay B',
          priority: 1,
          protocolOptions: { anthropic: { cacheTtl: '1h' } }
        })
      ],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      responses: [fail(400, 'invalid_request_error', 'cache_control is not supported')]
    })
    const out = await drain(router)
    expect(calls).toHaveLength(1)
    expect(bodies).toHaveLength(1)
    expect(out.filter((e) => e.type === 'provider_retry')).toEqual([])
    expect(out.filter((e) => e.type === 'provider_switch')).toEqual([])
    expect(out.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'cache_unsupported', retryable: false, status: 400 }
    })
    expect((out.at(-1) as { error: { message: string } }).error.message).toContain('Relay A')
    expect((out.at(-1) as { error: { message: string } }).error.message).toContain('5 分钟')
    expect(router.health()).toEqual([])
  })

  it('空或超长 workspaceId 在读取密钥和发出 HTTP 前失败', async () => {
    const { router, calls, secretReads } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: []
    })
    for (const workspaceId of ['', '   ', 'x'.repeat(513)]) {
      const out = await drainWithContext(router, { workspaceId })
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ type: 'error', error: { retryable: false } })
    }
    expect(calls).toEqual([])
    expect(secretReads).toEqual([])
  })

  it('畸形运行时 context 不会抛异常或访问 Provider', async () => {
    const { router, calls, secretReads } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: []
    })
    const out: ProviderStreamEvent[] = []
    for await (const ev of router.stream(
      REQ,
      new AbortController().signal,
      undefined as unknown as { workspaceId: string }
    )) out.push(ev)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'error', error: { retryable: false } })
    expect(calls).toEqual([])
    expect(secretReads).toEqual([])
  })
})

describe('UpstreamRouter · 旁路模式(failover: off)', () => {
  /** 直取会话指定的 provider,不做健康评分、不做切换 —— 延迟最低、路径最短(§5.6) */
  it('失败也不切换到第二个 provider', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      failover: false,
      responses: [fail(400, 'invalid_request_error', 'nope')]
    })
    const out = await drain(router)
    expect(out.some((e) => e.type === 'provider_switch')).toBe(false)
    expect(calls.every((c) => c.includes('p1'))).toBe(true)
  })

  it('不健康的 provider 在旁路模式下仍被使用', async () => {
    const { router, calls } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      failover: false,
      responses: [fail(500), fail(500), fail(500), ok(sseBody({ text: 'x' }))]
    })
    await drain(router) // 打到不健康
    expect(router.health()[0]?.healthy).toBe(false)
    await drain(router) // 仍然会用它
    expect(calls.at(-1)).toContain('p1')
  })
})

describe('UpstreamRouter · 健康评分与冷却', () => {
  it('连续失败达阈值 → 不健康 + 冷却', async () => {
    const { router, now } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(500), fail(500), fail(500)]
    })
    await drain(router)
    const h = router.health()[0]
    expect(h).toMatchObject({ healthy: false, consecutiveFailures: 3 })
    expect(h?.cooldownUntil).toBeGreaterThan(now.t)
    expect(h?.score).toBeLessThan(0.2)
  })

  it('冷却中的 provider 被移出候选集 → no_healthy_provider', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(500), fail(500), fail(500)]
    })
    await drain(router)
    const out = await drain(router)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'error', error: { code: 'no_healthy_provider' } })
  })

  it('冷却到期后自动重新纳入候选', async () => {
    const { router, now } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(500), fail(500), fail(500), ok(sseBody({ text: '回来了' }))]
    })
    await drain(router)
    now.t += 31_000
    expect((await drain(router)).at(-1)?.type).toBe('message_end')
  })

  it('resetHealth 立刻解除冷却', async () => {
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [fail(500), fail(500), fail(500), ok(sseBody({ text: 'x' }))]
    })
    await drain(router)
    router.resetHealth('p1')
    expect(router.health()).toEqual([])
    expect((await drain(router)).at(-1)?.type).toBe('message_end')
  })

  /** 优先级是用户的显式意图,不该被健康评分推翻 */
  it('健康度只在同优先级内部排序', async () => {
    const { router, calls } = rig({
      providers: [provider('p1', { priority: 0 }), provider('p2', { priority: 1 })],
      aliases: [alias('m', 'p1'), alias('m', 'p2')],
      responses: [fail(500), ok(sseBody({ text: 'x' })), ok(sseBody({ text: 'y' }))]
    })
    await drain(router) // p1 挂一次(分数掉一半)但没到冷却阈值
    await drain(router)
    // 第二轮仍从 p1 开始 —— 优先级压过分数
    expect(calls.at(-1)).toContain('p1')
  })
})

describe('UpstreamRouter · 没有候选', () => {
  it('别名未配置', async () => {
    const { router } = rig({ providers: [provider('p1')], aliases: [], responses: [] })
    const out = await drain(router)
    expect(out[0]).toMatchObject({ type: 'error', error: { code: 'no_healthy_provider' } })
    expect((out[0] as { error: { message: string } }).error.message).toContain('m')
  })

  it('provider 全部停用', async () => {
    const { router } = rig({
      providers: [provider('p1', { enabled: false })],
      aliases: [alias('m', 'p1')],
      responses: []
    })
    expect((await drain(router))[0]).toMatchObject({ error: { code: 'no_healthy_provider' } })
  })
})

describe('UpstreamRouter · 中断', () => {
  /** 中断必须原样抛出,不能被归一化成一个「网络错误」—— 那会让 UI 弹一个假的失败提示 */
  it('中断抛出而不是变成 error 事件', async () => {
    const ac = new AbortController()
    const { router } = rig({
      providers: [provider('p1')],
      aliases: [alias('m', 'p1')],
      responses: [
        () => {
          ac.abort()
          return ok(sseBody({ text: 'x' }))
        }
      ]
    })
    await expect(drain(router, ac.signal)).rejects.toThrow(/abort/i)
  })
})

describe('parseRetryAfter', () => {
  it('秒数', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000)
    expect(parseRetryAfter('0', 0)).toBe(0)
  })
  it('HTTP 日期', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000)
  })
  it('过去的日期归零而不是负数', () => {
    const now = Date.parse('2026-01-01T00:01:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0)
  })
  /** 上游给一个离谱的 Retry-After 时不能真的挂在那里等一小时 */
  it('封顶 60 秒', () => {
    expect(parseRetryAfter('99999', 0)).toBe(60_000)
  })
  it('缺失或无法解析时返回 undefined', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('  ', 0)).toBeUndefined()
    expect(parseRetryAfter('soon', 0)).toBeUndefined()
  })
})

/**
 * 用户报的原始场景:RoutinAI(priority 0)和 Codex(priority 10)都提供
 * `gpt-5.6-sol`,他在药丸里选了 Codex,请求却发给了 RoutinAI。
 */
describe('显式选定供应商后锁死', () => {
  const twoHouses = {
    providers: [provider('routin'), provider('codex', { priority: 10 })],
    aliases: [alias('m', 'routin'), alias('m', 'codex')]
  }

  it('不指定时仍按 priority 择优 —— 老行为逐字保留', async () => {
    const r = rig({ ...twoHouses, responses: [ok(sseBody({ text: 'hi' }))] })
    await drainRequest(r.router, REQ)
    expect(r.calls[0]).toContain('routin.example.com')
  })

  it('指定 priority 更大的那家时发给它,而不是被优先级推翻', async () => {
    const r = rig({ ...twoHouses, responses: [ok(sseBody({ text: 'hi' }))] })
    await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(r.calls).toEqual(['https://codex.example.com/v1/messages'])
  })

  /**
   * ★ 出厂就是这条路径(`gateway.failover` 默认 false),也就是用户实际撞上的那条。
   * 旁路模式下 `candidates()` 直接 `slice(0, 1)`,provider 过滤必须在它之前发生。
   */
  it('故障切换关闭时也照样锁死,不退回优先级最高的那家', async () => {
    const r = rig({ ...twoHouses, failover: false, responses: [ok(sseBody({ text: 'hi' }))] })
    await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(r.calls).toEqual(['https://codex.example.com/v1/messages'])
  })

  it('选定的那家连挂三次:重试全在它身上,绝不切到同名的另一家', async () => {
    const r = rig({ ...twoHouses, responses: [fail(503), fail(503), fail(503)] })
    const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(r.calls).toEqual(Array(3).fill('https://codex.example.com/v1/messages'))
    expect(output.filter((e) => e.type === 'provider_switch')).toHaveLength(0)
    expect(output.at(-1)).toMatchObject({ type: 'error' })
  })

  /**
   * 冷却是用来「绕开一家坏的」的,锁死之后无处可绕。此时还过滤掉唯一那条候选,
   * 用户会收到「所有供应商都在冷却中」,而他明明只选了一家、界面上也没有重试入口。
   */
  it('选定的那家在冷却中仍然发请求,而不是报「所有供应商都在冷却中」', async () => {
    const r = rig({ ...twoHouses,
      responses: [fail(503), fail(503), fail(503), ok(sseBody({ text: 'hi' }))] })
    await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(r.router.health().find((h) => h.providerId === 'codex')?.cooldownUntil).toBeGreaterThan(r.now.t)
    const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(r.calls).toHaveLength(4)
    expect(output.at(-1)).toMatchObject({ type: 'message_end' })
  })

  it('message_start 带上实际给出这段回复的那家', async () => {
    const r = rig({ ...twoHouses, responses: [ok(sseBody({ text: 'hi' }))] })
    const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
    expect(output.find((e) => e.type === 'message_start'))
      .toMatchObject({ type: 'message_start', providerId: 'codex' })
  })

  it('未锁定而真的切了家时,message_start 报的是接手的那家,不是优先级最高的那家', async () => {
    const r = rig({ ...twoHouses,
      responses: [fail(503), fail(503), fail(503), ok(sseBody({ text: 'hi' }))] })
    const output = await drainRequest(r.router, REQ)
    expect(output.filter((e) => e.type === 'message_start'))
      .toEqual([expect.objectContaining({ providerId: 'codex' })])
  })

  describe('选定的那家用不了时,错误要指名道姓', () => {
    it('那家已被删除', async () => {
      const r = rig({ ...twoHouses, responses: [] })
      const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'gone' })
      expect(output.at(-1)).toMatchObject({ type: 'error', error: {
        code: 'no_healthy_provider', retryable: false,
        messageKey: 'agent.error.pinnedProviderMissing'
      } })
    })

    it('那家已停用 —— 不静默走另一家', async () => {
      const r = rig({
        providers: [provider('routin'), provider('codex', { priority: 10, enabled: false })],
        aliases: twoHouses.aliases, responses: []
      })
      const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
      expect(output.at(-1)).toMatchObject({ type: 'error', error: {
        code: 'no_healthy_provider', retryable: false,
        messageKey: 'agent.error.pinnedProviderDisabled', messageParams: { provider: 'codex', model: 'm' }
      } })
    })

    it('那家下已经没有这个别名', async () => {
      const r = rig({ ...twoHouses, aliases: [alias('m', 'routin')], responses: [] })
      const output = await drainRequest(r.router, { ...REQ, modelProviderId: 'codex' })
      expect(output.at(-1)).toMatchObject({ type: 'error', error: {
        code: 'no_healthy_provider', retryable: false,
        messageKey: 'agent.error.pinnedModelMissing'
      } })
    })
  })
})
