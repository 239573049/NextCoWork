/**
 * `<工作区>/.next-cowork/settings.local.json` —— **项目级、本机私有**的设置文件。
 *
 * 名字里的 `.local` 和 Claude Code 同义:它记的是「这台机器上的这个人」做过的决定
 * (最典型的就是「以后都允许执行这条命令」),所以应该进 `.gitignore`,
 * 不应该替队友做决定。
 *
 * ★ 这个文件**会继续长**。所以三条约定从第一天就立住:
 *
 * 1. **分段命名**。每一类设置占一个顶层键(现在只有 `permissions`),
 *    新增能力就是新增一个键,不往已有的段里塞不相干的字段。
 * 2. **读的时候宽容**。认不出来的段、认不出来的规则一律忽略,绝不因为文件里有
 *    一行看不懂的东西就拒绝整个文件 —— 那会让一个旧版本的应用把用户的工作区锁死。
 * 3. **写的时候原样保留未知键**(见 `main/kernel/local-settings.ts`)。
 *    新版本写进去的段,旧版本改一次规则不能把它抹掉。
 */
import { isValidPermissionRule } from '../agent/permission-rule'

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
}

export function emptyLocalSettings(): LocalSettings {
  return { version: LOCAL_SETTINGS_VERSION, permissions: { allow: [], ask: [], deny: [] } }
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
    }
  }
}
