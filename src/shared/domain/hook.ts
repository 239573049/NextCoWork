/**
 * Hooks —— 在一次 run 的固定时机上跑一条本机命令。
 *
 * ## 事件表是由内核的真实时机**倒推**出来的，不是照抄 Claude Code
 *
 * CC 有而这里没有的（`SessionStart` / `PreCompact` / `SessionEnd`）不是漏了：
 * 本项目没有一个能稳定落钩子的对应时刻。`SessionStart` 想干的事被
 * `UserPromptSubmit` 完全覆盖（都是往消息流里注入上下文），而 `PreCompact`
 * 要等压缩检查点的时机先稳定下来。
 *
 * ★ **挂一个「有时触发有时不触发」的事件，比没有这个事件坏得多** ——
 *   用户会写一条依赖它的脚本，然后在某些路径上它不响，而这种不响没有任何症状。
 *
 * ## matcher 直接复用权限规则的语法
 *
 * 不另造一套。三个理由：用户在「以后都允许」那条路上已经认识了 `Bash(git commit:*)`；
 * `wildcardMatch` 是双指针非回溯的（matcher 来自可手改的文件，正则回溯是 DoS 面）；
 * `ruleSubjects()` 已经把「哪些入参字段可以拿来比」收敛成了一个答案。
 */
import { parsePermissionRule } from '../agent/permission-rule'

export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop'
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 只有这两个事件手里有「工具 + 入参」，别的事件写了 matcher 也无从匹配。 */
export const TOOL_SCOPED_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse']

/** 能阻断后续动作的只有这两个。UI 据此决定要不要显示「阻断行为」那一段说明。 */
export const BLOCKING_HOOK_EVENTS: readonly HookEvent[] = ['UserPromptSubmit', 'PreToolUse']

export type HookScope = 'global' | 'project'

export const HOOK_DEFAULT_TIMEOUT_MS = 60_000
/**
 * PreToolUse 的默认超时单独压低。
 *
 * ★ 它的 await 落在**每一次工具调用**的关键路径上：一个每轮调 10 次工具的 run，
 *   按 60s 算最坏情况是 10 分钟的静默等待，而用户看到的只是「卡住了」。
 */
export const HOOK_PRE_TOOL_DEFAULT_TIMEOUT_MS = 10_000
export const HOOK_MAX_TIMEOUT_MS = 600_000
/** 每个事件下最多几条。线性扫，而且每一条都要 fork 一个进程。 */
export const MAX_HOOKS_PER_EVENT = 50
export const HOOK_COMMAND_MAX = 4 * 1024
/** hook 的 stdout 会进模型上下文，必须比工具输出的 30KB 小一个量级。 */
export const HOOK_STDOUT_MAX = 8 * 1024
export const HOOK_STDERR_MAX = 4 * 1024

export interface HookDefinition {
  /**
   * 主进程铸的 ULID。**必填**。
   *
   * ★ CC 的嵌套写法里每一条 hook 没有身份，而「点这一行的开关」「删掉这一行」
   *   两件事都需要一个跨读写稳定的键 —— 靠数组下标的话，用户手改文件删掉上面
   *   一条，下面那条的开关就点到别人身上去了。
   */
  id: string
  event: HookEvent
  /**
   * 权限规则语法。缺省 / 空串 = 这个事件的每一次触发。
   *
   * ★ 想**阻断**的 hook 应该写裸工具名（`Bash`），不要写 `Bash(rm:*)`：
   *   前缀规则在 `matchSpecifier` 里带着一条 shell 接续符的保护，而那条保护是
   *   给「放行」设计的（命中即放行，所以宁可不命中）；用在「拦截」上方向正好
   *   反了（不命中即放行）。见 `hasWeakBlockingMatcher`。
   */
  matcher?: string
  /** 走 shell 的一整条命令，不是 argv。 */
  command: string
  enabled: boolean
  timeoutMs: number
  /** 列表里那一行副标题。纯展示，不影响执行。 */
  description?: string
}

export interface HookListItem extends HookDefinition {
  scope: HookScope
  /** 这条 hook 所在的 json 文件绝对路径，给「在编辑器里打开」用。 */
  sourcePath: string
}

/**
 * 文件里那一条的形状。
 *
 * ★ `timeout` 是**秒**，不是毫秒 —— 这个文件是给人手写的，`timeout: 30` 比
 *   `30000` 好读。内存里统一转成 `timeoutMs`。
 */
export interface HookFileEntry {
  id: string
  matcher?: string
  command: string
  /** 缺省 = true。写成可选是为了手写时不必每条都带。 */
  enabled?: boolean
  /** 秒。缺省见 `HOOK_DEFAULT_TIMEOUT_MS` / `HOOK_PRE_TOOL_DEFAULT_TIMEOUT_MS`。 */
  timeout?: number
  description?: string
}

/**
 * `settings.local.json` / `settings.json` 里那个新的顶层段。
 *
 * ★ **按事件分组**，而不是一个带 `event` 字段的扁平数组：手改这个文件的人读的是
 *   「PreToolUse 下面有哪几条」，不是「第 7 条是什么事件」。
 */
export type HookSettings = Partial<Record<HookEvent, HookFileEntry[]>>

/**
 * 一条钩子跑完的结果。
 *
 * ★ 放在 shared 而不是 `main/kernel/hook/run.ts`：它是 `hooks:test` 的返回值，
 *   要跨 IPC 到渲染层。放在 main 里会让 `shared/ipc/contract.ts` 反向依赖 main，
 *   而那个文件渲染层也要 import。
 */
export interface HookRunReport {
  hookId: string
  scope: HookScope
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** `ok` 不代表退出码是 0 —— 非 0 但不是 2 的也归这里（不阻断，只记诊断）。 */
  outcome: 'ok' | 'blocked' | 'timeout' | 'spawn-failed'
  decision?: 'allow' | 'deny' | 'ask'
  reason?: string
  additionalContext?: string
}

export function isHookEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v)
}

export function isValidHookMatcher(text: string): boolean {
  return text.trim() === '' || parsePermissionRule(text) !== null
}

export function defaultTimeoutMs(event: HookEvent): number {
  return event === 'PreToolUse' ? HOOK_PRE_TOOL_DEFAULT_TIMEOUT_MS : HOOK_DEFAULT_TIMEOUT_MS
}

/**
 * 阻断型 hook 用了前缀规则 —— 见 `HookDefinition.matcher` 上那段。
 * UI 出一条黄条提示，**不硬拦**：用户可能真的只想拦那一类命令。
 */
export function hasWeakBlockingMatcher(hook: Pick<HookDefinition, 'event' | 'matcher'>): boolean {
  if (!BLOCKING_HOOK_EVENTS.includes(hook.event)) return false
  const rule = parsePermissionRule(hook.matcher ?? '')
  return rule?.specifier?.endsWith(':*') === true
}
