/**
 * 运行期钩子表 —— 只活在进程内存里的那一批钩子。
 *
 * ## 为什么不写进 `settings.local.json`
 *
 * 会话目标（goal）在生效时会注册一条内置的 `Stop` prompt 钩子。落盘的话两件事
 * 都会发生：重载应用之后一个早就结束的目标还挂在文件里；用户手改文件时会把两条
 * goal 钩子叠在一起（判定跑两遍、账单翻倍，而两遍的结论还可能不一样）。
 * 它是**运行期状态**，生命周期跟着 session 走，不跟着磁盘走。
 *
 * ## 和文件里那些是并列关系，不是覆盖关系
 *
 * `hooksFor()` 把两边拼起来（全局文件 → 项目文件 → 运行期），
 * `MAX_HOOKS_PER_EVENT` 的上限对**合并后**的总数生效。
 */
import type { HookDefinition } from '../shared/domain/hook'

/** sessionId → 这条会话名下的运行期钩子。 */
const registry = new Map<string, HookDefinition[]>()

/**
 * 注册（按 id upsert）。
 *
 * ★ upsert 而不是 push：同一条 goal 钩子在一次 run 里可能被重新挂上
 *   （后台推迟判定摘掉、下一轮再装回来），push 会让它越叠越多。
 */
export function registerRuntimeHook(sessionId: string, hook: HookDefinition): void {
  const existing = registry.get(sessionId) ?? []
  registry.set(sessionId, [...existing.filter((h) => h.id !== hook.id), hook])
}

export function removeRuntimeHook(sessionId: string, hookId: string): void {
  const existing = registry.get(sessionId)
  if (existing === undefined) return
  const kept = existing.filter((h) => h.id !== hookId)
  if (kept.length === 0) registry.delete(sessionId)
  else registry.set(sessionId, kept)
}

export function runtimeHooksFor(sessionId: string): readonly HookDefinition[] {
  return registry.get(sessionId) ?? []
}

/**
 * 清掉一条会话（或全部）的运行期钩子。
 *
 * ★ 不传 sessionId = 全清，只给 `resetRuntimeForTest()` 用：跨用例泄漏会让
 *   下一个用例被上一个用例的钩子叫醒（同 `subagentQueue.reset()` 的理由）。
 */
export function clearRuntimeHooks(sessionId?: string): void {
  if (sessionId === undefined) registry.clear()
  else registry.delete(sessionId)
}
