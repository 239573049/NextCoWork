import type { ContentPart } from '../../../shared/agent/message'
import type { ActiveGoal, GoalChange } from '../../../shared/domain/goal'
import { invoke, on } from './ipc'

export function getGoal(sessionId: string): Promise<ActiveGoal | undefined> {
  return invoke('goal:get', { sessionId })
}

/**
 * 设立 / 覆盖目标。
 *
 * ★ 返回里的 `kickoff` 是主进程给的那条 **internal** 消息 —— 原样发出去，
 *   不要在这里改写或翻译：它是进模型上下文的 prompt，措辞是被调过的
 *   （见 `main/goal/prompt.ts` 文件头）。
 */
export function setGoal(
  sessionId: string,
  condition: string
): Promise<
  | { ok: true; goal: ActiveGoal; kickoff: ContentPart[] }
  | { ok: false; reason: 'empty' | 'too_long'; length: number }
> {
  return invoke('goal:set', { sessionId, condition })
}

export function clearGoal(sessionId: string): Promise<void> {
  return invoke('goal:clear', { sessionId })
}

export function onGoalChanged(
  callback: (payload: GoalChange) => void
): () => void {
  return on('goal:changed', callback)
}
