import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../shared/agent/event'
import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { userMessage } from '../../../../shared/agent/message'
import type { RunRequest } from '../../../../shared/agent/run-request'
import type { ProviderStreamEvent } from '../../../../shared/agent/stream'
import { toolOk } from '../../../../shared/agent/tool'
import { isAbortError } from '../../abort'
import { AgentSession } from '../../agent-session'
import { collect, RunHandle } from '../../run-registry'
import { ToolRegistry } from '../../tool/registry'
import type { CanonicalRequest } from '../canonical'
import {
  DEMO_ALIAS,
  DEMO_ALIASES,
  DEMO_API_KEY,
  DEMO_CREDENTIAL_REF,
  DEMO_MODEL,
  DEMO_PROVIDER,
  demoFetch,
  demoHost,
  planDemoReply,
  renderDemoSse,
  validateAnthropicRequest,
  withDemoUpstream
} from '../demo'
import { UpstreamRouter } from '../router'

// ─────────────────────────── 夹具 ───────────────────────────

/** 测试里不等待分片间隔;分片大小刻意小,好让每个事件都跨块 */
const FAST = { chunkDelayMs: 0, chunkBytes: 16 }

function quiet(): Parameters<typeof demoHost>[0] {
  return { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
}

function router(over: { failover?: boolean; enabled?: boolean } = {}): UpstreamRouter {
  return new UpstreamRouter(demoHost(quiet(), FAST), {
    providers: () => [{ ...DEMO_PROVIDER, enabled: over.enabled ?? true }],
    aliases: () => DEMO_ALIASES,
    failoverEnabled: () => over.failover ?? false
  })
}

function creq(over: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: DEMO_ALIAS,
    system: '你是 NextCoWork 的演示助手。',
    messages: [userMessage('m1', [{ type: 'text', text: '你好,世界' }], 0)],
    tools: [],
    maxOutputTokens: 4096,
    ...over
  }
}

async function streamAll(
  r: UpstreamRouter,
  req: CanonicalRequest,
  signal: AbortSignal = new AbortController().signal
): Promise<ProviderStreamEvent[]> {
  // 显式标注:`const out = []` 的渐进推断挺不过一次 `for await` 的 push,会停在 never[]
  const out: ProviderStreamEvent[] = []
  for await (const ev of r.stream(req, signal, { workspaceId: 'ws-test' })) out.push(ev)
  return out
}

const textOf = (events: ProviderStreamEvent[]): string =>
  events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')

const kinds = (events: ProviderStreamEvent[]): string[] => events.map((e) => e.type)

/** 一个最小可用的工具:回显入参 */
function echoRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register({
    internalId: 'echo',
    description: '把入参原样回显',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    readOnly: true,
    destructive: false,
    needsNetwork: false,
    source: { kind: 'builtin' },
    execute: (input) => Promise.resolve(toolOk(`echo: ${JSON.stringify(input)}`))
  })
  return reg
}

/** 合法请求的最小体,给校验测试当基线 —— 每条测试只坏掉其中一处 */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: DEMO_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    stream: true,
    ...over
  }
}

// ─────────────────────────── 校验 ───────────────────────────

describe('校验:演示上游和真上游一样挑剔', () => {
  it('合法请求放行', () => {
    expect(validateAnthropicRequest(body())).toBeNull()
  })

  /**
   * ★★ 这条是内置演示上游存在的最大理由(方案 §4.8)。
   *
   * 中断收尾漏掉 tool_result 补偿时,真 Anthropic 给的 400 会指向消息数组,
   * 读起来像 adapter 的 bug,而起因在几百行外的 abort 路径上 ——
   * 「手写 Agent 循环最常见的自伤」。演示上游让它在 dev 的第一秒就现形。
   */
  it('孤儿 tool_use —— 下一条消息里没有配对的 tool_result', () => {
    const err = validateAnthropicRequest(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '查一下' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'echo', input: {} }] },
          { role: 'user', content: [{ type: 'text', text: '继续' }] }
        ]
      })
    )
    expect(err?.status).toBe(400)
    expect(err?.message).toContain('c1')
    expect(err?.message).toContain('tool_result')
  })

  it('最后一条消息里悬着的 tool_use 也算孤儿', () => {
    const err = validateAnthropicRequest(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '查一下' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c9', name: 'echo', input: {} }] }
        ]
      })
    )
    expect(err?.message).toContain('c9')
  })

  it('无主 tool_result —— 上一条消息里没有对应的 tool_use', () => {
    const err = validateAnthropicRequest(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '你好' }] },
          { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: '?' }] }
        ]
      })
    )
    expect(err?.message).toContain('ghost')
  })

  it('配对齐全就放行', () => {
    expect(
      validateAnthropicRequest(
        body({
          tools: [{ name: 'echo', input_schema: { type: 'object' } }],
          messages: [
            { role: 'user', content: [{ type: 'text', text: '查一下' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'c1', name: 'echo', input: {} }]
            },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }
          ]
        })
      )
    ).toBeNull()
  })

  it('空 text 块被拒', () => {
    const err = validateAnthropicRequest(
      body({ messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] })
    )
    expect(err?.message).toContain('不能为空')
  })

  it('空 content 被拒', () => {
    expect(
      validateAnthropicRequest(body({ messages: [{ role: 'user', content: [] }] }))?.message
    ).toContain('content 不能为空')
  })

  /** `toBlock` 宁可整块丢掉也不带假签名 —— 这条守着那个选择 */
  it('没有 signature 的 thinking 块被拒', () => {
    const err = validateAnthropicRequest(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '嗨' }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: '想了想', signature: '' }] },
          { role: 'user', content: [{ type: 'text', text: '继续' }] }
        ]
      })
    )
    expect(err?.message).toContain('signature')
  })

  /** `toAnthropicMessages` 的合并逻辑的看门人 */
  it('相邻同角色消息被拒', () => {
    const err = validateAnthropicRequest(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'user', content: [{ type: 'text', text: 'b' }] }
        ]
      })
    )
    expect(err?.message).toContain('交替')
  })

  it('第一条不是 user 被拒', () => {
    expect(
      validateAnthropicRequest(
        body({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }] })
      )?.message
    ).toContain('第一条必须是 user')
  })

  /** `encodeAnthropic` 里那段抬高 max_tokens 的代码的看门人 */
  it('max_tokens 不大于 thinking 预算被拒', () => {
    const err = validateAnthropicRequest(
      body({ max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 } })
    )
    expect(err?.message).toContain('max_tokens')
  })

  it('显式关闭不要求预算，也不生成演示思考块', () => {
    const request = body({ thinking: { type: 'disabled' } })
    expect(validateAnthropicRequest(request)).toBeNull()
    expect(planDemoReply(request, 1).blocks.some((block) => block.kind === 'thinking')).toBe(false)
  })

  it('工具名超出 ^[a-zA-Z0-9_-]{1,64}$ 被拒', () => {
    const long = `mcp__${'x'.repeat(70)}`
    expect(validateAnthropicRequest(body({ tools: [{ name: long, input_schema: {} }] }))?.message)
      .toContain('a-zA-Z0-9_-')
  })

  it('调用了没下发的工具被拒', () => {
    const err = validateAnthropicRequest(
      body({
        tools: [{ name: 'echo', input_schema: {} }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'c1', name: 'not_advertised', input: {} }]
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }
        ]
      })
    )
    expect(err?.message).toContain('not_advertised')
  })
})

// ─────────────────────────── 假网络,真 SSE ───────────────────────────

describe('假网络,真 SSE', () => {
  it('端到端拿到归一化事件', async () => {
    const events = await streamAll(router(), creq())
    expect(kinds(events)[0]).toBe('message_start')
    expect(kinds(events).at(-1)).toBe('message_end')
    expect(textOf(events)).toContain('演示上游')
    // 文本是**分多次**到的 —— 一次性发完的话,dev 里就看不到「流式文字滚动」这件事
    expect(events.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(1)
  })

  /**
   * ★ 经 router 走的时候 alias 的 upstreamModel 恰好就是 `DEMO_MODEL`,所以
   * 「断言 message_start.model === DEMO_MODEL」是个**空断言** —— 演示上游把模型名
   * 写死成常量也照样通过。这里直接打 fetch,喂一个别的模型名进去。
   */
  it('message_start 回的是请求里的模型名,不是写死的常量', async () => {
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body({ model: '另一个模型' }))
    })
    expect(await res.text()).toContain('"model":"另一个模型"')
  })

  it('usage 活着穿过了 decode', async () => {
    const events = await streamAll(router(), creq())
    const end = events.at(-1)
    expect(end?.type === 'message_end' && end.usage.inputTokens).toBeGreaterThan(0)
    expect(end?.type === 'message_end' && end.usage.outputTokens).toBeGreaterThan(0)
  })

  /**
   * ★ 演示上游按**字节**切片,于是一个 3 字节的中文字符必然横跨两块。
   *
   * 这条测试先证明危险是真的(逐块 toString 会产生 U+FFFD),
   * 下一条再证明流水线不受影响。`sse.ts` 说这个 bug「本机低延迟时永远复现不了」——
   * 演示上游让它每次 dev 都必然发生,所以它必须先在这里被钉死。
   */
  it('分片确实劈开了多字节字符 —— 逐块 toString 会看到 U+FFFD', () => {
    const sse = renderDemoSse(
      { blocks: [{ kind: 'text', text: '中文中文中文中文' }], stopReason: 'end_turn' },
      DEMO_MODEL,
      10
    )
    const bytes = new TextEncoder().encode(sse)
    expect(bytes.length).toBeGreaterThan(FAST.chunkBytes)

    let naive = ''
    for (let i = 0; i < bytes.length; i += FAST.chunkBytes) {
      naive += Buffer.from(bytes.slice(i, i + FAST.chunkBytes)).toString('utf8')
    }
    expect(naive).toContain('�')
  })

  it('而流水线出来的中文一个字都不少', async () => {
    const events = await streamAll(router(), creq())
    expect(textOf(events)).not.toContain('�')
    expect(textOf(events)).toContain('这条回复没有经过任何网络')
  })

  /** ★ 先证明 ping 真的发了出去 —— 否则「事件流里没有 ping」是个**不发就能通过**的空断言 */
  it('心跳 ping 确实在字节流里,却不混进事件流', async () => {
    const sse = renderDemoSse(
      { blocks: [{ kind: 'text', text: '嗨' }], stopReason: 'end_turn' },
      DEMO_MODEL,
      1
    )
    expect(sse).toContain('event: ping')

    const events = await streamAll(router(), creq())
    expect(kinds(events)).not.toContain('ping')
  })
})

// ─────────────────────────── 工具调用 ───────────────────────────

describe('工具调用', () => {
  const withTool = (): CanonicalRequest =>
    creq({
      tools: [
        {
          internalId: 'echo',
          externalName: 'echo',
          description: '回显',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          readOnly: true,
          destructive: false,
          needsNetwork: false,
          source: { kind: 'builtin' }
        }
      ]
    })

  it('下发了工具就会调它,并以 tool_use 收尾', async () => {
    const events = await streamAll(router(), withTool())
    expect(kinds(events)).toContain('tool_call_start')
    expect(kinds(events)).toContain('tool_call_end')
    const end = events.at(-1)
    expect(end?.type === 'message_end' && end.stopReason).toBe('tool_use')
  })

  /**
   * ★ 入参 JSON 被切成多片,**每一片单独看都是非法 JSON**。
   *
   * 这正是「只在 tool_call_end 时 parse 一次」那条规则的由来(方案 §4.2)。
   * 不切碎的话,一个在每个 delta 上就 parse 的实现能一路绿灯到线上。
   */
  it('入参 JSON 被切碎:单片非法,合起来合法', async () => {
    const events = await streamAll(router(), withTool())
    const deltas = events.flatMap((e) => (e.type === 'tool_call_delta' ? [e.argsDelta] : []))
    expect(deltas.length).toBeGreaterThan(1)
    // 至少有一片自己 parse 不出来 —— 否则这条测试什么都没证明
    expect(deltas.some((d) => !isJson(d))).toBe(true)
    expect(JSON.parse(deltas.join(''))).toEqual({ message: '演示值:message' })
  })

  it('tool_call_start / delta / end 用的是同一个 callId', async () => {
    const events = await streamAll(router(), withTool())
    const ids = new Set(
      events.flatMap((e) =>
        e.type === 'tool_call_start' || e.type === 'tool_call_delta' || e.type === 'tool_call_end'
          ? [e.callId]
          : []
      )
    )
    expect(ids.size).toBe(1)
  })

  /** 文本块在前、工具块在后,两个块共存于一条消息 —— `index` 存在的理由 */
  it('一条消息里同时有文本块和工具块,index 各自独立', async () => {
    const events = await streamAll(router(), withTool())
    const textIdx = events.find((e) => e.type === 'text_delta')
    const callIdx = events.find((e) => e.type === 'tool_call_start')
    expect(textIdx?.type === 'text_delta' && textIdx.index).toBe(0)
    expect(callIdx?.type === 'tool_call_start' && callIdx.index).toBe(1)
  })
})

function isJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────── thinking 往返 ───────────────────────────

describe('thinking 的签名往返', () => {
  it('签名分片累积成一个 block_opaque', async () => {
    const events = await streamAll(router(), creq({ thinkingBudget: 2048 }))
    expect(kinds(events)).toContain('thinking_delta')
    const opaque = events.find((e) => e.type === 'block_opaque')
    expect(opaque?.type === 'block_opaque' && opaque.opaque).toEqual({
      signature: 'demo-signature-1'
    })
  })

  /** ★ 签名必须分两帧发。只发一帧的话,decode 侧那段累加逻辑等于没测。 */
  it('签名分成两帧发出', () => {
    const sse = renderDemoSse(
      { blocks: [{ kind: 'thinking', text: '想', signature: 'abcdef' }], stopReason: 'end_turn' },
      DEMO_MODEL,
      1
    )
    expect(sse.split('signature_delta').length - 1).toBe(2)
  })

  it('thinking 开着时 max_tokens 会被抬到预算之上 —— 否则这一轮直接 400', async () => {
    // maxOutputTokens 故意设得比预算小,交给 encodeAnthropic 去修
    const events = await streamAll(router(), creq({ thinkingBudget: 4096, maxOutputTokens: 1024 }))
    expect(kinds(events)).not.toContain('error')
  })
})

// ─────────────────────────── HTTP 层的挑剔 ───────────────────────────

describe('HTTP 层', () => {
  it('缺 x-api-key 是 401,被分类成 auth —— UI 据此跳设置页', async () => {
    // demoHost 只为演示 ref 供值;换一个查不到的 ref,router 自己就先拦下了,
    // 所以这里直接打 fetch,验的是演示上游而不是 router
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body())
    })
    expect(res.status).toBe(401)
  })

  it('缺 anthropic-version 是 400', async () => {
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k' },
      body: JSON.stringify(body())
    })
    expect(res.status).toBe(400)
  })

  /**
   * `demoHost` 只对**演示那一个 ref** 供常量值。
   * 一个同时配了演示上游和真上游的 dev 环境,不该被这层包装弄坏。
   */
  it('demoHost 只劫持演示那一个 ref,其余照旧走底层实现', async () => {
    const host = demoHost(
      {
        ...quiet(),
        secrets: {
          get: (ref) => Promise.resolve(`真实凭证:${ref}`),
          set: () => Promise.resolve(),
          available: () => true
        }
      },
      FAST
    )
    expect(await host.secrets.get(DEMO_CREDENTIAL_REF)).toBe(DEMO_API_KEY)
    expect(await host.secrets.get('anthropic:default')).toBe('真实凭证:anthropic:default')
  })

  it('路径拼错是 404,而且话说得清楚', async () => {
    const res = await demoFetch(FAST)('https://demo.invalid/v1beta/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body())
    })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toContain('/v1/messages')
  })

  it('GET 是 405', async () => {
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages')
    expect(res.status).toBe(405)
  })

  it('非法 JSON 体是 400', async () => {
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: '{ 不是 json'
    })
    expect(res.status).toBe(400)
  })

  it('400 经 router 变成不可重试的 provider 错误,不会白白重试三次', async () => {
    const r = router()
    // 空 text 的消息:encodeAnthropic 会把它整块丢掉,于是 content 为空 → 400
    const events = await streamAll(r, creq({ messages: [userMessage('m1', [], 0)] }))
    const err = events.at(-1)
    expect(err?.type === 'error' && err.error.code).toBe('provider')
    expect(kinds(events)).not.toContain('provider_retry')
  })

  it('供应商停用时给的是 no_healthy_provider,不是一个网络错误', async () => {
    const events = await streamAll(router({ enabled: false }), creq())
    const err = events.at(-1)
    expect(err?.type === 'error' && err.error.code).toBe('no_healthy_provider')
  })
})

// ────────────────── 演示上游怎么挂到真 host 上 ──────────────────

/**
 * `withDemoUpstream` 是**生产**路径上的挂载点(`electronHost()` 与 runtime 的默认 host
 * 都经 `withDemo` 用它),所以它挂错的后果不是「演示不好使」,而是
 * **真上游收不到真请求**。这一组测的就是这条分界线。
 */
describe('withDemoUpstream:按主机名分派', () => {
  it('★ 非演示的 URL 落到真 fetch 上 —— 这是安全相关的那个方向', async () => {
    const seen: string[] = []
    const real: typeof fetch = (input) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('真上游', { status: 200 }))
    }

    const res = await withDemoUpstream(real, FAST)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body())
    })

    // 若这层包装按一个全局「演示模式」布尔分派,真上游就会收到假回复 ——
    // 症状是填了真 key 也永远拿不到真答案,而 UI 上一切正常。
    expect(seen).toEqual(['https://api.anthropic.com/v1/messages'])
    expect(await res.text()).toBe('真上游')
  })

  it('演示的 URL 由演示上游接管,一个字节都不出网', async () => {
    let realCalls = 0
    const real: typeof fetch = () => {
      realCalls++
      return Promise.reject(new Error('不该走到这里'))
    }

    const res = await withDemoUpstream(real, FAST)(`${DEMO_PROVIDER.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': DEMO_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body())
    })

    expect(realCalls).toBe(0)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('三种 fetch 入参形态(string / URL / Request)都认得出演示主机', async () => {
    const real: typeof fetch = () => Promise.resolve(new Response('真上游'))
    const dispatch = withDemoUpstream(real, FAST)
    const url = `${DEMO_PROVIDER.baseUrl}/v1/messages`
    const init = {
      method: 'POST',
      headers: { 'x-api-key': DEMO_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body())
    }

    // Request 那一路最容易被漏掉:`input instanceof URL` 为假,`typeof input === 'string'`
    // 也为假,于是一个只写了两种形态的实现会把它整个漏给真 fetch。
    for (const input of [url, new URL(url), new Request(url, init)] as const) {
      const res = await dispatch(input, init)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
    }
  })

  it('拼坏的 URL 交给真 fetch 去报错,而不是被演示上游默默吃掉', async () => {
    let realCalls = 0
    const real: typeof fetch = () => {
      realCalls++
      return Promise.resolve(new Response('真上游'))
    }
    await withDemoUpstream(real, FAST)('这不是一个 URL')
    expect(realCalls).toBe(1)
  })
})

// ─────────────────────────── 中断 ───────────────────────────

describe('中断', () => {
  it('已经中断的 signal 直接抛,不发请求', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      demoFetch(FAST)('https://demo.invalid/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body()),
        signal: ac.signal
      })
    ).rejects.toThrow(/abort/i)
  })

  /**
   * ★ 分片**之间**中断,抛出来的必须是一个 `isAbortError` 认得的东西。
   *
   * 下面那条「读到一半中断」测的其实是另一条路径:它带着 `chunkDelayMs: 5`,
   * 中断落在 `abortableSleep` 里,于是 reject 是 sleep 给的。
   * `pull` 开头那句自己的 `throw` 反而没人看着 —— 而它一旦写成
   * `new Error('中断')`,`isAbortError` 就认不出来,用户点了停止却收到一个
   * 假的「网络错误」。所以这里把延迟设成 0,逼中断落在那句 throw 上。
   */
  it('分片之间中断,抛的是 isAbortError 认得的错', async () => {
    const ac = new AbortController()
    const res = await demoFetch(FAST)('https://demo.invalid/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body()),
      signal: ac.signal
    })
    const stream = res.body
    if (stream === null) throw new Error('演示上游没有给出流')

    const reader = stream.getReader()
    await reader.read()
    ac.abort()

    let thrown: unknown
    try {
      // 队列里可能还压着一两片已经拉出来的数据,读到抛为止(读完就说明没抛,断言会失败)
      for (let i = 0; i < 50; i++) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch (e) {
      thrown = e
    }
    expect(isAbortError(thrown)).toBe(true)
  })

  /**
   * ★ 流**中途**中断。分片是 pull 驱动的,所以这条走的是
   * 「已经建好连接、正在读」那条路径 —— 也就是用户点停止时的真实路径。
   */
  it('读到一半中断,抛 AbortError 而不是静默截断', async () => {
    const ac = new AbortController()
    const r = new UpstreamRouter(demoHost(quiet(), { chunkDelayMs: 5, chunkBytes: 16 }), {
      providers: () => [DEMO_PROVIDER],
      aliases: () => DEMO_ALIASES,
      failoverEnabled: () => false
    })

    const seen: ProviderStreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of r.stream(creq(), ac.signal, { workspaceId: 'ws-test' })) {
          seen.push(ev)
          if (seen.length === 3) ac.abort()
        }
      })()
    ).rejects.toThrow(/abort/i)

    // 中断前收到的事件是真的 —— 不是「什么都没发生」
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })
})

// ─────────────────────────── 剧本 ───────────────────────────

describe('剧本不会撞上 MAX_TURNS', () => {
  it('上一条消息里有 tool_result 就收工', () => {
    const reply = planDemoReply(
      body({
        tools: [{ name: 'echo', input_schema: {} }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'echo', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '结果' }] }
        ]
      }),
      1
    )
    expect(reply.stopReason).toBe('end_turn')
    expect(reply.blocks.every((b) => b.kind !== 'tool_use')).toBe(true)
  })

  it('没有工具可用时不会硬编一个工具调用', () => {
    expect(planDemoReply(body(), 1).stopReason).toBe('end_turn')
  })
})

// ─────────────────────────── 接进 AgentSession ───────────────────────────

/**
 * ★★ 这一段是「换掉假发射器」的验收(方案实施顺序步骤 4)。
 *
 * 上面每一条测的都是链路上的一段;这里跑的是整条:
 * ContextAssembler → encodeAnthropic → 假网络 → SseParser → decodeAnthropic
 * → UpstreamRouter → AgentSession 的 think→tool→observe 循环 → ToolRegistry。
 * 全程零 mock、零打桩 —— 唯一不真的东西是那根网线。
 */
describe('接进 AgentSession,真的走完一整轮', () => {
  async function run(over: Partial<RunRequest> = {}): Promise<{
    events: AgentEvent[]
    history: readonly AgentMessage[]
  }> {
    const request: RunRequest = {
      runId: 'run-demo',
      sessionId: 'sess-demo',
      workspaceId: 'ws-1',
      depth: 0,
      input: [{ type: 'text', text: '帮我试试工具' }],
      mode: 'normal',
      thinking: 'off',
      webSearch: false,
      permissionMode: 'ask',
      model: DEMO_ALIAS,
      skillIds: [],
      ...over
    }
    const handle = new RunHandle(request)
    const session = new AgentSession(
      {
        host: demoHost(quiet(), FAST),
        upstream: router(),
        tools: echoRegistry(),
        workspaceRoot: '/ws'
      },
      handle,
      request
    )
    const events = collect(handle)
    await session.run()
    return { events: await events, history: session.history }
  }

  it('两轮跑完:调工具 → 拿到结果 → 收尾', async () => {
    const { events, history } = await run()

    const end = events.at(-1)
    expect(end?.type === 'run_end' && end.status).toBe('done')
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('转录里每个 tool_call 都有配对的 tool_result', async () => {
    const { history } = await run()
    const parts: ContentPart[] = history.flatMap((m) => m.parts)
    const opened = parts.flatMap((p) => (p.type === 'tool_call' ? [p.callId] : []))
    const closed = new Set(parts.flatMap((p) => (p.type === 'tool_result' ? [p.callId] : [])))
    expect(opened.length).toBe(1)
    expect(opened.filter((c) => !closed.has(c))).toEqual([])
  })

  it('工具真的被执行了,结果回到了转录里', async () => {
    const { history } = await run()
    const result = history
      .flatMap((m) => m.parts)
      .find((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result')
    expect(result?.isError).toBe(false)
    expect(result?.output.content).toContain('echo:')
    expect(result?.output.content).toContain('演示值:message')
  })

  it('第二轮把工具结果读回来了 —— 证明上行的消息数组是合法的', async () => {
    const { history } = await run()
    const last = history.at(-1)
    const text = last?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('') ?? ''
    expect(text).toContain('工具回来了')
    expect(text).toContain('echo:')
  })

  it('UI 拿得到 tool_start / tool_end,而且用的是 externalName', async () => {
    const { events } = await run()
    const start = events.find((e) => e.type === 'tool_start')
    expect(start?.type === 'tool_start' && start.toolName).toBe('echo')
    expect(events.some((e) => e.type === 'tool_end')).toBe(true)
  })

  /** plan 模式过滤掉写工具后,演示上游看不到工具,于是直接说话收尾 */
  it('plan 模式下拿不到写工具,循环照样收得了尾', async () => {
    const { events } = await run({ mode: 'plan' })
    const end = events.at(-1)
    expect(end?.type === 'run_end' && end.status).toBe('done')
  })
})
