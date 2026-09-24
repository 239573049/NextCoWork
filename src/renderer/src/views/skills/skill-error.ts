/**
 * Skill 安装 / 开关的错误 → 用户能读的一句话。
 *
 * ## 为什么用白名单而不是「直接 t(key)」
 *
 * 主进程**只传 key**(`throw new Error('skills.authRequired')`),渲染层 `t()`
 * 之后才是人话。但 `TranslationKey` 是编译期封闭联合,从主进程飘来的字符串
 * 得先收窄 —— 不收窄直接 `t(key as TranslationKey)` 的话,一个拼错的 key 会被
 * 原样画到界面上。走白名单的好处是**认不出的一律落到通用文案**。
 *
 * ★ 名单必须与 `main/ipc/skills.ts` 抛出的 key 保持一致。形状同插件那边的
 *   `plugin-error.ts` —— 两个功能的失败在界面上挨着,收窄的规矩不该有两套。
 */
import type { TranslationKey } from '../../i18n'

const KNOWN = [
  'skills.authRequired',
  'skills.clientAssetsUnavailable',
  'skills.scopeRequired',
  'skills.versionUnavailable',
  'skills.networkFailed',
  'skills.digestMismatch',
  'skills.packageTooLarge'
] as const

export function skillErrorKey(error: unknown): TranslationKey {
  return skillMessageKey(error instanceof Error ? error.message : '')
}

/**
 * 同上,但收的是一个**裸字符串**。
 *
 * ★ `skills:installProgress` 的 `failed` 帧带的是 `messageKey`,不是一个 Error ——
 * 别的窗口只能从这条事件知道为什么失败(invoke 的 rejection 只有发起那个窗口
 * 拿得到)。收窄的规矩必须和 `skillErrorKey` 是同一套,否则同一次失败在两个
 * 窗口上会显示成两句不同的话。
 */
export function skillMessageKey(raw: string): TranslationKey {
  for (const key of KNOWN) {
    if (raw === key || raw.startsWith(`${key}:`)) return key
  }
  return 'skills.operationFailed'
}
