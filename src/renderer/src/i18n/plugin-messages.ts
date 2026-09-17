/**
 * 运行期注册进来的文案 —— 插件的那一份。
 *
 * ## 为什么内置 catalog 不能直接容纳它们
 *
 * `index.tsx` 的 `ZH` / `EN` 是**模块级常量**,`TranslationKey` 是
 * `keyof typeof ZH` 这个编译期封闭联合。插件在编译期根本不存在,它的 key
 * 一个都进不了那个联合 —— 所以贡献 UI 的插件要么把裸文案塞进界面(违反
 * 项目 AGENTS.md 的第一条),要么它的每一个按钮都显示成 key 本身。
 *
 * 这个文件开的口子刻意只有一个:**`plugin.<pluginId>.` 前缀**。内置 key 仍然
 * 封闭,拼错一个内置 key 照样编译期就挂。
 *
 * ## 四条约束,每一条都对应一种事故
 *
 * 1. **前缀强制**。不校验的话,一个插件注册 `common.confirm` 就能把全应用的
 *    「确认」按钮改写成任意文字 —— 那是 UI 层面的一次完整劫持,而且用户看不出
 *    文案是谁改的。
 * 2. **跨插件冲突整体拒绝**,不是部分接受。半份生效的 catalog 会让界面一半中文
 *    一半 key,而诊断里只会记「有冲突」——排查时看到的症状和原因对不上。
 * 3. **有配额**。key 数和单条长度都卡上限:这份表活在渲染进程里,而且每次
 *    合并视图失效都要整体重建一次。
 * 4. **卸载必须能卸干净**。`unregisterPluginMessages` 按 pluginId 整体摘除 ——
 *    留一条就意味着禁用插件之后它的文案还在界面上,而那个功能已经没了。
 */
import type { Locale, Messages } from './index'

/** key 的形状:`plugin.<publisher>.<name>.<...>`,和清单里的插件 id 对齐。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/

/** 单个插件最多注册多少条。一份人工维护的 l10n bundle 长到这个数已经不正常了。 */
export const MAX_PLUGIN_MESSAGES = 500

/** 单条文案的字符上限。界面上的一句话,不是一篇文档。 */
export const MAX_PLUGIN_MESSAGE_LENGTH = 1024

/** `pluginId → locale → dict`。按插件分桶,卸载时整桶丢。 */
const byPlugin = new Map<string, Map<Locale, Readonly<Record<string, string>>>>()

/**
 * 合并视图的版本号。
 *
 * ★ **`0` 有特殊含义:一条插件文案都没有。** 此时 `messagesFor()` 直接返回
 * 那个模块级常量,和改造之前逐字一样 —— 没装插件的用户不为这套机制付任何代价
 * (`t()` 在热路径上,每次渲染要走几百次)。
 */
let version = 0

const listeners = new Set<() => void>()

export class PluginMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginMessageError'
  }
}

/**
 * 装一份 catalog。**要么整份进,要么一条都不进。**
 *
 * ★ 违规时 **throw**,不是静默忽略:调用方是宿主侧的装载代码(不是插件代码),
 * 它要把这个异常变成插件详情页上的一条诊断。静默忽略的表现是插件作者对着
 * 一屏 key 发呆,而日志里什么都没有。
 */
export function registerPluginMessages(
  pluginId: string,
  locale: Locale,
  dict: Readonly<Record<string, string>>
): void {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new PluginMessageError(`invalid plugin id: ${pluginId}`)
  }
  const entries = Object.entries(dict)
  if (entries.length > MAX_PLUGIN_MESSAGES) {
    throw new PluginMessageError(
      `${pluginId}: ${String(entries.length)} messages exceeds the ${String(MAX_PLUGIN_MESSAGES)} limit`
    )
  }

  const prefix = `plugin.${pluginId}.`
  const taken = keysOwnedByOthers(pluginId, locale)
  const next: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!key.startsWith(prefix)) {
      throw new PluginMessageError(`${pluginId}: key "${key}" must start with "${prefix}"`)
    }
    if (typeof value !== 'string' || value.length > MAX_PLUGIN_MESSAGE_LENGTH) {
      throw new PluginMessageError(`${pluginId}: value for "${key}" is not a bounded string`)
    }
    // 前缀已经把跨插件冲突挡掉了;这一条守的是前缀规则将来被放宽的那一天。
    if (taken.has(key)) {
      throw new PluginMessageError(`${pluginId}: key "${key}" is already registered by another plugin`)
    }
    next[key] = value
  }

  const locales = byPlugin.get(pluginId) ?? new Map<Locale, Readonly<Record<string, string>>>()
  locales.set(locale, Object.freeze(next))
  byPlugin.set(pluginId, locales)
  bump()
}

/** 禁用 / 卸载插件时调。没注册过也安全。 */
export function unregisterPluginMessages(pluginId: string): void {
  if (!byPlugin.delete(pluginId)) return
  bump()
}

/** 主要给测试用:把进程内那张表清空。 */
export function clearPluginMessages(): void {
  if (byPlugin.size === 0) return
  byPlugin.clear()
  bump()
}

/** 这一刻所有插件在该语言下的合并 dict。`messagesFor()` 拿它去覆盖内置表。 */
export function pluginMessages(locale: Locale): Messages {
  const out: Record<string, string> = {}
  for (const locales of byPlugin.values()) {
    Object.assign(out, locales.get(locale) ?? {})
  }
  return out
}

/**
 * 合并视图的版本号,给 `useSyncExternalStore` 当快照。
 *
 * 返回 `0` 表示「没有任何插件文案」,见 `version` 上的说明。
 */
export function pluginMessagesVersion(): number {
  return version
}

/**
 * 订阅变更。★ `I18nProvider` 必须订阅它,否则装完插件要重启才看得见文案 ——
 * 而「重启一下试试」正是插件系统最不该有的第一印象。
 */
export function subscribePluginMessages(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function keysOwnedByOthers(pluginId: string, locale: Locale): ReadonlySet<string> {
  const taken = new Set<string>()
  for (const [id, locales] of byPlugin) {
    if (id === pluginId) continue
    for (const key of Object.keys(locales.get(locale) ?? {})) taken.add(key)
  }
  return taken
}

function bump(): void {
  version += 1
  for (const listener of listeners) listener()
}
