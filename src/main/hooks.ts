/**
 * 钩子的接线层 —— 把 `WorkspaceEnvironment` / 两份设置 / 平台 shell 喂给
 * `kernel/hook/run.ts` 那个纯执行器，或者把一条 prompt 型钩子喂给判定模型。
 *
 * ★ 分工：怎么跑在内核（零 electron、可单测），**跑什么、在哪跑**在这里。
 *
 * ★ 两种钩子在这一层汇合成同一个 `HookRunReport`：调用方只看 `decision` /
 *   `outcome` / `reason`，不必知道这一条是 fork 了一个进程还是发了一次模型请求。
 */
import type { AgentMessage } from '../shared/agent/message'
import type { HookDefinition, HookDiagnostic, HookEvent, HookListItem, HookScope } from '../shared/domain/hook'
import { MAX_HOOKS_PER_EVENT, TOOL_SCOPED_HOOK_EVENTS } from '../shared/domain/hook'
import { matchesPermissionRule } from '../shared/agent/permission-rule'
import type { WorkspaceEnvironment } from './environment/contract'
import { runtimeHooksFor } from './hook-registry'
import { evaluateGoal } from './goal/evaluate'
import { hookListFrom } from './kernel/hook/load'
import {
  runHook,
  runHookChain,
  type HookPayload,
  type HookProcessOpen,
  type HookRunReport
} from './kernel/hook/run'
import { shellCommandArgs, shellDialect } from './kernel/node-spawn'
import { globalSettingsPath, localSettingsPath, readGlobalSettings, readLocalSettings } from './kernel/local-settings'
import { getHost, getRouter } from './runtime'
import { store } from './state/store'
import type { GoalEvaluatorPort } from './goal/evaluate'

/**
 * 最近的失败，给 `hooks:diagnostics` 用。
 *
 * ★ 钩子失败**不阻断运行**（见 `hook/run.ts` 文件头的 fail-open 那段），
 *   代价就是它会静悄悄地什么也不做。这个环形缓冲是用户唯一能发现
 *   「我那条钩子其实一直在报错」的地方，不能省。
 */
const MAX_FAILURES = 20
const recentFailures: HookDiagnostic[] = []
let diagnosticsChanged: (() => void) | undefined
export function setHookDiagnosticsListener(listener: () => void): void { diagnosticsChanged = listener }

export function recentHookFailures(): HookDiagnostic[] {
  return [...recentFailures]
}

/** 诊断行与日志里那一段「是哪条钩子」。prompt 型没有 command 可写。 */
function hookLabel(hook: HookDefinition): string {
  return hook.type === 'prompt' ? `prompt: ${hook.prompt.slice(0, 80)}` : hook.command
}

function recordFailure(hook: HookDefinition, report: HookRunReport, sourcePath: string): void {
  const detail =
    report.outcome === 'timeout'
      ? `超时（${String(hook.timeoutMs / 1000)}s）`
      : report.outcome === 'spawn-failed'
        ? `起不来：${report.stderr}`
        : `退出码 ${String(report.exitCode)}：${report.stderr.slice(0, 200)}`
  recentFailures.unshift({
    path: sourcePath, message: `${hookLabel(hook)} —— ${detail}`,
    messageKey: report.outcome === 'timeout' ? 'hooks.diagnostic.timeout'
      : hook.type === 'prompt' ? 'hooks.diagnostic.evaluator' : 'hooks.diagnostic.command',
    messageParams: { hook: hookLabel(hook), seconds: hook.timeoutMs / 1000, code: String(report.exitCode), detail: report.stderr }
  })
  if (recentFailures.length > MAX_FAILURES) recentFailures.length = MAX_FAILURES
  getHost().logger.warn(`[hook] ${hookLabel(hook)}: ${detail}`)
  diagnosticsChanged?.()
}

/** 测试专用：诊断缓冲跨用例泄漏会让下一个用例看到上一个用例的红条。 */
export function clearHookFailuresForTest(): void {
  recentFailures.length = 0
}

/** 平台对应的 shell 调用方式。远端看 `facts.os`，本地看自己。 */
function shellFor(environment: WorkspaceEnvironment): { command: string; args: (c: string) => string[] } {
  if (!environment.remote) {
    const command = environment.platform.shell
    return { command, args: (c) => shellCommandArgs(command, c) }
  }
  if (environment.facts.os === 'win32') {
    return { command: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] }
  }
  const command = environment.facts.shell || '/bin/sh'
  return { command, args: (c) => ['-c', c] }
}

/**
 * 读两层钩子 + 运行期那一批，按事件 + matcher 筛出这一次要跑的。
 *
 * ★ 顺序是「全局在前、项目其次、运行期最后」，且**不去重** —— 见 `hook/load.ts` 的
 *   `mergeHookLists`：几个来源表达的是几个人的意图。
 *
 * ★ 运行期那一批（见 `hook-registry.ts`）和文件里那些是**并列**关系，不是覆盖：
 *   `MAX_HOOKS_PER_EVENT` 的上限对合并后的总数生效。
 */
async function hooksFor(
  event: HookEvent,
  environment: WorkspaceEnvironment,
  sessionId: string,
  tool?: { internalId: string; input: unknown },
  runtimeHooks?: readonly HookDefinition[]
): Promise<HookListItem[]> {
  const host = getHost()
  const userData = host.paths.userData()
  const root = environment.rootPath

  const [globalSettings, projectSettings] = await Promise.all([
    readGlobalSettings(host.fs, userData, host.logger).catch(() => null),
    root === '' ? Promise.resolve(null) : readLocalSettings(host.fs, root, host.logger).catch(() => null)
  ])

  const runtime = runtimeHooks ?? runtimeHooksFor(sessionId)
  const all: HookListItem[] = [
    ...(globalSettings ? hookListFrom(globalSettings.hooks, 'global', globalSettingsPath(userData)) : []),
    ...(projectSettings ? hookListFrom(projectSettings.hooks, 'project', localSettingsPath(root)) : []),
    // 运行期钩子没有来源文件。`sourcePath` 留空串 —— 诊断行里它也确实不指向任何文件。
    ...runtime.map((hook) => ({ ...hook, scope: 'global' as HookScope, sourcePath: '' }))
  ]

  return all
    .filter((hook) => {
      if (hook.event !== event || !hook.enabled) return false
      if (hook.matcher === undefined || hook.matcher === '') return true
      // 非工具类事件手里没有「工具 + 入参」可比，写了 matcher 也无从匹配 —— 忽略它，
      // 而不是把这条 hook 整个跳过（用户多写了一个字段，不该让钩子静默失效）。
      if (!TOOL_SCOPED_HOOK_EVENTS.includes(event) || tool === undefined) return true
      return matchesPermissionRule(hook.matcher, tool.internalId, tool.input)
    })
    .slice(0, MAX_HOOKS_PER_EVENT)
}

export interface HookEventContext {
  event: HookEvent
  environment: WorkspaceEnvironment
  sessionId: string
  runId: string
  workspaceId?: string
  tool?: { internalId: string; externalName: string; input: unknown }
  /** 按事件补充的字段，见 `HookPayload`。 */
  extra?: Partial<HookPayload>
  signal?: AbortSignal
  /** 注入用的进程端口。只有测试会传。 */
  open?: HookProcessOpen
  /** Live transcript when available; other events read the committed transcript. */
  messages?: readonly AgentMessage[]
  hookSignals?: Readonly<Record<string, AbortSignal>>
  literalPrompts?: readonly string[]
  /** Abort/error finalizers notify command hooks only; they cannot evaluate a goal. */
  commandOnly?: boolean
  upstream?: GoalEvaluatorPort
  /** 判定模型没配时回落到它。通常是本次 run 的模型。 */
  fallbackModel?: string
  fallbackModelProviderId?: string
  /** 注入用的运行期钩子。只有测试会传；生产从 `hook-registry.ts` 取。 */
  runtimeHooks?: readonly HookDefinition[]
}

/**
 * 跑某个事件下的全部钩子，按顺序，首个阻断即短路。
 *
 * 调用方拿到报告自己决定怎么用：PreToolUse 看 `decision`，PostToolUse 拼
 * `additionalContext`，Stop 看有没有人阻断（阻断 = 这一轮继续跑），
 * fire-and-forget 的那几个直接丢掉。
 */
export async function runHookEvent(context: HookEventContext): Promise<HookRunReport[]> {
  const { event, environment, sessionId, runId, tool, extra, signal } = context
  // 没有工作区时整个跳过 —— 和 `readLocalSettings` 的第一行同一个判断。
  // ★ 运行期钩子（goal）不受这条限制：它不读任何文件，也不 fork 任何进程。
  const runtime = context.runtimeHooks ?? runtimeHooksFor(sessionId)
  if (environment.rootPath === '' && runtime.length === 0) return []

  const selected = (await hooksFor(event, environment, sessionId, tool, runtime))
    .filter((hook) => context.commandOnly !== true || hook.type === 'command')
  if (selected.length === 0 || signal?.aborted === true) return []

  const shell = shellFor(environment)
  const open: HookProcessOpen =
    context.open ??
    ((command, args, options) =>
      // ★ `detached: true` 只有钩子传：它跑的是用户手写的任意命令，超时只杀那一个
      //   shell 会留下一地僵尸（见 `environment/contract.ts` 上那段）。
      environment.openProcess(command, args, {
        cwd: options.cwd, detached: true,
        windowsVerbatimArguments: !environment.remote && environment.platform.os === 'win32' && shellDialect(command) === 'cmd'
      }))

  const reports = await runHookChain(
    selected.map((h) => ({ hook: h, scope: h.scope })),
    async (hook, scope) => {
      const payload: HookPayload = {
        event,
        sessionId,
        runId,
        workspaceRoot: environment.rootPath,
        scope,
        ...(tool === undefined
          ? {}
          : { toolName: tool.externalName, toolInternalId: tool.internalId, toolInput: tool.input }),
        ...extra
      }
      const hookSignal = context.hookSignals?.[hook.id] ?? signal
      if (hookSignal?.aborted === true) return {
        hookId: hook.id, scope, exitCode: 0, stdout: '', stderr: '', durationMs: 0,
        outcome: 'ok', ...(hook.type === 'prompt' ? { promptVerdict: 'skipped' as const } : {})
      }
      const report = hook.type === 'prompt'
        ? await runPromptHook(hook, scope, payload, { ...context, signal: hookSignal })
        : await runHook({
          open,
          hook,
          scope,
          payload,
          cwd: environment.rootPath,
          shell,
          ...(signal ? { signal } : {})
        })
      if (!hookSignal?.aborted && (report.outcome === 'timeout' || report.outcome === 'spawn-failed' || (report.exitCode !== 0 && report.exitCode !== 2))) {
        const source = selected.find((s) => s.id === hook.id)?.sourcePath ?? ''
        recordFailure(hook, report, source)
      }
      return report
    }
  )
  return reports
}

/**
 * 一条 prompt 型钩子 = 一次判定调用，结果翻译成同一份 `HookRunReport`。
 *
 * 映射（**语义即此**，别处不要再解释一遍）：
 * - `met`（`ok: true`）→ `outcome: 'ok'`，什么都不拦。
 * - `not_met` / `impossible`（`ok: false`）→ `outcome: 'blocked'` + `decision: 'deny'`，
 *   `reason` 是判定器给的理由。**`Stop` 上的「阻断」意思是这一轮继续跑**，
 *   不是终止（见 `BLOCKING_HOOK_EVENTS` 上那段）。
 * - `skipped` → 按原因翻成 `timeout` 或一个非 0 非 2 的退出码，于是它会自动进
 *   `hooks:diagnostics` 的红条 —— 那是用户唯一能发现「我的判定器一直在报错」的地方。
 *
 * ★ **不阻断**是 `skipped` 的取向，和命令钩子的 fail-open 一致：判定器挂了就
 *   当这一轮没判，而不是把一次网络抖动变成「你的条件没达成」。
 */
async function runPromptHook(
  hook: Extract<HookDefinition, { type: 'prompt' }>,
  scope: HookScope,
  payload: HookPayload,
  context: HookEventContext
): Promise<HookRunReport> {
  const started = getHost().clock.now()
  const base = { hookId: hook.id, scope, stdout: '', stderr: '' }
  const history = context.messages ?? store.getHistory(context.sessionId)
  const session = context.fallbackModel === undefined ? store.getSession(context.sessionId) : undefined
  const eventData = safeJson(payload)
  const messages = context.event === 'Stop' ? history : [...history, {
    id: `${context.runId}:hook-input`, role: 'user' as const, schemaVersion: 1 as const,
    createdAt: started, parts: [{ type: 'text' as const, text: eventData }]
  }]
  const question = context.literalPrompts?.includes(hook.id) === true
    ? hook.prompt
    : `${hook.prompt.replaceAll('$ARGUMENTS', () => eventData)}\n\nHook input:\n${eventData}`
  const verdict = await evaluateGoal({
    upstream: context.upstream ?? getRouter(),
    model: hook.model ?? '',
    ...(hook.modelProviderId === undefined ? {} : { modelProviderId: hook.modelProviderId }),
    fallbackModel: context.fallbackModel ?? session?.model ?? '',
    fallbackModelProviderId: context.fallbackModel === undefined ? session?.modelProviderId : context.fallbackModelProviderId,
    question,
    messages,
    context: {
      workspaceId: context.workspaceId ?? '',
      runId: `${context.runId}:hook`,
      sessionId: context.sessionId
    },
    signal: context.signal ?? new AbortController().signal,
    timeoutMs: hook.timeoutMs,
    now: () => getHost().clock.now()
  })
  const durationMs = getHost().clock.now() - started
  switch (verdict.kind) {
    case 'met':
      return {
        ...base,
        exitCode: 0,
        durationMs,
        outcome: 'ok',
        promptVerdict: 'met',
        ...(verdict.reason === '' ? {} : { reason: verdict.reason })
      }
    case 'not_met':
    case 'impossible':
      return {
        ...base,
        exitCode: 2,
        stderr: verdict.reason,
        durationMs,
        outcome: 'blocked',
        decision: 'deny',
        reason: verdict.reason,
        promptVerdict: verdict.kind
      }
    case 'skipped':
      return verdict.reason === 'timeout'
        ? { ...base, exitCode: null, durationMs, outcome: 'timeout', stderr: 'evaluator timed out', promptVerdict: 'skipped' }
        : { ...base, exitCode: 1, durationMs, outcome: 'ok', stderr: `evaluator ${verdict.reason}`, promptVerdict: 'skipped' }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}

/** 试运行喂给钩子的那份示例 payload。预览与真跑共用一份，两边不会漂。 */
function samplePayload(event: HookEvent, scope: HookScope, workspaceRoot: string): HookPayload {
  return {
    event,
    sessionId: 'test',
    runId: 'test',
    workspaceRoot,
    scope,
    // 给一份有代表性的示例，好让脚本能真的解析一次
    ...(TOOL_SCOPED_HOOK_EVENTS.includes(event)
      ? { toolName: 'Bash', toolInternalId: 'Bash', toolInput: { command: 'echo hello' } }
      : {}),
    ...(event === 'UserPromptSubmit' ? { prompt: '这是一次试运行' } : {}),
    ...(event === 'Stop' || event === 'SubagentStop' ? { status: 'done', stop_hook_active: false } : {})
  }
}

/**
 * 「试运行」——扩展面板那颗按钮。
 *
 * ★ 跑的是弹层里**此刻的草稿**，不读磁盘上那一条：否则用户必须先保存一条自己
 *   还不确定的钩子才能试，而钩子的失败模式（脚本路径、shell 语法、超时）
 *   恰恰只有真跑一次才暴露。
 */
export async function testHook(input: {
  environment: WorkspaceEnvironment
  event: HookEvent
  command: string
  timeoutMs: number
  scope: HookScope
}): Promise<HookRunReport> {
  const hook: HookDefinition = {
    id: 'test',
    type: 'command',
    event: input.event,
    command: input.command,
    enabled: true,
    timeoutMs: input.timeoutMs
  }
  return runHook({
    open: (command, args, options) =>
      input.environment.openProcess(command, args, {
        cwd: options.cwd, detached: true,
        windowsVerbatimArguments: !input.environment.remote && input.environment.platform.os === 'win32' && shellDialect(command) === 'cmd'
      }),
    hook,
    scope: input.scope,
    payload: samplePayload(input.event, input.scope, input.environment.rootPath),
    cwd: input.environment.rootPath,
    shell: shellFor(input.environment)
  })
}

/**
 * prompt 型钩子的「试运行」——**只预览替换结果，不真调模型**。
 *
 * ★ 真调需要一次 run 的上下文（判定器读的是转录，而试运行时一条都没有）。
 *   真跑一次会得到一个在真实场景里永远不会出现的结论，那会把「试运行」
 *   变成一个语义模糊、还会花钱的按钮。所以只把示例 payload 替进 `$ARGUMENTS`
 *   给用户看 —— 那正是 prompt 钩子唯一会写错的地方。
 */
export function previewPromptHook(input: {
  event: HookEvent
  scope: HookScope
  prompt: string
  workspaceRoot: string
}): string {
  return input.prompt.replaceAll(
    '$ARGUMENTS',
    () => JSON.stringify(samplePayload(input.event, input.scope, input.workspaceRoot), null, 2)
  )
}
