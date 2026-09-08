/**
 * 事件流 → 可渲染转录。方案 §4.1 的「双轨转录」里 **UI 那一轨**。
 *
 * 放在 shared/ 而不是 renderer/stores/ 有具体理由:这是一个纯 reducer,
 * 而它最容易出的 bug —— 内容块按 index 错位、提交后残留活跃块、
 * 工具状态没归位 —— 在界面上表现为「偶尔串行」「偶尔少一段」,
 * 靠盯屏幕根本复现不了,靠无头测试三行就能锁死。
 *
 * ★ 它必须对**重复与乱序免疫**吗?不必 —— seq 已经保证了顺序与不重复
 * (信封连续性 + attach 重放)。这里假设输入是有序且恰好一次的,
 * 换来的是一个能一眼看完的 reducer。
 */
import type { AgentError } from './error'
import type { AgentEvent, RunStatus, SubagentPhase } from './event'
import { visibleText, type AgentMessage, type SubagentResult, type ToolOutput } from './message'
import type { TokenUsage } from './stream'
import type { ContextCheckpoint, ContextStatus } from './context-management'

/** 尚未提交的内容块。`index` 就是上游给的块序号(方案 §4.2)。 */
export interface LiveBlock {
  index: number
  kind: 'text' | 'thinking' | 'tool_use'
  /** text/thinking 的正文;tool_use 时是累积中的参数 JSON 片段 */
  text: string
  callId?: string
  name?: string
}

export interface ToolCallState {
  callId: string
  name: string
  input: unknown
  status: 'pending' | 'running' | 'ok' | 'error'
  /** 易失,不进转录(方案 §4.3) */
  progress?: string
  output?: ToolOutput
  /**
   * `tool_start` 到达时的墙钟毫秒。
   *
   * ★ **可选,且不新增事件类型。** 事件自带 `at` 时用事件的(那是主进程打的戳,
   * 排除了 IPC 排队延迟);没有就退化到 `Date.now()`。已落盘的旧转录重放时两者都没有
   * 就只剩 `Date.now()`,算出来的耗时不准 —— 那是历史数据的固有损失,
   * 不值得为它做一次转录格式迁移。
   */
  startedAt?: number
  /** `tool_end` 到达时的墙钟毫秒。 */
  endedAt?: number
}

export interface SubagentState {
  callId: string
  childRunId: string
  status: RunStatus
  description?: string
  subagentType?: string
  model?: string
  background?: boolean
  phase?: SubagentPhase
  currentTool?: string
  toolCalls: number
  toolErrors: number
  startedAt?: number
  endedAt?: number
  summary?: string
  error?: AgentError
  usage?: TokenUsage
  contextUsage?: { used: number; window: number; shouldCompact: boolean }
  /** Last child-run event sequence already reflected in this state. */
  childSeq?: number
}

export interface TranscriptState {
  /** 已提交的消息 —— 落盘的就是这些(方案 §9:绝不在 delta 上写盘) */
  messages: AgentMessage[]
  /** 当前这条助手消息里还在流的块,按 index 升序 */
  live: LiveBlock[]
  tools: Record<string, ToolCallState>
  /** Live and completed child agents keyed by their parent Task call id. */
  subagents: Record<string, SubagentState>
  status: RunStatus
  /** Wall-clock bounds for the currently displayed run. */
  runStartedAt?: number
  runEndedAt?: number
  model?: string
  /**
   * 这次回复**实际由哪家给的**。★ 和 `RunRequest.modelProviderId`(用户选的那家)
   * 不是一回事:故障切换真的换了家时,这里跟着变,而那边不变。抬头显示的应该是
   * 这一个 —— 说的是既成事实,不是意图。
   *
   * 同理,上面那个 `model` 是上游回包里的**真实模型名**,不是别名。别拿它去查别名表。
   */
  providerId?: string
  /** API-reported usage accumulated across completed requests in the current run. */
  usage?: TokenUsage
  contextUsage?: { used: number; window: number; shouldCompact: boolean }
  contextCheckpoints: ContextCheckpoint[]
  contextStatus?: ContextStatus
  /**
   * 重试 / 故障切换的**瞬时**提示,活到下一次 `message_start` 或 `error` 为止。
   *
   * ★★ `provider_retry` 和 `provider_switch` 以前发了**没人画**(见 `applyEvent`
   * 那个 default 分支的旧注释)。于是「上游繁忙、正在退避重试」在界面上和「卡死了」
   * 长得一模一样:一个转圈,几十秒不动,而且重试成功的话用户永远不知道刚才发生过什么。
   * `router.ts` 那句「没有这条事件,用户看到的就是白白冻结 30 秒」说的就是这个 ——
   * 发射端当初做完了,消费端一直空着。
   *
   * ★ 不进 `messages`:它不是对话内容,重试成功之后没有任何留存价值,
   * 留在对话流里只会变成噪声。
   */
  notice?: RunNotice
  error?: AgentError
}

export type RunNotice =
  | { kind: 'retry'; attempt: number; reason: string }
  | { kind: 'switch'; to: string; reason: string }

export function emptyTranscript(): TranscriptState {
  return { messages: [], live: [], tools: {}, subagents: {}, contextCheckpoints: [], status: 'running' }
}

/** Add one provider response's usage to a child-agent total. */
function addUsage(previous: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, ...previous }
  for (const key of Object.keys(delta) as Array<keyof TokenUsage>) {
    const value = delta[key]
    if (value !== undefined) usage[key] = (usage[key] ?? 0) + value
  }
  return usage
}

/** Reconstruct durable Task-card metadata from persisted tool result messages. */
function applySubagentMessage(
  subagents: TranscriptState['subagents'],
  message: AgentMessage
): TranscriptState['subagents'] {
  let next = subagents
  for (const part of message.parts) {
    if (part.type !== 'tool_result' || part.subagent === undefined) continue
    if (next === subagents) next = { ...subagents }
    const previous = next[part.callId]
    const metadata: SubagentResult = part.subagent
    const metadataStatus = metadata.status ?? (part.isError ? 'error' : 'done')
    // A child can finish before its parent commits the background tool result;
    // never let that late durable "running" marker downgrade a terminal state.
    const status = metadataStatus === 'error'
      ? 'error'
      : previous !== undefined && previous.status !== 'running'
        ? previous.status
        : metadataStatus
    next[part.callId] = {
      ...(previous ?? {
        callId: part.callId,
        childRunId: metadata.childRunId,
        toolCalls: 0,
        toolErrors: 0
      }),
      childRunId: metadata.childRunId,
      status,
      ...(metadata.background === undefined ? {} : { background: metadata.background }),
      phase: status === 'running' ? (metadata.background === true ? 'background' : 'starting') : 'finishing',
      ...(metadata.summary === undefined ? {} : { summary: metadata.summary }),
      ...(metadata.error === undefined ? {} : { error: metadata.error })
    }
  }
  return next
}

/** Rebuild durable child-agent cards from session history, retaining live telemetry. */
export function subagentsFromMessages(
  messages: readonly AgentMessage[],
  live: Readonly<TranscriptState['subagents']> = {}
): TranscriptState['subagents'] {
  let subagents: TranscriptState['subagents'] = {}
  const taskCalls = new Map<string, { description?: string; subagentType?: string }>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_call' || part.name.toLowerCase() !== 'task') continue
      const input = part.input
      const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : undefined
      taskCalls.set(part.callId, {
        ...(typeof record?.description === 'string' ? { description: record.description } : {}),
        ...(typeof record?.subagent_type === 'string' ? { subagentType: record.subagent_type } : {})
      })
    }
    subagents = applySubagentMessage(subagents, message)
  }
  for (const [callId, info] of taskCalls) {
    const current = subagents[callId]
    if (current === undefined) continue
    subagents[callId] = {
      ...current,
      ...(info.description === undefined ? {} : { description: info.description }),
      ...(info.subagentType === undefined ? {} : { subagentType: info.subagentType })
    }
  }
  for (const [callId, saved] of Object.entries(subagents)) {
    const current = live[callId]
    if (current === undefined) continue
    subagents[callId] = { ...saved, ...current, callId, childRunId: current.childRunId }
  }
  for (const [callId, current] of Object.entries(live)) {
    if (subagents[callId] !== undefined) continue
    subagents[callId] = current
  }
  return subagents
}

/** Committed calls/results are durable; progress and execution timestamps are not. */
function applyToolMessage(tools: TranscriptState['tools'], message: AgentMessage): TranscriptState['tools'] {
  let next = tools
  for (const part of message.parts) {
    if (part.type !== 'tool_call' && part.type !== 'tool_result') continue
    if (next === tools) next = { ...tools }
    const previous = next[part.callId]
    if (part.type === 'tool_call') {
      next[part.callId] = {
        ...previous,
        callId: part.callId,
        name: part.name,
        // Live tool_start can carry arguments edited during approval.
        input: previous?.input ?? part.input,
        status: previous?.status ?? 'pending'
      }
    } else {
      next[part.callId] = {
        ...previous,
        callId: part.callId,
        name: previous?.name ?? '(unknown)',
        input: previous?.input,
        status: part.isError ? 'error' : 'ok',
        output: part.output,
        progress: undefined
      }
    }
  }
  return next
}

/** Rebuild from saved messages, retaining available live details for matching calls only. */
export function toolsFromMessages(
  messages: readonly AgentMessage[],
  live: Readonly<TranscriptState['tools']> = {}
): TranscriptState['tools'] {
  let tools: TranscriptState['tools'] = {}
  for (const message of messages) tools = applyToolMessage(tools, message)
  for (const [callId, saved] of Object.entries(tools)) {
    const current = live[callId]
    if (current === undefined) continue
    tools[callId] = saved.status === 'pending'
      // The history fetch may precede a more recent tool_start/tool_end event.
      ? { ...saved, ...current, name: saved.name }
      : {
          ...current, ...saved,
          name: saved.name === '(unknown)' ? current.name : saved.name,
          input: current.input ?? saved.input
        }
  }
  return tools
}

/**
 * 这份转录背后到底有没有过一个 run。
 *
 * `emptyTranscript()` 的 `status` 是 `'running'`,那是为「run 已经起了、第一个事件
 * 还没到」那一瞬准备的默认值 —— `attach` 上去的时候它就该显示生成中。但**全新会话
 * 用的是同一个初值**,照着渲染就会在一个还没发过任何消息的空会话上写着「生成中」。
 *
 * 分辨这两者的信息不在转录里(`RunStatus` 没有 idle 这一档,也不该为此加一档 ——
 * 那是主进程 RunRegistry 的状态机,不是 UI 的),而在「此刻有没有 activeRunId」。
 * 所以判断要两个入参,不能只看 `status`。
 */
export function hasRun(s: TranscriptState, running: boolean): boolean {
  return running || s.messages.length > 0 || s.live.length > 0
}

/** 找到 index 对应的块并改写;不存在就按 index 升序插进去。 */
function upsertBlock(
  live: LiveBlock[],
  index: number,
  make: () => LiveBlock,
  patch: (b: LiveBlock) => LiveBlock
): LiveBlock[] {
  const at = live.findIndex((b) => b.index === index)
  if (at >= 0) {
    const existing = live[at]
    if (existing === undefined) return live
    const next = [...live]
    next[at] = patch(existing)
    return next
  }
  // 上游按升序发块,但**不保证** —— 并行工具调用时两个块的 start 可能靠得很近。
  // 插入时排序比事后排序省一次遍历,也省掉「谁负责排序」的疑问。
  return [...live, patch(make())].sort((a, b) => a.index - b.index)
}

export function applyEvent(s: TranscriptState, e: AgentEvent): TranscriptState {
  switch (e.type) {
    case 'stream': {
      const d = e.delta
      switch (d.type) {
        case 'message_start':
          // ★ 内容开始流了 = 重试成功,提示到此为止。见 TranscriptState.notice
          return { ...s, model: d.model, providerId: d.providerId, notice: undefined }

        case 'text_delta':
        case 'thinking_delta': {
          const kind = d.type === 'text_delta' ? 'text' : 'thinking'
          return {
            ...s,
            live: upsertBlock(
              s.live,
              d.index,
              () => ({ index: d.index, kind, text: '' }),
              (b) => ({ ...b, text: b.text + d.text })
            )
          }
        }

        case 'tool_call_start':
          return {
            ...s,
            live: upsertBlock(
              s.live,
              d.index,
              () => ({ index: d.index, kind: 'tool_use', text: '' }),
              (b) => ({ ...b, kind: 'tool_use', callId: d.callId, name: d.name })
            )
          }

        case 'tool_call_delta':
          return {
            ...s,
            live: upsertBlock(
              s.live,
              d.index,
              () => ({ index: d.index, kind: 'tool_use', text: '', callId: d.callId }),
              (b) => ({ ...b, text: b.text + d.argsDelta })
            )
          }

        case 'tool_call_end':
          // 参数已经攒齐,但**这里不 JSON.parse** —— 解析是内核的事(ToolCallAccumulator),
          // 而且流式中途的 JSON 一定非法。UI 拿到的 input 来自 tool_start。
          return s

        case 'message_end': {
          return { ...s, usage: addUsage(s.usage, d.usage) }
        }

        case 'provider_retry':
          return { ...s, notice: { kind: 'retry', attempt: d.attempt, reason: d.reason } }

        case 'provider_switch':
          return { ...s, notice: { kind: 'switch', to: d.to, reason: d.reason } }

        case 'error':
          // 错误框里会写全,状态行不必再挂着一句过期的「正在重试」
          return { ...s, error: d.error, notice: undefined }

        default:
          return s
      }
    }

    case 'message_commit':
      // ★ 提交即清空活跃块。漏掉这一句,已提交的内容会和活跃块同时显示 —— 全文重影。
      {
        const existing = s.messages.findIndex((message) => message.id === e.message.id)
        const messages = existing < 0
          ? [...s.messages, e.message]
          : s.messages.map((message, index) => (index === existing ? e.message : message))
        return {
          ...s,
          messages,
          live: [],
          tools: applyToolMessage(s.tools, e.message),
          subagents: applySubagentMessage(s.subagents, e.message)
        }
      }

    case 'tool_start':
      return {
        ...s,
        tools: {
          ...s.tools,
          [e.callId]: {
            callId: e.callId,
            name: e.toolName,
            input: e.input,
            status: 'running',
            startedAt: e.at ?? Date.now()
          }
        }
      }

    case 'tool_progress': {
      const prev = s.tools[e.callId]
      if (!prev) return s
      return { ...s, tools: { ...s.tools, [e.callId]: { ...prev, progress: e.progress.message } } }
    }

    case 'tool_end': {
      const prev = s.tools[e.callId]
      const base: ToolCallState = prev ?? {
        callId: e.callId,
        name: '(unknown)',
        input: undefined,
        status: 'running'
      }
      return {
        ...s,
        tools: {
          ...s.tools,
          [e.callId]: {
            ...base,
            status: e.isError ? 'error' : 'ok',
            output: e.output,
            progress: undefined,
            endedAt: e.at ?? Date.now()
          }
        }
      }
    }

    case 'context_usage':
      return {
        ...s,
        contextUsage: { used: e.used, window: e.window, shouldCompact: e.shouldCompact }
      }

    case 'context_status':
      return { ...s, contextStatus: e.status }

    case 'context_checkpoint': {
      const existing = s.contextCheckpoints.findIndex((item) => item.id === e.checkpoint.id)
      const checkpoints = existing < 0
        ? [...s.contextCheckpoints, e.checkpoint]
        : s.contextCheckpoints.map((item, index) => (index === existing ? e.checkpoint : item))
      return { ...s, contextCheckpoints: checkpoints, contextStatus: { phase: 'ready', windowIndex: e.checkpoint.windowIndex } }
    }

    case 'subagent_start':
      return {
        ...s,
        subagents: {
          ...s.subagents,
          [e.callId]: {
            callId: e.callId,
            childRunId: e.childRunId,
            status: 'running',
            ...(e.description === undefined ? {} : { description: e.description }),
            ...(e.subagentType === undefined ? {} : { subagentType: e.subagentType }),
            ...(e.model === undefined ? {} : { model: e.model }),
            ...(e.background === undefined ? {} : { background: e.background }),
            phase: e.background === true ? 'background' : 'starting',
            toolCalls: 0,
            toolErrors: 0,
            ...(e.at === undefined ? {} : { startedAt: e.at })
          }
        }
      }

    case 'subagent_update': {
      const previous = s.subagents[e.callId]
      if (previous === undefined) return s
      if (e.childSeq !== undefined && previous.childSeq !== undefined && e.childSeq <= previous.childSeq) return s
      return {
        ...s,
        subagents: {
          ...s.subagents,
          [e.callId]: {
            ...previous,
            ...(e.phase === undefined ? {} : { phase: e.phase }),
            // Presence matters here: `currentTool: undefined` is an explicit
            // clear sent by `tool_end`, while an omitted field means "keep the
            // last tool" for telemetry updates that do not change it.
            ...('currentTool' in e ? { currentTool: e.currentTool } : {}),
            ...(e.toolCalls === undefined ? {} : { toolCalls: e.toolCalls }),
            ...(e.toolErrors === undefined ? {} : { toolErrors: e.toolErrors }),
            ...(e.usage === undefined ? {} : { usage: addUsage(previous.usage, e.usage) }),
            ...(e.contextUsage === undefined ? {} : { contextUsage: e.contextUsage }),
            ...(e.childSeq === undefined ? {} : { childSeq: e.childSeq })
          }
        }
      }
    }

    case 'subagent_end': {
      const previous = s.subagents[e.callId]
      if (previous === undefined) return s
      if (e.childSeq !== undefined && previous.childSeq !== undefined
        && (e.childSeq < previous.childSeq || (e.childSeq === previous.childSeq && e.summary === undefined))) return s
      return {
        ...s,
        subagents: {
          ...s.subagents,
          [e.callId]: {
            ...previous,
            status: e.status,
            phase: 'finishing',
            currentTool: undefined,
            ...(e.summary === undefined ? {} : { summary: e.summary }),
            ...(e.error === undefined ? {} : { error: e.error }),
            ...(e.childSeq === undefined ? {} : { childSeq: e.childSeq }),
            ...(e.at === undefined ? {} : { endedAt: e.at })
          }
        }
      }
    }

    case 'run_end':
      return {
        ...s,
        status: e.status,
        runEndedAt: e.at ?? Date.now(),
        ...(e.error ? { error: e.error } : {})
      }

    default:
      // interaction_* 已由交互面板接管。
      return s
  }
}

export function applyEvents(s: TranscriptState, events: readonly AgentEvent[]): TranscriptState {
  return events.reduce(applyEvent, s)
}

/**
 * Project a child run's own events onto the matching parent Task card. Child
 * events arrive on the inherited IPC topic, so this keeps background runs
 * observable even after the parent run has reached its terminal state.
 */
export function applyChildEvent(
  s: TranscriptState,
  childRunId: string,
  e: AgentEvent,
  childSeq?: number
): TranscriptState {
  const entry = Object.values(s.subagents).find((item) => item.childRunId === childRunId)
  if (entry === undefined) return s
  // Parent telemetry and the inherited child topic describe the same event.
  // Whichever arrives first records the child sequence; the other is ignored.
  if (childSeq !== undefined && entry.childSeq !== undefined && childSeq <= entry.childSeq) return s
  const update = (patch: AgentEvent): TranscriptState => applyEvent(s, patch)
  const childUpdate = (patch: Extract<AgentEvent, { type: 'subagent_update' | 'subagent_end' }>): TranscriptState => update(
    childSeq === undefined ? patch : { ...patch, childSeq }
  )

  switch (e.type) {
    case 'message_commit': {
      // A detached/background child may finish after the parent run has ended,
      // so there is no parent `subagent_end` event carrying the final text.
      // Its committed assistant message is still enough to populate the card.
      const text = visibleText(e.message).trim()
      if (e.message.role !== 'assistant' || text === '') return s
      return {
        ...s,
        subagents: {
          ...s.subagents,
          [entry.callId]: {
            ...entry,
            summary: text.slice(0, 240),
            ...(childSeq === undefined ? {} : { childSeq })
          }
        }
      }
    }
    case 'stream':
      if (e.delta.type === 'message_start') {
        return childUpdate({ type: 'subagent_update', callId: entry.callId, childRunId,
          phase: 'thinking', at: undefined })
      }
      if (e.delta.type === 'message_end') {
        return childUpdate({ type: 'subagent_update', callId: entry.callId, childRunId,
          phase: 'finishing', usage: e.delta.usage })
      }
      return s
    case 'tool_start':
      return childUpdate({ type: 'subagent_update', callId: entry.callId, childRunId,
        phase: 'tool', currentTool: e.toolName, toolCalls: entry.toolCalls + 1 })
    case 'tool_end':
      return childUpdate({ type: 'subagent_update', callId: entry.callId, childRunId,
        phase: 'thinking', currentTool: undefined, toolErrors: entry.toolErrors + (e.isError ? 1 : 0) })
    case 'context_usage':
      return childUpdate({ type: 'subagent_update', callId: entry.callId, childRunId,
        contextUsage: { used: e.used, window: e.window, shouldCompact: e.shouldCompact } })
    case 'run_end':
      return childUpdate({ type: 'subagent_end', callId: entry.callId, childRunId,
        status: e.status, ...(e.error === undefined ? {} : { error: e.error }), at: e.at })
    default:
      return s
  }
}

/** 活跃块里的纯文本 —— 「正在打字」的那一段。 */
export function liveText(s: TranscriptState): string {
  return s.live
    .filter((b) => b.kind === 'text')
    .map((b) => b.text)
    .join('')
}
