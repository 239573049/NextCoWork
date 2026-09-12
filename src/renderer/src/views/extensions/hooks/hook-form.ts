/**
 * 钩子表单的校验 —— 纯函数，理由同 `shared/filter.ts`（`.tsx` 测不到）。
 */
import {
  HOOK_MAX_TIMEOUT_MS,
  hasWeakBlockingMatcher,
  isValidHookMatcher,
  type HookEvent
} from '../../../../../shared/domain/hook'

export interface HookDraft {
  event: HookEvent
  matcher: string
  command: string
  timeoutSeconds: number
  description: string
  enabled: boolean
}

/** 阻断错误：不修好就不能保存。 */
export function validateHook(draft: HookDraft): string | null {
  if (draft.command.trim() === '') return 'hooks.error.emptyCommand'
  if (!isValidHookMatcher(draft.matcher)) return 'hooks.error.badMatcher'
  if (!Number.isFinite(draft.timeoutSeconds) || draft.timeoutSeconds <= 0) return 'hooks.error.badTimeout'
  if (draft.timeoutSeconds * 1000 > HOOK_MAX_TIMEOUT_MS) return 'hooks.error.timeoutTooLong'
  return null
}

/**
 * 非阻断警告：能保存，但用户大概率理解错了。
 *
 * ★ 前缀 matcher 用在阻断型事件上是**方向反的**：`Bash(rm:*)` 那条 shell 接续符
 *   保护是给「放行」设计的（不命中就不放行，偏保守）；用在拦截上变成了
 *   「不命中就放行」—— 一条 `rm -rf / && echo ok` 正好绕过去。
 */
export function warnHook(draft: HookDraft): string | null {
  if (hasWeakBlockingMatcher({ event: draft.event, matcher: draft.matcher })) return 'hooks.warn.weakMatcher'
  return null
}
