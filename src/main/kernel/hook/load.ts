/**
 * hooks 段 ⇄ 列表 的纯函数层。
 *
 * ★ 零 IO、零 electron:读文件在 `local-settings.ts`,算路径和铸 id 在
 *   `ipc/hooks.ts`。这里只做形状转换,所以每一条都能单测。
 */
import type {
  HookDefinition,
  HookEvent,
  HookFileEntry,
  HookListItem,
  HookScope,
  HookSettings
} from '../../../shared/domain/hook'
import { HOOK_EVENTS, defaultTimeoutMs } from '../../../shared/domain/hook'

/** 文件里那一条 → 内存里那一条。`timeout` 秒 → `timeoutMs` 毫秒在这里发生。 */
function toDefinition(entry: HookFileEntry, event: HookEvent): HookDefinition {
  return {
    id: entry.id,
    event,
    ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
    command: entry.command,
    enabled: entry.enabled !== false,
    timeoutMs: entry.timeout === undefined ? defaultTimeoutMs(event) : Math.round(entry.timeout * 1000),
    ...(entry.description === undefined ? {} : { description: entry.description })
  }
}

/** 内存里那一条 → 文件里那一条。和 `toDefinition` 严格互逆。 */
export function toFileEntry(hook: HookDefinition): HookFileEntry {
  return {
    id: hook.id,
    ...(hook.matcher === undefined || hook.matcher === '' ? {} : { matcher: hook.matcher }),
    command: hook.command,
    ...(hook.enabled ? {} : { enabled: false }),
    timeout: hook.timeoutMs / 1000,
    ...(hook.description === undefined || hook.description === '' ? {} : { description: hook.description })
  }
}

export function hookListFrom(hooks: HookSettings, scope: HookScope, sourcePath: string): HookListItem[] {
  const out: HookListItem[] = []
  // 按 HOOK_EVENTS 的顺序而不是 Object.keys 的顺序 —— 后者取决于文件里键的书写
  // 顺序，会让同样两份配置在界面上排成不同的样子。
  for (const event of HOOK_EVENTS) {
    for (const entry of hooks[event] ?? []) {
      out.push({ ...toDefinition(entry, event), scope, sourcePath })
    }
  }
  return out
}

/**
 * 合并两层。
 *
 * ★ **不去重**:全局和项目各跑各的。两个作用域表达的是两个人的意图 ——
 *   一条团队级的格式化 hook 和一条我自己的通知 hook 命令相同,也该各响一次。
 *   (这和 Skill / 命令的「同名时项目覆盖全局」不一样:那边是按名字索引的资源,
 *   这边是一串按顺序执行的动作。)
 */
export function mergeHookLists(global: readonly HookListItem[], project: readonly HookListItem[]): HookListItem[] {
  return [...global, ...project]
}

/** 手写进文件、没有 id 的那些。见 `assignIds`。 */
export function hasMissingIds(hooks: HookSettings): boolean {
  return HOOK_EVENTS.some((event) => (hooks[event] ?? []).some((entry) => entry.id === ''))
}

/**
 * 给没有 id 的条目补一个。
 *
 * ★ 为什么非要有 id:「点这一行的开关」「删掉这一行」都需要一个跨读写稳定的键。
 *   靠数组下标的话,用户手改文件删掉上面一条,下面那条的开关就点到别人身上去了。
 *   而用户手写的条目不可能自带 ULID,所以第一次读到它们时就得补齐并回写。
 */
export function assignIds(hooks: HookSettings, mint: () => string): HookSettings {
  const out: HookSettings = {}
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event]
    if (entries === undefined) continue
    out[event] = entries.map((entry) => (entry.id === '' ? { ...entry, id: mint() } : entry))
  }
  return out
}

/** 增 / 改一条(按 id upsert)。返回新的 hooks 段。 */
export function upsertHook(hooks: HookSettings, hook: HookDefinition): HookSettings {
  const out: HookSettings = {}
  // 先把这条 id 从所有事件下摘掉 —— 用户可能把它从 PreToolUse 改成了 PostToolUse，
  // 只在目标事件里 upsert 会让它同时留在两个事件下。
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((e) => e.id !== hook.id)
    if (kept.length > 0) out[event] = kept
  }
  out[hook.event] = [...(out[hook.event] ?? []), toFileEntry(hook)]
  return out
}

export function removeHook(hooks: HookSettings, id: string): HookSettings {
  const out: HookSettings = {}
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((e) => e.id !== id)
    if (kept.length > 0) out[event] = kept
  }
  return out
}

export function setHookEnabled(hooks: HookSettings, id: string, enabled: boolean): HookSettings {
  const out: HookSettings = {}
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event]
    if (entries === undefined) continue
    out[event] = entries.map((e) => {
      if (e.id !== id) return e
      // `enabled` 缺省就是 true，所以开启时把这个键**去掉**而不是写 `true` ——
      // 和 `toFileEntry` 保持一致，免得同一个状态在文件里有两种写法。
      const { enabled: _previous, ...rest } = e
      return enabled ? rest : { ...rest, enabled: false }
    })
  }
  return out
}
