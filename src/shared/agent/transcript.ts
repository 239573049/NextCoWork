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
import type { AgentEvent, RunStatus } from './event'
import type { AgentMessage, ToolOutput } from './message'
import type { TokenUsage } from './stream'

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
  status: 'running' | 'ok' | 'error'
  /** 易失,不进转录(方案 §4.3) */
  progress?: string
  output?: ToolOutput
}

export interface TranscriptState {
  /** 已提交的消息 —— 落盘的就是这些(方案 §9:绝不在 delta 上写盘) */
  messages: AgentMessage[]
  /** 当前这条助手消息里还在流的块,按 index 升序 */
  live: LiveBlock[]
  tools: Record<string, ToolCallState>
  status: RunStatus
  model?: string
  usage?: TokenUsage
  contextUsage?: { used: number; window: number; shouldCompact: boolean }
  error?: AgentError
}

export function emptyTranscript(): TranscriptState {
  return { messages: [], live: [], tools: {}, status: 'running' }
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
          return { ...s, model: d.model }

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

        case 'message_end':
          return { ...s, usage: d.usage }

        case 'error':
          return { ...s, error: d.error }

        default:
          // provider_retry / provider_switch:UI 层在这一步先不画,
          // 但它们**已经在事件流里**了(方案 §4.2)—— 第 4 步接上真上游时
          // 只需在这里加一个分支,不必回头改发射端。
          return s
      }
    }

    case 'message_commit':
      // ★ 提交即清空活跃块。漏掉这一句,已提交的内容会和活跃块同时显示 —— 全文重影。
      return { ...s, messages: [...s.messages, e.message], live: [] }

    case 'tool_start':
      return {
        ...s,
        tools: {
          ...s.tools,
          [e.callId]: { callId: e.callId, name: e.toolName, input: e.input, status: 'running' }
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
            progress: undefined
          }
        }
      }
    }

    case 'context_usage':
      return {
        ...s,
        contextUsage: { used: e.used, window: e.window, shouldCompact: e.shouldCompact }
      }

    case 'run_end':
      return { ...s, status: e.status, ...(e.error ? { error: e.error } : {}) }

    default:
      // interaction_* / subagent_* 在步骤 5、11 接管。
      return s
  }
}

export function applyEvents(s: TranscriptState, events: readonly AgentEvent[]): TranscriptState {
  return events.reduce(applyEvent, s)
}

/** 活跃块里的纯文本 —— 「正在打字」的那一段。 */
export function liveText(s: TranscriptState): string {
  return s.live
    .filter((b) => b.kind === 'text')
    .map((b) => b.text)
    .join('')
}
