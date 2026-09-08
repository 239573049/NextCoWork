/**
 * 内置演示上游 —— **真 SSE、假网络**。让 `npm run dev` 无需 API key 就能走完整条链路。
 *
 * ★ 它挂在 `KernelHost.fetch` 上,不是挂在 `UpstreamRouter` 里的一个 `if (isDemo)`。
 * 这个位置是全部意义所在:请求照样经 `encodeAnthropic` 变成真的 Anthropic 请求体,
 * 响应照样是真的 SSE 字节流,照样过 `SseParser` → `decodeAnthropic` → 健康评分。
 * 演示模式和真实模式之间**没有一条分叉的代码路径** —— 否则「dev 里好好的,
 * 填了真 key 就崩」会成为常态,而那正是内置演示上游本该消灭的问题。
 *
 * 它做两件真实上游会做、而假发射器永远不会做的事:
 *
 * 1. **按字节切片,不按事件切片。** 一个中文字符占 3 字节,分片边界会把它劈开;
 *    一个 SSE 事件也会横跨两个分片。`sse.ts` 的文件头说这两个 bug
 *    「本机低延迟时任何写法都能跑,上了真网络才开始丢字」—— 演示上游让它们
 *    **每次 dev 都必然发生**,而不是等到上线。
 * 2. **像真上游一样挑剔。** 空 text 块、没签名的 thinking 块、没配对 tool_result 的
 *    tool_use —— 真 Anthropic 对这些一律 400。演示上游照样 400(见 §4.8:
 *    漏掉中断补偿的报错会指向消息数组,看起来像 adapter 的 bug)。
 *    一个宽容的假上游会把这类错误**藏到用户填了真 key 那天**。
 */
import type { KernelHost } from '../host'
import { nodeHost } from '../host'
import { clampWithEllipsis } from '../text'
import { abortableSleep, abortError } from '../abort'
import { EXTERNAL_NAME_RE } from '../../../shared/agent/tool'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'

export const DEMO_PROVIDER_ID = 'demo'
export const DEMO_MODEL = 'demo-model'
export const DEMO_ALIAS = 'nextcowork-demo'
/** 走的是 safeStorage 的同一条取值路径,只是值是个常量 —— 不是明文 key 的特例 */
export const DEMO_CREDENTIAL_REF = 'demo:api-key'
export const DEMO_API_KEY = 'sk-demo-not-a-real-key'

export const DEMO_PROVIDER: UpstreamProvider = {
  id: DEMO_PROVIDER_ID,
  name: '内置演示上游',
  protocol: 'anthropic',
  baseUrl: 'https://demo.invalid',
  credentialRef: DEMO_CREDENTIAL_REF,
  priority: 100,
  enabled: true
}

export const DEMO_ALIASES: ModelAlias[] = [
  {
    alias: DEMO_ALIAS,
    providerId: DEMO_PROVIDER_ID,
    upstreamModel: DEMO_MODEL,
    capabilities: { tools: true, vision: false, thinking: true, caching: false },
    contextWindow: 200_000,
    maxOutputTokens: 8192
  }
]

// ─── 从 unknown 里安全取值(同 decode/anthropic.ts,strict + noUncheckedIndexedAccess) ───

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}
function str(o: Record<string, unknown> | undefined, k: string): string | undefined {
  const v = o?.[k]
  return typeof v === 'string' ? v : undefined
}
function num(o: Record<string, unknown> | undefined, k: string): number | undefined {
  const v = o?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined
}

// ─── 校验:演示上游必须和真上游一样挑剔 ─────────────────────────────

export interface DemoHttpError {
  status: number
  /** Anthropic 的错误分类,`anthropicErrorToAgentError` 认它 */
  type: string
  message: string
}

function bad(message: string): DemoHttpError {
  return { status: 400, type: 'invalid_request_error', message }
}

/**
 * 请求体校验。**每一条都对应一个真 Anthropic 会返回 400 的形状**,
 * 措辞也尽量贴近上游原文 —— 这样 dev 里读到的报错和线上读到的是同一句话。
 *
 * 导出是为了单测能直接喂畸形请求,不必绕一圈 fetch。
 */
export function validateAnthropicRequest(body: unknown): DemoHttpError | null {
  const b = rec(body)
  if (!b) return bad('请求体必须是一个 JSON 对象')

  if ((str(b, 'model') ?? '') === '') return bad('messages: model 不能为空')

  const maxTokens = num(b, 'max_tokens')
  if (maxTokens === undefined || maxTokens <= 0) {
    return bad('max_tokens: 必须是正整数')
  }

  /**
   * ★ 开 thinking 时 `max_tokens` 必须严格大于 `budget_tokens`。
   * `encodeAnthropic` 里有一段专门抬高 max_tokens 的代码来满足它;
   * 这条校验就是那段代码的看门人 —— 删掉它,那段代码退化成注释里的传说。
   */
  const thinking = rec(b.thinking)
  if (thinking !== undefined && thinking.type !== 'disabled') {
    const budget = num(thinking, 'budget_tokens')
    if (budget === undefined || budget <= 0) return bad('thinking.budget_tokens: 必须是正整数')
    if (maxTokens <= budget) {
      return bad(`max_tokens 必须大于 thinking.budget_tokens(${maxTokens} <= ${budget})`)
    }
  }

  // 工具名的硬约束(方案 §4.3)。注册表生成 externalName 时若漏了截断或消毒,
  // 真上游给的是一个什么都没说清楚的 400 —— 这里把话说清楚。
  const tools = arr(b.tools) ?? []
  const advertised = new Set<string>()
  for (const [i, raw] of tools.entries()) {
    const t = rec(raw)
    const name = str(t, 'name') ?? ''
    if (!EXTERNAL_NAME_RE.test(name)) {
      return bad(`tools.${i}.name: 「${clampWithEllipsis(name, 80)}」不满足 ^[a-zA-Z0-9_-]{1,64}$`)
    }
    if (rec(t?.input_schema) === undefined) return bad(`tools.${i}.input_schema: 必须是一个对象`)
    advertised.add(name)
  }

  const messages = arr(b.messages)
  if (messages === undefined || messages.length === 0) return bad('messages: 不能为空')

  /** 上一条 assistant 消息里开了、还没等到 tool_result 的 tool_use id */
  let awaiting: string[] = []

  for (const [i, raw] of messages.entries()) {
    const m = rec(raw)
    const role = str(m, 'role')
    if (role !== 'user' && role !== 'assistant') {
      return bad(`messages.${i}.role: 只能是 user 或 assistant`)
    }
    if (i === 0 && role !== 'user') return bad('messages.0.role: 第一条必须是 user')

    const prevRole = str(rec(messages[i - 1]), 'role')
    // ★ `toAnthropicMessages` 会合并相邻同角色消息(并行工具调用与中断补偿
    // 都会产生两条连续的 user 消息)。这条校验守的就是那个合并。
    if (i > 0 && role === prevRole) {
      return bad(`messages.${i}: 角色必须在 user 与 assistant 之间交替`)
    }

    const content = arr(m?.content)
    // ★ 空 content 是 400。它很容易产生:中断在第一个 delta 之前落下一条空消息。
    if (content === undefined || content.length === 0) {
      return bad(`messages.${i}: content 不能为空`)
    }

    const opened: string[] = []
    const closed = new Set<string>()

    for (const [j, rawBlock] of content.entries()) {
      const blk = rec(rawBlock)
      const at = `messages.${i}.content.${j}`
      switch (str(blk, 'type')) {
        case 'text':
          if ((str(blk, 'text') ?? '') === '') return bad(`${at}: text 内容块不能为空`)
          break

        case 'thinking':
          // ★ 没有签名的 thinking 块回传上去是 400。`toBlock` 宁可整块丢掉也不带假签名 ——
          // 这条校验保证那个「宁可丢掉」的选择不会哪天被人改回来。
          if ((str(blk, 'signature') ?? '') === '') {
            return bad(`${at}: thinking 内容块必须带 signature`)
          }
          break

        case 'redacted_thinking':
          if ((str(blk, 'data') ?? '') === '') return bad(`${at}: redacted_thinking 必须带 data`)
          break

        case 'tool_use': {
          const id = str(blk, 'id') ?? ''
          const name = str(blk, 'name') ?? ''
          if (id === '') return bad(`${at}: tool_use 必须带 id`)
          if (advertised.size > 0 && !advertised.has(name)) {
            return bad(`${at}: 工具「${clampWithEllipsis(name, 64)}」不在本次请求的 tools 里`)
          }
          opened.push(id)
          break
        }

        case 'tool_result': {
          const id = str(blk, 'tool_use_id') ?? ''
          if (id === '') return bad(`${at}: tool_result 必须带 tool_use_id`)
          if (!awaiting.includes(id)) {
            return bad(`${at}: tool_result 的 tool_use_id「${id}」在上一条消息里没有对应的 tool_use`)
          }
          closed.add(id)
          break
        }

        default:
          break
      }
    }

    /**
     * ★★ 全文件最重要的一条:**每个 tool_use 必须在紧随的下一条消息里配对 tool_result**。
     *
     * 这正是方案 §4.8 那个「手写 Agent 循环最常见的自伤」。中断收尾漏掉补偿时,
     * 真上游给的 400 会指向消息数组,读起来像 adapter 的 bug,而真正的起因
     * 在几百行外的 abort 路径上。演示上游在 dev 的第一秒就把它抓出来。
     */
    const orphans = awaiting.filter((id) => !closed.has(id))
    if (orphans.length > 0) {
      return bad(
        `messages.${i}: 上一条消息里的 tool_use(${orphans.join(', ')})` +
          `没有配对的 tool_result。每个 tool_use 都必须在紧随的下一条消息里被回复。`
      )
    }
    awaiting = opened
  }

  if (awaiting.length > 0) {
    return bad(`messages: 最后一条消息里的 tool_use(${awaiting.join(', ')})还没有 tool_result`)
  }
  return null
}

// ─── 剧本 ────────────────────────────────────────────────────────────

type DemoBlock =
  | { kind: 'thinking'; text: string; signature: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

interface DemoReply {
  blocks: DemoBlock[]
  stopReason: 'end_turn' | 'tool_use'
}

/** 按 input_schema 编一份能过 zod 的入参。只填前 4 个字段,够演示了。 */
function demoInput(schema: unknown): Record<string, unknown> {
  const props = rec(rec(schema)?.properties)
  const out: Record<string, unknown> = {}
  if (props === undefined) return out
  for (const [key, raw] of Object.entries(props).slice(0, 4)) {
    switch (str(rec(raw), 'type')) {
      case 'number':
      case 'integer':
        out[key] = 1
        break
      case 'boolean':
        out[key] = true
        break
      case 'array':
        out[key] = []
        break
      case 'object':
        out[key] = {}
        break
      default:
        out[key] = `演示值:${key}`
    }
  }
  return out
}

function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = rec(messages[i])
    if (str(m, 'role') !== 'user') continue
    const texts = (arr(m?.content) ?? [])
      .map(rec)
      .filter((b) => str(b, 'type') === 'text')
      .map((b) => str(b, 'text') ?? '')
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

/**
 * 决定这一轮回什么。
 *
 * ★ **有 tool_result 就收工**,这不是随便定的:演示上游要是每轮都调工具,
 * dev 里的每次发送都会持续调用工具,看起来像死循环。
 */
export function planDemoReply(body: unknown, seq: number): DemoReply {
  const b = rec(body) ?? {}
  const messages = arr(b.messages) ?? []
  const tools = arr(b.tools) ?? []
  const blocks: DemoBlock[] = []

  // thinking 开着就先来一块。它顺带把 signature 的往返跑通:
  // decode 攒成 block_opaque → 落进 ContentPart.opaque → encode 再取出来回传。
  if (rec(b.thinking) !== undefined && rec(b.thinking)?.type !== 'disabled') {
    blocks.push({
      kind: 'thinking',
      text: '(演示)先看看用户要什么,再决定要不要动工具。',
      signature: `demo-signature-${seq}`
    })
  }

  const lastBlocks = arr(rec(messages[messages.length - 1])?.content) ?? []
  const results = lastBlocks.map(rec).filter((blk) => str(blk, 'type') === 'tool_result')

  if (results.length > 0) {
    const content = str(results[0], 'content') ?? ''
    blocks.push({
      kind: 'text',
      text: `工具回来了:「${clampWithEllipsis(content, 120)}」。演示上游到此收工。`
    })
    return { blocks, stopReason: 'end_turn' }
  }

  const first = rec(tools[0])
  const name = str(first, 'name')
  if (name !== undefined) {
    blocks.push({
      kind: 'text',
      text: `(演示上游)我看到 ${tools.length} 个可用工具,先调一下 ${name} 试试。`
    })
    blocks.push({
      kind: 'tool_use',
      id: `toolu_demo_${seq}`,
      name,
      input: demoInput(first?.input_schema)
    })
    return { blocks, stopReason: 'tool_use' }
  }

  blocks.push({
    kind: 'text',
    text:
      `(演示上游)你说的是「${clampWithEllipsis(lastUserText(messages), 60)}」。\n` +
      '这条回复没有经过任何网络 —— 但它是真的 SSE:同样的分片、同样的解析器、' +
      '同样的归一化。填上真的 API key,这条路径一个字节都不会变。'
  })
  return { blocks, stopReason: 'end_turn' }
}

// ─── 渲染成 Anthropic SSE ────────────────────────────────────────────

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 按码点切,不按 UTF-16 码元 —— 否则 emoji 会被劈成两个半个代理对 */
function pieces(s: string, size: number): string[] {
  const cps = Array.from(s)
  const out: string[] = []
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''))
  return out.length > 0 ? out : ['']
}

export function renderDemoSse(reply: DemoReply, model: string, inputTokens: number): string {
  let sse = frame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_demo',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 }
    }
  })
  // 真上游会在长思考期间发心跳。发一个,好让 decode 的忽略分支每次 dev 都被走到。
  sse += frame('ping', { type: 'ping' })

  let outputTokens = 0

  reply.blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'thinking': {
        sse += frame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' }
        })
        for (const piece of pieces(block.text, 8)) {
          sse += frame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: piece }
          })
          outputTokens += 1
        }
        // 签名分两段发 —— decode 侧是累加的,一段的话累加逻辑等于没测
        for (const piece of pieces(block.signature, Math.ceil(block.signature.length / 2))) {
          sse += frame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: piece }
          })
        }
        break
      }

      case 'text': {
        sse += frame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        })
        for (const piece of pieces(block.text, 6)) {
          sse += frame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: piece }
          })
          outputTokens += 1
        }
        break
      }

      case 'tool_use': {
        sse += frame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
        })
        /**
         * ★ 入参 JSON **必须切碎**。中间每一片单独看都是非法 JSON,
         * 这正是「只在 tool_call_end 时 parse 一次」那条规则的由来(方案 §4.2)。
         * 不切碎的话,一个在 delta 上就 parse 的实现能一路绿灯到线上。
         */
        for (const piece of pieces(JSON.stringify(block.input), 11)) {
          sse += frame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: piece }
          })
        }
        break
      }
    }
    sse += frame('content_block_stop', { type: 'content_block_stop', index })
  })

  sse += frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reply.stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  })
  sse += frame('message_stop', { type: 'message_stop' })
  return sse
}

// ─── fetch 替身 ──────────────────────────────────────────────────────

export interface DemoOptions {
  /** 分片之间的间隔;0 = 不等待(单测用) */
  chunkDelayMs?: number
  /** ★ 分片大小按**字节**算,不按字符 —— 中文字符因此必然被劈开 */
  chunkBytes?: number
}

/** fetch 的第一个入参有三种形态(string / URL / Request),三种都要认 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function errorResponse(e: DemoHttpError): Response {
  return jsonResponse(e.status, { type: 'error', error: { type: e.type, message: e.message } })
}

/**
 * 字节流。用 `pull` 而不是在 `start` 里一次推完:
 * 一次推完的话背压是假的,而且**中断只能在下一次 read 时才被发现** ——
 * 演示上游就没法用来验证「生成途中点停止」这条验收项了。
 */
function sseStream(
  bytes: Uint8Array,
  chunkBytes: number,
  delayMs: number,
  signal: AbortSignal | null
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted === true) throw abortError()
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      if (delayMs > 0) await abortableSleep(delayMs, signal)
      controller.enqueue(bytes.slice(offset, offset + chunkBytes))
      offset += chunkBytes
    }
  })
}

/**
 * 一个可以直接塞进 `KernelHost.fetch` 的假 fetch。
 *
 * 它只认 `POST <任意 base>/v1/messages` —— 其余路径给 404,方法不对给 405。
 * 这不是较真:`joinUpstreamUrl` 是个「会咬人的启发式」(见 canonical.ts),
 * 拼错了在真上游那边是一个 HTML 404 页,在这里是一句能读的话。
 */
export function demoFetch(opts: DemoOptions = {}): typeof fetch {
  const chunkBytes = opts.chunkBytes ?? 64
  const delayMs = opts.chunkDelayMs ?? 12
  const encoder = new TextEncoder()
  let seq = 0

  const impl: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? null
    if (signal?.aborted === true) throw abortError()

    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (!new URL(url).pathname.endsWith('/v1/messages')) {
      return errorResponse({
        status: 404,
        type: 'not_found_error',
        message: `演示上游只提供 /v1/messages,收到的是 ${url}`
      })
    }
    if (method !== 'POST') {
      return errorResponse({ status: 405, type: 'invalid_request_error', message: `不支持 ${method}` })
    }

    const headers = new Headers(init?.headers ?? {})
    // Anthropic 用 x-api-key,不是 Authorization: Bearer。写错了真上游给 401,
    // 这里也给 401 —— 于是 router 会把它分类成 auth,UI 跳设置页。
    if ((headers.get('x-api-key') ?? '') === '') {
      return errorResponse({
        status: 401,
        type: 'authentication_error',
        message: '缺少 x-api-key 请求头'
      })
    }
    if ((headers.get('anthropic-version') ?? '') === '') {
      return errorResponse({
        status: 400,
        type: 'invalid_request_error',
        message: '缺少 anthropic-version 请求头'
      })
    }

    let body: unknown
    try {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '')
    } catch {
      return errorResponse({
        status: 400,
        type: 'invalid_request_error',
        message: '请求体不是合法 JSON'
      })
    }

    const invalid = validateAnthropicRequest(body)
    if (invalid !== null) return errorResponse(invalid)

    seq += 1
    const reply = planDemoReply(body, seq)
    const messages = arr(rec(body)?.messages) ?? []
    const sse = renderDemoSse(reply, str(rec(body), 'model') ?? DEMO_MODEL, messages.length * 20)

    return new Response(sseStream(encoder.encode(sse), chunkBytes, delayMs, signal), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
    })
  }
  return impl
}

/**
 * 演示凭证的取值包装。
 *
 * ★ 只劫持**演示那一个 ref**,其余照旧走底层实现。一个同时配了演示上游和
 * 真上游的 dev 环境(这正是内置演示上游的用法:先跑通,再填真 key)
 * 不该被这层包装弄坏 —— 顶掉真 provider 的密钥,症状是一个莫名其妙的 401。
 */
export function withDemoSecrets(inner: KernelHost['secrets']): KernelHost['secrets'] {
  return {
    ...inner,
    get: async (ref) => (ref === DEMO_CREDENTIAL_REF ? DEMO_API_KEY : inner.get(ref))
  }
}

/**
 * 把演示上游挂在一个**真 fetch 前面**,按 URL 主机名分派。
 *
 * ★ 分派依据是主机名,不是一个全局「演示模式」布尔开关。
 * 全局开关会让真上游也收到假回复 —— 那正是本文件开头那句「dev 里好好的,
 * 填了真 key 就崩」的镜像版本:dev 里一切正常,因为**根本没有请求出去过**。
 * 按主机名分派则让两种上游在同一个进程里共存,各走各的路;
 * `demo.invalid` 这个保留 TLD(RFC 2606)保证它永远不会撞上真域名。
 */
export function withDemoUpstream(real: typeof fetch, opts: DemoOptions = {}): typeof fetch {
  const demo = demoFetch(opts)
  const demoHostname = new URL(DEMO_PROVIDER.baseUrl).hostname
  return (input, init) => {
    let hostname = ''
    try {
      hostname = new URL(urlOf(input)).hostname
    } catch {
      // 拼坏的 URL 交给真 fetch 去报错 —— 它给的报错比我们编的准
    }
    return hostname === demoHostname ? demo(input, init) : real(input, init)
  }
}

/**
 * 给任意 host 装上演示上游。`electronHost()` 与运行时的默认 host 共用这一处 ——
 * 「演示上游是怎么挂上去的」只说一遍。
 */
export function withDemo(host: KernelHost, opts: DemoOptions = {}): KernelHost {
  return {
    ...host,
    secrets: withDemoSecrets(host.secrets),
    fetch: withDemoUpstream(host.fetch, opts)
  }
}

/**
 * **纯演示** KernelHost:每一个出站请求都由演示上游接管。
 *
 * 与 `withDemo` 的区别是刻意的:这里用的是 `demoFetch` 本身,不是
 * `withDemoUpstream`。于是单测里一个写错了 baseUrl 的请求得到的是演示上游的
 * 404,而**不会漏到真网络上去** —— 无头测试不该有能力发出真请求。
 */
export function demoHost(overrides: Partial<KernelHost> = {}, opts: DemoOptions = {}): KernelHost {
  const base = nodeHost({ fetch: demoFetch(opts), ...overrides })
  return { ...base, secrets: withDemoSecrets(base.secrets) }
}
