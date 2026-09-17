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

/**
 * 能阻断后续动作的三个。UI 据此决定要不要显示「阻断行为」那一段说明。
 *
 * ★ `Stop` 的「阻断」和另外两个**方向相反**：前两个是「拦住，不让它发生」，
 *   而 Stop 拦的是**收尾** —— 拦住的结果是这一轮**继续跑**，不是终止。
 *   面板上必须把这一点说清（`hooks.blocking.stopNote`），否则用户会照着
 *   PreToolUse 的直觉配出一个他没想到的死循环。
 */
export const BLOCKING_HOOK_EVENTS: readonly HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'Stop']

export type HookScope = 'global' | 'project'

/**
 * 钩子跑的是什么。
 *
 * - `command`：本机命令（原有的全部钩子）。
 * - `prompt`：一次**旁路模型调用** —— 没有 command，取而代之的是一段 prompt，
 *   由判定模型读完对话后回一个 JSON 结论。会话目标（goal）就是运行期
 *   自动注册的一条内置 `Stop` prompt 钩子。
 */
export const HOOK_TYPES = ['command', 'prompt'] as const
export type HookType = (typeof HOOK_TYPES)[number]

export const HOOK_DEFAULT_TIMEOUT_MS = 60_000
/**
 * PreToolUse 的默认超时单独压低。
 *
 * ★ 它的 await 落在**每一次工具调用**的关键路径上：一个每轮调 10 次工具的 run，
 *   按 60s 算最坏情况是 10 分钟的静默等待，而用户看到的只是「卡住了」。
 */
export const HOOK_PRE_TOOL_DEFAULT_TIMEOUT_MS = 10_000
export const HOOK_MAX_TIMEOUT_MS = 600_000
/**
 * prompt 型钩子的默认超时。**独立于命令钩子那条 60 秒。**
 *
 * ★ 它等的是一次模型请求，不是一个本机脚本：60 秒的等待挂在回合末的关键路径上，
 *   用户看到的只是「这一轮迟迟不结束」。30 秒足够一次无工具、1K 输出的判定。
 */
export const PROMPT_HOOK_DEFAULT_TIMEOUT_MS = 30_000
/** 每个事件下最多几条。线性扫，而且每一条都要 fork 一个进程。 */
export const MAX_HOOKS_PER_EVENT = 50
export const HOOK_COMMAND_MAX = 4 * 1024
/** prompt 正文的上限。和 `HOOK_COMMAND_MAX` 同一个量级：它同样是手写进 JSON 的。 */
export const HOOK_PROMPT_MAX = 4 * 1024
/** hook 的 stdout 会进模型上下文，必须比工具输出的 30KB 小一个量级。 */
export const HOOK_STDOUT_MAX = 8 * 1024
export const HOOK_STDERR_MAX = 4 * 1024

interface HookBase {
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
  enabled: boolean
  timeoutMs: number
  /** 列表里那一行副标题。纯展示，不影响执行。 */
  description?: string
}

/** 本机命令型。老文件里没有 `type` 的条目全部归这一支。 */
export interface CommandHook extends HookBase {
  type: 'command'
  /** 走 shell 的一整条命令，不是 argv。 */
  command: string
}

/**
 * 模型判定型钩子。★ 它跑的不是本机命令，而是一次旁路模型调用 ——
 * 所以没有 command，却多了一个 prompt，并且在 `Stop` 上具备阻断能力。
 */
export interface PromptHook extends HookBase {
  type: 'prompt'
  prompt: string
  /** 空 / 缺省 = 回落到本次 run 的模型。与 `modelProviderId` **成对**冻结。 */
  model?: string
  modelProviderId?: string
}

export type HookDefinition = CommandHook | PromptHook

/**
 * `hooks:save` 收的形状：id 可省（新建时主进程铸一个）。
 *
 * ★ 写成**两支各自 Omit 的联合**，不是 `Omit<HookDefinition, 'id'>`：后者会把
 *   判别联合压成一个「两支字段的并集、必填项取交集」的对象，于是
 *   `req.hook.type === 'prompt'` 这道收窄在接收端失效，
 *   一条缺 `prompt` 的 prompt 钩子能一路写进文件。
 */
export type HookUpsert =
  | (Omit<CommandHook, 'id'> & { id?: string })
  | (Omit<PromptHook, 'id'> & { id?: string })

/**
 * 列表里那一条。
 *
 * ★ 是 `type` 而不是 `interface … extends`：`HookDefinition` 现在是判别联合，
 *   交叉之后 `HookListItem` 仍然保留 `type` 那道判别，`row.type === 'prompt'`
 *   在渲染层照样能收窄。
 */
export type HookListItem = HookDefinition & {
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
  /**
   * 缺省 = `'command'`。★ 老文件里一条 `type` 都没有，所以缺省值**必须**是
   * command —— 换个缺省就是一次静默的数据迁移。
   */
  type?: HookType
  /** `type: 'command'` 必填。 */
  command?: string
  /** `type: 'prompt'` 必填。 */
  prompt?: string
  /** `type: 'prompt'` 可选：判定模型。空 / 缺省 = 回落到本次 run 的模型。 */
  model?: string
  modelProviderId?: string
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
export interface HookDiagnostic {
  path: string
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
}

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
  /** Preview-only prompt expansion; no model request was made. */
  preview?: string
  /**
   * prompt 型钩子才有：判定器的**原始**结论。
   *
   * ★ `outcome` 把 `not_met` 和 `impossible` 都压成了 `blocked`（对通用调用方来说
   *   它们是同一件事：拦住）。而目标运行时要分开处理这两者 —— 一个是「继续跑」，
   *   另一个是「这条件根本做不到，收尾」。所以原始结论必须原样带出来，
   *   不能让调用方去猜 `reason` 的措辞。
   */
  promptVerdict?: 'met' | 'not_met' | 'impossible' | 'skipped'
}

export function isHookEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v)
}

export function isHookType(v: unknown): v is HookType {
  return typeof v === 'string' && (HOOK_TYPES as readonly string[]).includes(v)
}

export function isValidHookMatcher(text: string): boolean {
  return text.trim() === '' || parsePermissionRule(text) !== null
}

/**
 * 这个事件下一条新钩子的默认超时。
 *
 * ★ 带上 `type`：prompt 型等的是一次模型请求，命令型等的是一个本机脚本，
 *   两者的「太久了」不是同一个数量级。
 */
export function defaultTimeoutMs(event: HookEvent, type: HookType = 'command'): number {
  if (type === 'prompt') return PROMPT_HOOK_DEFAULT_TIMEOUT_MS
  return event === 'PreToolUse' ? HOOK_PRE_TOOL_DEFAULT_TIMEOUT_MS : HOOK_DEFAULT_TIMEOUT_MS
}

/**
 * 阻断型 hook 用了前缀规则 —— 见 `HookDefinition.matcher` 上那段。
 * UI 出一条黄条提示，**不硬拦**：用户可能真的只想拦那一类命令。
 *
 * ★ 只对**工具类**事件成立。`Stop` 也在 `BLOCKING_HOOK_EVENTS` 里，但它手里
 *   压根没有「工具 + 入参」可比，matcher 会被 `hooksFor` 整个忽略 ——
 *   对它报一条「你的 matcher 太弱」是在指一个根本不起作用的字段。
 */
export function hasWeakBlockingMatcher(hook: Pick<CommandHook, 'event' | 'matcher'>): boolean {
  if (!BLOCKING_HOOK_EVENTS.includes(hook.event)) return false
  if (!TOOL_SCOPED_HOOK_EVENTS.includes(hook.event)) return false
  const rule = parsePermissionRule(hook.matcher ?? '')
  return rule?.specifier?.endsWith(':*') === true
}
