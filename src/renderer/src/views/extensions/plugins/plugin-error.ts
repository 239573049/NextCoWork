/**
 * 插件错误 → 用户能读的一句话。
 *
 * ## 为什么需要这一层
 *
 * 主进程**只传 key**(`IpcError('auth', 'plugins.authRequired')`),渲染层 `t()` 之后
 * 才是人话 —— 这是计划 §8.3 定下的规矩。但插件面板一开始直接把
 * `cause.message` 塞进了界面,于是用户看到的是 `plugins.authRequired` 这个
 * 原始 key,而它当时连词条都没有。
 *
 * ## 为什么用白名单而不是「直接 t(key)」
 *
 * `TranslationKey` 是编译期封闭联合,运行期从主进程飘来的字符串要先收窄。
 * 不加白名单直接 `t(key as TranslationKey)` 的话,一个拼错的 key 会被原样
 * 显示给用户 —— 和现在这个 bug 一模一样,只是换了个触发点。走白名单的好处是
 * **认不出的一律落到通用文案**,而不是把内部标识漏出去。
 *
 * ★ 名单必须与 `main/ipc/plugin-market.ts`、`main/ipc/plugins.ts` 里抛出的
 * key 保持一致。`plugin-error.test.ts` 钉住这一点。
 */
import type { TranslationKey } from '../../../i18n'

/**
 * 主进程会抛出来的那些 key。
 *
 * ★ `plugins.marketFailed` 在客户端是**带状态码**的(`plugins.marketFailed:404`)——
 * 主进程为了诊断把 HTTP 状态拼在了后面。这里比对的是前缀,否则它永远落进
 * 兜底分支,而「市场不可用」正好是最需要说清楚的那一条。
 */
const KNOWN = [
  'plugins.authRequired',
  'plugins.scopeRequired',
  'plugins.versionUnavailable',
  'plugins.digestMismatch',
  'plugins.marketFailed',
  'plugins.packageTooLarge',
  'plugins.installPackageFailed',
  'plugins.notRunning',
  'plugins.state'
] as const

export function pluginErrorKey(error: unknown): TranslationKey {
  return pluginMessageKey(error instanceof Error ? error.message : '')
}

/**
 * 同上,但收的是一个**裸字符串**。
 *
 * ★ `plugins:installProgress` 的 `failed` 帧带的是 `messageKey`,不是一个
 * Error —— 别的窗口只能从这条事件知道为什么失败(invoke 的 rejection 只有
 * 发起那个窗口拿得到)。收窄的规矩必须和 `pluginErrorKey` 是同一套,
 * 否则同一次失败在两个窗口上会显示成两句不同的话。
 */
export function pluginMessageKey(raw: string): TranslationKey {
  for (const key of KNOWN) {
    if (raw === key || raw.startsWith(`${key}:`)) return key
  }
  return 'plugins.operationFailed'
}
