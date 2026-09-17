/**
 * 钩子表单的校验 —— 纯函数，理由同 `shared/filter.ts`（`.tsx` 测不到）。
 */
import {
  HOOK_COMMAND_MAX,
  HOOK_MAX_TIMEOUT_MS,
  HOOK_PROMPT_MAX,
  defaultTimeoutMs,
  hasWeakBlockingMatcher,
  isValidHookMatcher,
  type HookEvent,
  type HookType,
  type HookUpsert
} from '../../../../../shared/domain/hook'
import type { HookTemplate } from '../../../../../shared/domain/hook-templates'

/**
 * 弹层里那一份草稿。
 *
 * ★ `command` 和 `prompt` **两个字段都留着**，不按类型二选一：用户在两种类型之间
 *   来回切时，他已经写好的那一段不该被清掉（切回来发现空了，是最让人恼火的一种
 *   表单行为）。保存时按 `type` 只取其中一个。
 */
export interface HookDraft {
  event: HookEvent
  type: HookType
  matcher: string
  command: string
  prompt: string
  /** prompt 型的判定模型。空 = 回落到本次 run 的模型。 */
  model: string
  modelProviderId: string
  timeoutSeconds: number
  description: string
  enabled: boolean
}

export function emptyHookDraft(event: HookEvent, type: HookType = 'command'): HookDraft {
  return {
    event,
    type,
    matcher: '',
    command: '',
    prompt: '',
    model: '',
    modelProviderId: '',
    timeoutSeconds: defaultTimeoutMs(event, type) / 1000,
    description: '',
    enabled: true
  }
}

/**
 * 模板 → 表单草稿。
 *
 * ★ 抽成纯函数而不是写在 `onValueChange` 里：`vitest.config.ts` 的 include 是
 *   `src/**\/*.test.ts`，不含 `.tsx` —— 留在组件里的话，「选了模板但 matcher 没填上」
 *   这种错一行测试也覆盖不到。
 *
 * `description` 由调用方传（它要走 i18n，而这一层不认识 `t`）。
 */
export function templateToDraft(template: HookTemplate, description: string): HookDraft {
  return {
    ...emptyHookDraft(template.event),
    matcher: template.matcher ?? '',
    command: template.command,
    timeoutSeconds: template.timeoutSeconds,
    description
  }
}

/**
 * 草稿 → `hooks:save` 收的形状。
 *
 * ★ 按 `type` **只取一支**：把两个正文字段都发上去的话，一条 prompt 钩子会带着
 *   一段用户早就改主意了的命令写进文件，而文件是给人手看的。
 */
export function draftToUpsert(draft: HookDraft, id?: string): HookUpsert {
  const base = {
    ...(id === undefined ? {} : { id }),
    event: draft.event,
    ...(draft.matcher.trim() === '' ? {} : { matcher: draft.matcher.trim() }),
    enabled: draft.enabled,
    timeoutMs: Math.round(draft.timeoutSeconds * 1000),
    ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() })
  }
  if (draft.type === 'prompt') {
    const model = draft.model.trim()
    return {
      ...base,
      type: 'prompt',
      prompt: draft.prompt.trim(),
      ...(model === '' ? {} : { model }),
      // 供应商只在有别名时才带 —— 单独一个供应商 id 配不出任何一条绑定。
      ...(model === '' || draft.modelProviderId.trim() === ''
        ? {}
        : { modelProviderId: draft.modelProviderId.trim() })
    }
  }
  return { ...base, type: 'command', command: draft.command.trim() }
}

/** 阻断错误：不修好就不能保存。 */
export function validateHook(draft: HookDraft): string | null {
  if (draft.type === 'prompt') {
    if (draft.prompt.trim() === '') return 'hooks.error.emptyPrompt'
    if (draft.prompt.trim().length > HOOK_PROMPT_MAX) return 'hooks.error.promptTooLong'
  } else {
    if (draft.command.trim() === '') return 'hooks.error.emptyCommand'
    if (draft.command.trim().length > HOOK_COMMAND_MAX) return 'hooks.error.commandTooLong'
  }
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
