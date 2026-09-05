/**
 * 往 UI 推的事件 —— 方案 §4.2。它是 ProviderStreamEvent 的**超集**。
 *
 * 分两层的原因:ProviderStreamEvent 是「上游那一层」的词汇(text_delta、tool_call_delta),
 * 内核和网关都用;AgentEvent 多出内核才知道的东西(落盘边界、待决交互、子代理、上下文压力)。
 */
import type { AgentError } from './error'
import type { AgentMessage } from './message'
import type { PendingInteraction, InteractionOutcome } from './interaction'
import type { ProviderStreamEvent } from './stream'
import type { TokenUsage } from './stream'
import type { ToolOutput } from './message'
import type { ToolProgress } from './tool'
import type { ContextCheckpoint, ContextStatus } from './context-management'

export type RunStatus = 'running' | 'done' | 'error' | 'aborted'

export type SubagentPhase = 'starting' | 'thinking' | 'tool' | 'finishing' | 'background'

export type AgentEvent =
  | { type: 'stream'; delta: ProviderStreamEvent }
  /** ★ 落盘边界 —— db 只在这里写,绝不在 delta 上写(方案 §9) */
  | { type: 'message_commit'; message: AgentMessage }
  /**
   * `at` 是主进程打的墙钟毫秒,用来算工具耗时。
   *
   * ★ **可选**:发射端还没填的时候,转录 reducer 退化到自己 `Date.now()`。
   * 这让「先上渲染层版本、之后再补主进程戳」不必改 UI 一行代码,
   * 也让已落盘的旧事件重放时不会因为缺字段而失败。
   */
  | { type: 'tool_start'; callId: string; toolName: string; input: unknown; at?: number }
  /** 易失,永不进转录 */
  | { type: 'tool_progress'; callId: string; progress: ToolProgress }
  | { type: 'tool_end'; callId: string; output: ToolOutput; isError: boolean; at?: number }
  | { type: 'interaction_request'; interaction: PendingInteraction }
  | { type: 'interaction_resolved'; id: string; outcome: InteractionOutcome }
  | {
      type: 'subagent_start'
      callId: string
      childRunId: string
      description?: string
      subagentType?: string
      model?: string
      background?: boolean
      at?: number
    }
  | {
      type: 'subagent_update'
      callId: string
      childRunId: string
      phase?: SubagentPhase
      currentTool?: string
      toolCalls?: number
      toolErrors?: number
      usage?: TokenUsage
      contextUsage?: { used: number; window: number; shouldCompact: boolean }
      /** Sequence of the corresponding child-run event, used to deduplicate the inherited raw event. */
      childSeq?: number
      at?: number
    }
  | {
      type: 'subagent_end'
      callId: string
      childRunId: string
      status: RunStatus
      summary?: string
      /** Sequence of the child run_end event, used to deduplicate the inherited raw event. */
      childSeq?: number
      at?: number
    }
  /** ★ 抄自 agent-request-flow.md §4 的 agent:contextUsage —— 见下方注释 */
  | { type: 'context_usage'; used: number; window: number; shouldCompact: boolean }
  | { type: 'context_status'; status: ContextStatus }
  | { type: 'context_checkpoint'; checkpoint: ContextCheckpoint }
  /** `at` is the wall-clock time at which the run reached its terminal state. */
  | { type: 'run_end'; status: RunStatus; error?: AgentError; at?: number }

/**
 * ★ context_usage 每轮由 ContextAssembler 算完请求后顺手发一条,
 * UI 拿它画上下文压力条并在逼近上限时提示 /compact。
 *
 * **上下文用尽是这类应用最高频的失败,而它现在是可以提前看见的** ——
 * 事后补要动每一个 emit 点。
 */

/** attach 的返回值(方案 §4.6:重新加载的渲染层要把三种框都重新画出来)。 */
export interface RunSnapshot {
  runId: string
  sessionId: string
  workspaceId: string
  parentRunId?: string
  depth: number
  status: RunStatus
  /** Wall-clock bounds are optional for snapshots created by older runtimes. */
  startedAt?: number
  endedAt?: number
  /** 快照产出时的 seq;渲染层据此续接增量 */
  seq: number
  /** sinceSeq 之后的事件,按序 */
  events: AgentEvent[]
  /** ★ 不叫 pendingApprovals —— 三种 kind 共用一张表 */
  pendingInteractions: PendingInteraction[]
  /** 子 run 的 id,UI 上是可展开节点 */
  children: string[]
}

/** run 结束后不再有事件,UI 可以据此收掉 loading 态。 */
export function isTerminal(s: RunStatus): boolean {
  return s !== 'running'
}
