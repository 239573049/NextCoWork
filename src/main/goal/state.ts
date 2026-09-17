/**
 * 目标状态机 —— 一份**进程内**状态 + 一条广播。
 *
 * ## 为什么不落盘
 *
 * 落盘的是转录里那条 `goal_status` part（见 `shared/agent/message.ts`），
 * 重载后靠 `restore.ts` 从它反扫。状态本身写进 `settings.local.json` 会让
 * 「重载应用后一个早就结束的目标还在文件里」和「用户手改文件叠出两条目标」
 * 两件事都发生 —— 同 `hook-registry.ts` 文件头那段。
 *
 * ## 一条会话同时只有一个目标
 *
 * `setActiveGoal` 里必须**先清旧的**再装新的。漏掉的话一条会话里会同时挂着
 * 两条 prompt 钩子：判定跑两遍、账单翻倍，而两遍的结论还可能不一样
 * （它们各自独立调用模型）。
 */
import type { ActiveGoal, GoalClearReason } from '../../shared/domain/goal'
import type { HookDefinition } from '../../shared/domain/hook'
import { PROMPT_HOOK_DEFAULT_TIMEOUT_MS } from '../../shared/domain/hook'
import { clearRuntimeHooks, registerRuntimeHook, removeRuntimeHook } from '../hook-registry'
import { goalEvaluatorQuestion } from './prompt'

interface GoalEntry {
  goal: ActiveGoal
  hookId: string
  controller: AbortController
}

const goals = new Map<string, GoalEntry>()
const initialized = new Set<string>()
const revisions = new Map<string, number>()
export function goalRevision(sessionId: string): number { return revisions.get(sessionId) ?? 0 }
type Listener = (sessionId: string, goal?: ActiveGoal, reason?: GoalClearReason) => void
const listeners = new Set<Listener>()

export function goalWasInitialized(sessionId: string): boolean {
  return initialized.has(sessionId)
}

export function markGoalInitialized(sessionId: string): void {
  initialized.add(sessionId)
}

/** Clearing/replacing a goal also cancels its in-flight evaluation. */
export function goalSignal(sessionId: string): AbortSignal | undefined {
  return goals.get(sessionId)?.controller.signal
}

/**
 * 目标注册的那条钩子的 id。
 *
 * ★ 按 session 推导而不是 mint 一个 ULID：一条会话在任何时刻只该有一条 goal 钩子，
 *   推导出来的 id 让「重复注册」在 `registerRuntimeHook` 的 upsert 里自动收敛成一条，
 *   而不是靠调用方记得先摘。
 */
export function goalHookId(sessionId: string): string {
  return `goal:${sessionId}`
}

export function getActiveGoal(sessionId: string): ActiveGoal | undefined {
  return goals.get(sessionId)?.goal
}

export function listActiveGoals(): ReadonlyMap<string, ActiveGoal> {
  return new Map([...goals].map(([id, entry]) => [id, entry.goal]))
}

/** 目标生效 —— 先摘旧钩子并取消旧判定，再装新钩子。 */
export function setActiveGoal(sessionId: string, goal: ActiveGoal): void {
  clearActiveGoal(sessionId, 'superseded')
  initialized.add(sessionId)
  goals.set(sessionId, { goal, hookId: goalHookId(sessionId), controller: new AbortController() })
  mountGoalHook(sessionId)
  notify(sessionId, goal)
}

/** 后台工作完成、或下一次 run 开始时重新挂载；不会重置轮数。 */
export function mountGoalHook(sessionId: string): void {
  const entry = goals.get(sessionId)
  if (entry === undefined) return
  const hook: HookDefinition = {
    id: entry.hookId,
    type: 'prompt',
    event: 'Stop',
    prompt: goalEvaluatorQuestion(entry.goal.condition),
    enabled: true,
    timeoutMs: PROMPT_HOOK_DEFAULT_TIMEOUT_MS
  }
  registerRuntimeHook(sessionId, hook)
}

export function unmountGoalHook(sessionId: string): void {
  removeRuntimeHook(sessionId, goalHookId(sessionId))
}

/** 只改状态，不动钩子（判未达成后累加轮数那条路）。 */
export function updateActiveGoal(sessionId: string, patch: Partial<ActiveGoal>): ActiveGoal | undefined {
  const entry = goals.get(sessionId)
  if (entry === undefined) return undefined
  const next = { ...entry.goal, ...patch }
  goals.set(sessionId, { ...entry, goal: next })
  notify(sessionId, next)
  return next
}

/**
 * 摘钩子 + 清状态 + 广播。
 *
 * ★ `reason` 这一层不用，但**必须在签名里**：清除的原因是遥测唯一的分叉依据
 *   （`met` 和 `user_clear` 在用户眼里是两件完全不同的事），而调用方就是在
 *   这一行决定它的。让调用方把原因记在别处，两边迟早对不上。
 *   记录发生在 `runtime.ts` 的 `deactivateGoal` —— 那里拿得到被清掉的那一条。
 */
export function clearActiveGoal(sessionId: string, reason: GoalClearReason): ActiveGoal | undefined {
  // A user's newer intent invalidates a held approval; automatic completion does not.
  if (reason !== 'met' && reason !== 'impossible') revisions.set(sessionId, goalRevision(sessionId) + 1)
  initialized.add(sessionId)
  const entry = goals.get(sessionId)
  if (entry === undefined) return undefined
  removeRuntimeHook(sessionId, entry.hookId)
  goals.delete(sessionId)
  entry.controller.abort()
  notify(sessionId, undefined, reason)
  return entry.goal
}

export function onGoalChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(sessionId: string, goal?: ActiveGoal, reason?: GoalClearReason): void {
  for (const listener of listeners) {
    try {
      listener(sessionId, goal, reason)
    } catch {
      // 一个坏掉的监听者不该让目标本身设不上。
    }
  }
}

/** Runtime listeners are process-scoped; callers must unsubscribe their test listeners. */
export function resetGoalsForTest(): void {
  for (const sessionId of [...goals.keys()]) clearActiveGoal(sessionId, 'session_ended')
  initialized.clear()
  revisions.clear()
  clearRuntimeHooks()
}
