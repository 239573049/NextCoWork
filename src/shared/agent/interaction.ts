/**
 * 阻塞式人机往返不止一种 —— 方案 §4.6。
 *
 * 参考实现里有 `agent:tool-approval`(工具授权)和 `agent:ask-user`(Agent 反问),
 * 各自还配了一个重连恢复频道;再加上截图里「任务完成 / 权限审批 / **计划审批**」
 * 三类通知音效,说明还有第三种。
 *
 * **三种是同一个机制**:内核挂起 → 登记待决项 → UI 呈现 → 用户回答 → 内核恢复。
 * 分三套写就是三张待决表、三个重连恢复频道、三次 IPC 签名变更。
 * 现在合并成一个 union 是十几行。
 */
import type { PermissionDecision } from './permission'

export type InteractionKind = PendingInteraction['kind']

export type PendingInteraction =
  | {
      kind: 'tool_permission'
      id: string
      runId: string
      callId: string
      toolName: string
      input: unknown
      readOnly: boolean
      destructive: boolean
      createdAt: number
    }
  | {
      kind: 'ask_user'
      id: string
      runId: string
      question: string
      choices?: string[]
      allowFreeform: boolean
      createdAt: number
    }
  | {
      kind: 'plan_approval'
      id: string
      runId: string
      plan: string
      createdAt: number
    }

export type InteractionResponse =
  | { id: string; kind: 'tool_permission'; decision: PermissionDecision }
  /** null = dismiss(用户关掉了框,不是回答) */
  | { id: string; kind: 'ask_user'; answer: string | null }
  | { id: string; kind: 'plan_approval'; approved: boolean; feedback?: string }

/** 待决项的最终去向。`aborted` 是中断路径写进去的(方案 §4.8 第 2 步)。 */
export type InteractionOutcome =
  | { status: 'answered'; response: InteractionResponse }
  | { status: 'aborted' }
  | { status: 'expired' }

/**
 * ★ 待决状态必须是**可查询的持久状态**,不能只是一个挂着的 Promise。
 * 失败模式很具体:渲染层重载 / 窗口关闭 / 崩溃 → promise 永不 settle →
 * 整个 run 无声挂死,握着一个打开的上游流和一个未完成的工具调用,UI 上什么都看不到。
 *
 * 所以 `agent:attach` 的返回值里带 `pendingInteractions`,
 * `agent:listInteractions` 是它的独立查询入口。
 */

/** 三类通知音效直接挂在这上面(方案 §4.6)。 */
export const INTERACTION_SOUND: Record<InteractionKind, 'approval' | 'plan' | 'ask'> = {
  tool_permission: 'approval',
  plan_approval: 'plan',
  ask_user: 'ask'
}

export function interactionTitle(i: PendingInteraction): string {
  switch (i.kind) {
    case 'tool_permission':
      return `允许执行 ${i.toolName}?`
    case 'ask_user':
      return i.question
    case 'plan_approval':
      return '确认执行方案?'
  }
}
