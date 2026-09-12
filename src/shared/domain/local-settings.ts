/**
 * `<工作区>/.next-cowork/settings.local.json` —— **项目级、本机私有**的设置文件。
 *
 * 名字里的 `.local` 和 Claude Code 同义:它记的是「这台机器上的这个人」做过的决定
 * (最典型的就是「以后都允许执行这条命令」),所以应该进 `.gitignore`,
 * 不应该替队友做决定。
 *
 * ★ 这个文件**会继续长**。所以三条约定从第一天就立住:
 *
 * 1. **分段命名**。每一类设置占一个顶层键(`permissions`、`hooks`),
 *    新增能力就是新增一个键,不往已有的段里塞不相干的字段。
 * 2. **读的时候宽容**。认不出来的段、认不出来的规则一律忽略,绝不因为文件里有
 *    一行看不懂的东西就拒绝整个文件 —— 那会让一个旧版本的应用把用户的工作区锁死。
 * 3. **写的时候原样保留未知键**(见 `main/kernel/local-settings.ts`)。
 *    新版本写进去的段,旧版本改一次规则不能把它抹掉。
 */
import { isValidPermissionRule } from '../agent/permission-rule'
import {
  HOOK_COMMAND_MAX,
  HOOK_MAX_TIMEOUT_MS,
  MAX_HOOKS_PER_EVENT,
  defaultTimeoutMs,
  isHookEvent,
  isValidHookMatcher,
  type HookEvent,
  type HookFileEntry,
  type HookSettings
} from './hook'

export const LOCAL_SETTINGS_DIRNAME = '.next-cowork'
export const LOCAL_SETTINGS_FILENAME = 'settings.local.json'
export const LOCAL_SETTINGS_VERSION = 1

/** 一个桶的上限。规则是线性扫的,而且一份人手维护的清单长到这个数就已经没人读得懂了。 */
export const MAX_RULES_PER_BUCKET = 500

/**
 * 三个桶,优先级 deny > ask > allow(接线在 `runtime.ts`):
 * - `deny`:永远拒绝,连档位都放宽不了
 * - `ask` :强制询问,用来把某个 `full` 档下本来会静默放行的操作重新捞回人眼前
 * - `allow`:免审批,「以后都允许」写的就是这里
 */
export type PermissionRuleBucket = 'allow' | 'ask' | 'deny'
export const PERMISSION_RULE_BUCKETS: readonly PermissionRuleBucket[] = ['deny', 'ask', 'allow']

export interface LocalPermissionSettings {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface LocalSettings {
  version: number
  permissions: LocalPermissionSettings
  /** 见 `domain/hook.ts`。空对象 = 这一层没有钩子。 */
  hooks: HookSettings
}

export function emptyLocalSettings(): LocalSettings {
  return { version: LOCAL_SETTINGS_VERSION, permissions: { allow: [], ask: [], deny: [] }, hooks: {} }
}

function normalizeBucket(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const rule = entry.trim()
    // 读不懂的规则直接丢掉:留着它只会在某天以「我明明写了」的形式变成一次误放行。
    if (rule === '' || !isValidPermissionRule(rule) || out.includes(rule)) continue
    out.push(rule)
    if (out.length >= MAX_RULES_PER_BUCKET) break
  }
  return out
}

/**
 * 归一化 hooks 段。
 *
 * ★ **兼容读 Claude Code 的嵌套写法**：`{ matcher, hooks: [{ type, command }] }`
 *   读得懂就拍平。让「从 `.claude/settings.json` 里整段粘过来」这件事直接可用，
 *   而不需要用户手工翻译一遍。写出去一律是扁平形状。
 *
 * ★ 一条读不懂的 hook 丢掉，**不是**让整个文件作废 —— 这条和 `normalizeBucket`
 *   对坏规则的处理是同一个取向，也是这个文件头第 2 条约定。
 */
function normalizeHooks(raw: unknown): HookSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: HookSettings = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHookEvent(key) || !Array.isArray(value)) continue
    const entries: HookFileEntry[] = []
    for (const item of value) {
      for (const flat of flattenHookEntry(item)) {
        const entry = normalizeHookEntry(flat, key)
        if (entry !== null) entries.push(entry)
        if (entries.length >= MAX_HOOKS_PER_EVENT) break
      }
      if (entries.length >= MAX_HOOKS_PER_EVENT) break
    }
    if (entries.length > 0) out[key] = entries
  }
  return out
}

/** CC 的 `{ matcher, hooks: [...] }` 拍平成若干条；本项目自己的形状原样放行。 */
function flattenHookEntry(item: unknown): unknown[] {
  if (item === null || typeof item !== 'object') return []
  const record = item as Record<string, unknown>
  if (!Array.isArray(record.hooks)) return [item]
  return record.hooks.map((inner) =>
    inner !== null && typeof inner === 'object'
      ? { ...(inner as Record<string, unknown>), matcher: record.matcher }
      : inner
  )
}

function normalizeHookEntry(raw: unknown, event: HookEvent): HookFileEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (command === '' || command.length > HOOK_COMMAND_MAX) return null

  const matcher = typeof record.matcher === 'string' ? record.matcher.trim() : ''
  // 读不懂的 matcher 直接丢掉这一条：留着它只会在某天以「我明明写了」的形式
  // 变成一次没拦住，而那正是安全类 hook 最不该有的失败方式。
  if (matcher !== '' && !isValidHookMatcher(matcher)) return null

  const seconds = typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout > 0
    ? record.timeout
    : defaultTimeoutMs(event) / 1000
  const timeout = Math.min(seconds, HOOK_MAX_TIMEOUT_MS / 1000)

  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : '',
    ...(matcher === '' ? {} : { matcher }),
    command,
    ...(record.enabled === false ? { enabled: false } : {}),
    timeout,
    ...(typeof record.description === 'string' && record.description.trim() !== ''
      ? { description: record.description.trim() }
      : {})
  }
}

/** 任何输入都能得到一份可用的设置 —— 这个函数不抛异常。 */
export function normalizeLocalSettings(raw: unknown): LocalSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyLocalSettings()
  const record = raw as Record<string, unknown>
  const permissions = (record.permissions ?? {}) as Record<string, unknown>
  const version = typeof record.version === 'number' && Number.isInteger(record.version) && record.version > 0
    ? record.version
    : LOCAL_SETTINGS_VERSION
  return {
    version,
    permissions: {
      allow: normalizeBucket(permissions.allow),
      ask: normalizeBucket(permissions.ask),
      deny: normalizeBucket(permissions.deny)
    },
    hooks: normalizeHooks(record.hooks)
  }
}
