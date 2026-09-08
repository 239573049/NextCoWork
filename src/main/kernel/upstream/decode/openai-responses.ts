import type { ProviderStreamEvent, StopReason } from '../../../../shared/agent/stream'
import type { SseEvent } from '../sse'
import { count, interruptedResponse, malformedResponse, OpenAIUsage, openAIErrorToAgentError, record, string } from './openai-common'

interface Segment { index: number; text: string }
interface Item {
  index: number
  kind: string
  id: string
  callId: string
  name: string
  args: string
  started: boolean
  opaqueSent: boolean
  /** 键是 `${lane}:${partIndex}` —— 见 Lane */
  segments: Map<string, Segment>
  /** 这个 reasoning item 出现过正文。见 Lane 那段注释的第二半 */
  preferContent: boolean
}

class InvalidResponse extends Error {}

// Reserve a namespace per output item. A late content part must stay before the
// next output item even when parallel events arrive in a different order.
const INDEX_STRIDE = 1_000_000

/**
 * item 内部再切两半:摘要占 [0, CONTENT_BASE),推理正文占 [CONTENT_BASE, INDEX_STRIDE)。
 *
 * ★ `ReasoningItem` 上 `summary[]` 和 `content[]` 是**并列**字段,两边的下标都从 0 数起。
 * 不分开的话 `summary_index: 0` 和 `content_index: 0` 会落进同一个段,后到的那个
 * 会被当成前一个的续写 —— 表现是推理块里两段文字被拼成一段乱码。
 */
const CONTENT_BASE = 500_000

/** 'main' = message 的正文/拒答 + reasoning 的摘要;'content' = reasoning 的推理正文 */
type Lane = 'main' | 'content'

function laneBase(lane: Lane): number {
  return lane === 'content' ? CONTENT_BASE : 0
}

/**
 * **需要我们回 `*_output` 的工具项。**
 *
 * ★★ 未知 output item 分两类,不能一视同仁。托管工具(`web_search_call`、
 * `code_interpreter_call`、`mcp_call` …)由 OpenAI 自己执行,结果就在同一条响应里,
 * 忽略是对的。而下面这些是模型**在等我们把执行结果送回去** —— 静默丢掉的话,
 * 模型以为自己调用过了、我们却什么都没返回,下一轮上下文直接错位,
 * 且全程不报任何错。一句能看懂的错,好过一段谁也解释不了的对话。
 *
 * ★ 这是**白名单**,默认落在「忽略」那一侧 —— OpenAI 以后加新的托管类型
 * 不会把我们炸掉(规范里 `OutputItem` 已经有 29 种,还在长)。
 * 我们只发 `type: 'function'` 工具、从不启用托管工具,所以这是绊线,不是预期路径。
 */
const CLIENT_TOOL_ITEMS = new Set([
  'local_shell_call', 'shell_call', 'apply_patch_call',
  'custom_tool_call', 'computer_call', 'mcp_approval_request'
])

/**
 * `incomplete_details.reason` → 停止原因。
 *
 * ★★ 规范的枚举是**四个**值:`max_output_tokens` / `max_messages` / `content_filter`
 * / `steered`。以前只放行两个,另外两个被当成协议违规**中止整轮** —— 而 `steered`
 * 按规范是「在安全输出边界正常停止,服务端会自动接续」,是一次彻头彻尾的正常终止。
 *
 * ★ 认不出的值一律返回 undefined 让调用方走默认档,不报错 —— 和
 * `decode/anthropic.ts` 的 `toStopReason()` 同一条规矩:上游加一个新枚举值,
 * 不该让我们整轮失败。
 */
function incompleteStopReason(reason: string | undefined): StopReason | undefined {
  switch (reason) {
    case 'max_output_tokens': return 'max_tokens'
    case 'content_filter': return 'refusal'
    default: return undefined
  }
}

/** OpenAI Responses output_index, content_index and call_id are three separate namespaces. */
export async function* decodeOpenAIResponses(events: AsyncIterable<SseEvent>): AsyncGenerator<ProviderStreamEvent> {
  const items = new Map<number, Item>()
  /** item id → 槽位。所有流式事件都带 `item_id`,它比 output_index 可靠,见 itemAt */
  const byId = new Map<string, number>()
  const usage = new OpenAIUsage()
  let started = false
  let refused = false

  /**
   * 这条 item 该落进哪个槽。
   *
   * ★★ **`id` 优先,`output_index` 只是提示。**
   * 以前把 `output_index` 当唯一标识,于是同一个下标上先后出现不同 `type` 或不同
   * `id` 的 item 时,只能判「协议违规」把整轮打掉(`output item type changed` /
   * `output item identity changed`)。但这两件事的真实含义都是**「这不是刚才那条」**——
   * 而第三方网关重用 output_index、在终局 `output` 里重新生成一遍 id,都很常见;
   * 规范对终局数组也只说 "The length and order of items in the output array is
   * dependent on the model's response",从没保证它和流式阶段对齐。
   *
   * 所以三条路,没有一条是报错:
   * - id 认得出 → 就是那个槽(最可靠,所有流式事件都带 `item_id`)
   * - 认不出,下标空着或占着的是同类 → 用下标。**同类但 id 对不上也并进去** ——
   *   那多半只是网关换了个 id,当成新条目会把同一段思考重复渲染一遍
   * - 认不出且 kind 都不同 → 开一个没人用过的新槽,那才真是另一条内容
   *
   * 内容一条不丢,好过整轮归零。
   */
  function itemAt(hint: number, kind: string, id?: string): Item {
    if (hint >= INDEX_STRIDE) throw new InvalidResponse('output_index exceeds supported range')
    const known = id === undefined ? undefined : byId.get(id)
    let index = known ?? hint
    if (known === undefined) {
      const occupant = items.get(hint)
      if (occupant !== undefined && occupant.kind !== kind) {
        index = hint + 1
        while (items.has(index)) index++
      }
    }
    let item = items.get(index)
    if (item === undefined) {
      item = { index: index * INDEX_STRIDE, kind, id: '', callId: '', name: '', args: '', started: false, opaqueSent: false, segments: new Map(), preferContent: false }
      items.set(index, item)
    }
    if (id !== undefined && item.id === '') {
      item.id = id
      byId.set(id, index)
    }
    return item
  }

  function* text(item: Item, lane: Lane, partIndex: number, value: string, complete: boolean): Generator<ProviderStreamEvent> {
    if (partIndex >= CONTENT_BASE) throw new InvalidResponse('content index exceeds supported range')
    // 正文优先:这个 item 一旦出过推理正文,摘要就不再发出 —— 两者内容高度重复
    if (item.preferContent && lane === 'main' && item.kind === 'reasoning') return
    const key = `${lane}:${partIndex}`
    let segment = item.segments.get(key)
    if (segment === undefined) {
      segment = { index: item.index + laneBase(lane) + partIndex, text: '' }
      item.segments.set(key, segment)
    }
    /*
      ★★ 快照对不上时**保留已经流式收到的内容,继续跑**,不中止。
      规范只把 `.done` 的 `text` 描述为 "final text content",没有任何措辞保证它
      等于所有 delta 的拼接 —— 那个等式是我们自己加的。为它炸掉整轮,代价远大于
      差几个字。工具参数不适用这条,见 `argumentsDelta`。
    */
    if (complete && !value.startsWith(segment.text)) return
    const delta = complete ? value.slice(segment.text.length) : value
    segment.text += delta
    if (delta !== '') yield { type: item.kind === 'reasoning' ? 'thinking_delta' : 'text_delta', index: segment.index, text: delta }
  }

  function* argumentsDelta(item: Item, value: string, complete: boolean): Generator<ProviderStreamEvent> {
    if (!item.started) {
      if (item.callId === '' || item.name === '') throw new InvalidResponse('missing function call identity')
      item.started = true
      yield { type: 'tool_call_start', index: item.index, callId: item.callId, name: item.name }
    }
    /*
      ★ 这里**不能**像 `text` 那样降级。工具参数会被原样交给工具去执行 ——
      快照和流式内容不一致意味着我们手上这份入参是错的,而 `tool_call_delta` 是
      只进不退的,没法用快照把它改回来。宁可报错也不能拿一份错的入参去调用工具。
    */
    if (complete && !value.startsWith(item.args)) throw new InvalidResponse('completed arguments do not match streamed arguments')
    const delta = complete ? value.slice(item.args.length) : value
    item.args += delta
    if (delta !== '') yield { type: 'tool_call_delta', index: item.index, callId: item.callId, argsDelta: delta }
  }

  function* acceptItem(raw: unknown, outputIndex: number, complete: boolean): Generator<ProviderStreamEvent> {
    const value = record(raw)
    const kind = string(value?.type)
    if (kind === undefined || value === undefined) throw new InvalidResponse('missing output item type')
    if (CLIENT_TOOL_ITEMS.has(kind)) throw new InvalidResponse(`unsupported output item: ${kind}`)
    const item = itemAt(outputIndex, kind, string(value.id))
    if (kind === 'function_call') {
      const callId = string(value.call_id) ?? item.callId
      const name = string(value.name) ?? item.name
      if (item.started && (item.callId !== callId || item.name !== name)) throw new InvalidResponse('function identity changed')
      item.callId = callId
      item.name = name
      yield* argumentsDelta(item, string(value.arguments) ?? '', true)
    } else if (kind === 'message' && Array.isArray(value.content)) {
      for (const [index, part] of value.content.entries()) {
        const content = record(part)
        if (content?.type === 'refusal') refused = true
        const body = string(content?.text) ?? string(content?.refusal)
        if (body !== undefined) yield* text(item, 'main', index, body, true)
      }
    } else if (kind === 'reasoning') {
      const content = Array.isArray(value.content) ? value.content : []
      if (content.length > 0) item.preferContent = true
      for (const [index, part] of content.entries()) {
        const body = string(record(part)?.text)
        if (body !== undefined) yield* text(item, 'content', index, body, true)
      }
      if (!item.preferContent && Array.isArray(value.summary)) {
        for (const [index, part] of value.summary.entries()) {
          const body = string(record(part)?.text)
          if (body !== undefined) yield* text(item, 'main', index, body, true)
        }
      }
      if (complete && !item.opaqueSent) {
        item.opaqueSent = true
        /*
          Preserve the complete item, including encrypted_content, exactly once.
          ★ 索引要跟着**实际生效的那条 lane** 走。opaque 自己不带文字,靠和文字段
          落在同一个 index 上才会被 BlockAccumulator 合进同一个思考块 —— 落错 lane
          的话,界面上会多出一个空的思考块,而思考文字在另一个块里。
        */
        yield { type: 'block_opaque', index: item.index + laneBase(item.preferContent ? 'content' : 'main'), opaque: { protocol: 'openai-responses', item: structuredClone(value) } }
      }
    }
  }

  try {
    for await (const event of events) {
      if (event.data.trim() === '[DONE]') break
      if (event.data.trim() === '') continue
      let data: Record<string, unknown> | undefined
      try { data = record(JSON.parse(event.data)) } catch { throw new InvalidResponse('invalid Responses JSON') }
      if (data === undefined) continue
      const type = string(data.type) ?? event.event
      const response = record(data.response) ?? (data.object === 'response' ? data : undefined)
      if (type === 'error' || (data.error !== undefined && response === undefined) || type === 'response.failed'
        || response?.status === 'failed') {
        yield { type: 'error', error: openAIErrorToAgentError(undefined, response ?? data) }
        return
      }
      if (!started && (response !== undefined || type.startsWith('response.'))) {
        started = true
        yield { type: 'message_start', model: string(response?.model) ?? '<unknown>' }
      }
      usage.update(response?.usage)
      const outputIndex = count(data.output_index)
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        if (outputIndex === undefined) throw new InvalidResponse('missing output_index')
        yield* acceptItem(data.item, outputIndex, type.endsWith('.done'))
      } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        // ★ 先按 item_id 认 —— 网关重用 output_index 时,只按下标找会认错人
        const known = byId.get(string(data.item_id) ?? '')
        const item = items.get(known ?? outputIndex ?? -1)
        if (item?.kind !== 'function_call') throw new InvalidResponse('arguments arrived before function call')
        yield* argumentsDelta(item, string(type.endsWith('.done') ? data.arguments : data.delta) ?? '', type.endsWith('.done'))
      } else if (type === 'response.output_text.delta' || type === 'response.output_text.done'
        || type === 'response.refusal.delta' || type === 'response.refusal.done'
        || type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done'
        || type === 'response.reasoning_text.delta' || type === 'response.reasoning_text.done') {
        if (outputIndex === undefined) throw new InvalidResponse('missing output_index')
        const summary = type.includes('reasoning_summary')
        // ★ 摘要和正文是**两组独立事件**,不是一个的两种写法。只认摘要那一组的话,
        //   推理正文会被整段静默丢掉 —— 不报错,只是模型的思考没了。
        const reasoningText = type.startsWith('response.reasoning_text')
        const isRefusal = type.includes('refusal')
        if (isRefusal) refused = true
        const item = itemAt(outputIndex, summary || reasoningText ? 'reasoning' : 'message', string(data.item_id))
        if (reasoningText) item.preferContent = true
        const done = type.endsWith('.done')
        const value = string(done ? (isRefusal ? data.refusal : data.text) : data.delta)
        /*
          ★ `.done` 缺字段时跳过而不是报错:流式内容已经在手里了,少一份快照不构成
          损失。`.delta` 缺 `delta` 则这个事件本身没有意义,仍按协议违规处理。
        */
        if (value === undefined) {
          if (!done) throw new InvalidResponse('missing text delta')
        } else {
          yield* text(item, reasoningText ? 'content' : 'main',
            count(summary ? data.summary_index : data.content_index) ?? 0, value, done)
        }
      }

      if (type === 'response.completed' || type === 'response.incomplete' || data.object === 'response') {
        if (response === undefined) throw new InvalidResponse('missing terminal response')
        if (Array.isArray(response.output)) {
          for (const [position, value] of response.output.entries()) yield* acceptItem(value, position, true)
        }
        const incomplete = type === 'response.incomplete' || response.status === 'incomplete'
        const reason = string(record(response.incomplete_details)?.reason)
        if (data.object === 'response' && response.status !== 'completed' && !incomplete) {
          throw new InvalidResponse('non-terminal JSON response')
        }
        const calls = [...items.values()].filter((item) => item.kind === 'function_call')
        const stopReason: StopReason = incompleteStopReason(reason)
          ?? (refused ? 'refusal' : calls.length > 0 ? 'tool_use' : 'end_turn')
        if (stopReason === 'tool_use') {
          if (new Set(calls.map((call) => call.callId)).size !== calls.length) throw new InvalidResponse('duplicate call_id')
          for (const call of calls) {
            yield { type: 'tool_call_end', index: call.index, callId: call.callId }
          }
        }
        yield { type: 'message_end', stopReason, usage: usage.snapshot() }
        return
      }
    }
  } catch (error) {
    if (!(error instanceof InvalidResponse)) throw error
    yield { type: 'error', error: malformedResponse(error.message) }
    return
  }
  yield { type: 'error', error: interruptedResponse() }
}
