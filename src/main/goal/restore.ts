/**
 * 重载恢复 —— 从转录反扫「这条会话还挂着一个目标吗」。
 *
 * ## 为什么是转录，不是一份状态文件
 *
 * 目标本身是进程内状态（`state.ts`），不落盘。落盘的是助手消息上那条
 * `goal_status` part —— 它已经跟着转录走了完整的持久化路径（`commitMessage`
 * → SQLite → `getHistory`），不需要第二份存储，也就不会出现两份不一致。
 *
 * ## 恢复**只重建状态，不重开一轮 run**
 *
 * 这是用户的明确选择，也和 `shared/domain/session.ts` 那条「永不恢复运行中状态」
 * 不冲突：恢复的是**目标**（一个待满足的条件），不是一个运行中的 run。
 * 用户下次发消息时，回合末判定自然接上。
 *
 * ★ 纯函数、零 IO —— 反扫的正确性全在这几行里，所以它要能逐条单测。
 */
import { mergeGoalStatusMessage, type AgentMessage, type ContentPart } from '../../shared/agent/message'
export { mergeGoalStatusMessage } from '../../shared/agent/message'
import { GOAL_CONDITION_MAX, normalizeGoalCondition } from '../../shared/domain/goal'

type GoalStatus = Extract<ContentPart, { type: 'goal_status' }>

/**
 * 从后往前找**最后一条** `goal_status`，据此判断要不要重新挂上目标。
 *
 * - 最后一条是 `met` / `failed` / `cleared` → 那个目标已经结束，返回 `null`。
 * - 最后一条是「未达成」→ 目标当时是活的，返回它的条件。
 * - 一条都没有 → 这条对话从来没设过目标，返回 `null`。
 *
 * ★ 只认**最后一条**：一条会话先后设过三个目标时，前两条的标记仍然留在转录里
 *   （那是历史，该留着），但只有最后一条描述的是「现在」。
 */
export function restorableGoalCondition(messages: readonly AgentMessage[]): string | null {
  const last = lastGoalStatus(messages)
  if (last === null) return null
  // ★ 三个终态**都要判**。只判 `met` 的话，一个被用户亲手清掉的目标会在重载后
  //   自己回来 —— 而他清它正是因为不想再跑了。
  if (last.met || last.failed === true || last.cleared === true) return null
  const condition = normalizeGoalCondition(last.condition)
  return condition === '' || condition.length > GOAL_CONDITION_MAX ? null : condition
}

/** 最后一条目标标记本身（诊断与测试用）。 */
export function lastGoalStatus(messages: readonly AgentMessage[]): GoalStatus | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const parts = message.parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as ContentPart
      if (part.type === 'goal_status') return part
    }
  }
  return null
}

export function mergeGoalStatusHistory(messages: readonly AgentMessage[], latest: readonly AgentMessage[]): AgentMessage[] {
  const byId = new Map(latest.map((message) => [message.id, message]))
  return messages.map((message) => mergeGoalStatusMessage(message, byId.get(message.id)))
}
