/**
 * 钩子的接线层 —— 把 `WorkspaceEnvironment` / 两份设置 / 平台 shell 喂给
 * `kernel/hook/run.ts` 那个纯执行器。
 *
 * ★ 分工：怎么跑在内核（零 electron、可单测），**跑什么、在哪跑**在这里。
 */
import type { HookDefinition, HookEvent, HookListItem, HookScope } from '../shared/domain/hook'
import { TOOL_SCOPED_HOOK_EVENTS } from '../shared/domain/hook'
import { matchesPermissionRule } from '../shared/agent/permission-rule'
import type { WorkspaceEnvironment } from './environment/contract'
import { hookListFrom } from './kernel/hook/load'
import {
  runHook,
  runHookChain,
  type HookPayload,
  type HookProcessOpen,
  type HookRunReport
} from './kernel/hook/run'
import { agentShell } from './kernel/node-spawn'
import { globalSettingsPath, localSettingsPath, readGlobalSettings, readLocalSettings } from './kernel/local-settings'
import { getHost } from './runtime'

/**
 * 最近的失败，给 `hooks:diagnostics` 用。
 *
 * ★ 钩子失败**不阻断运行**（见 `hook/run.ts` 文件头的 fail-open 那段），
 *   代价就是它会静悄悄地什么也不做。这个环形缓冲是用户唯一能发现
 *   「我那条钩子其实一直在报错」的地方，不能省。
 */
const MAX_FAILURES = 20
const recentFailures: Array<{ path: string; message: string }> = []

export function recentHookFailures(): Array<{ path: string; message: string }> {
  return [...recentFailures]
}

function recordFailure(hook: HookDefinition, report: HookRunReport, sourcePath: string): void {
  const detail =
    report.outcome === 'timeout'
      ? `超时（${String(hook.timeoutMs / 1000)}s）`
      : report.outcome === 'spawn-failed'
        ? `起不来：${report.stderr}`
        : `退出码 ${String(report.exitCode)}：${report.stderr.slice(0, 200)}`
  recentFailures.unshift({ path: sourcePath, message: `${hook.command} —— ${detail}` })
  if (recentFailures.length > MAX_FAILURES) recentFailures.length = MAX_FAILURES
  getHost().logger.warn(`[hook] ${hook.command}: ${detail}`)
}

/** 平台对应的 shell 调用方式。远端看 `facts.os`，本地看自己。 */
function shellFor(environment: WorkspaceEnvironment): { command: string; args: (c: string) => string[] } {
  const os = environment.remote ? environment.facts.os : process.platform
  if (os === 'win32') {
    return { command: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] }
  }
  const command = environment.remote ? environment.facts.shell || '/bin/sh' : agentShell()
  return { command, args: (c) => ['-c', c] }
}

/**
 * 读两层钩子并按事件 + matcher 筛出这一次要跑的。
 *
 * ★ 顺序是「全局在前、项目在后」，且**不去重** —— 见 `hook/load.ts` 的
 *   `mergeHookLists`：两个作用域表达的是两个人的意图。
 */
async function hooksFor(
  event: HookEvent,
  environment: WorkspaceEnvironment,
  tool?: { internalId: string; input: unknown }
): Promise<HookListItem[]> {
  const host = getHost()
  const userData = host.paths.userData()
  const root = environment.rootPath

  const [globalSettings, projectSettings] = await Promise.all([
    readGlobalSettings(host.fs, userData, host.logger).catch(() => null),
    root === '' ? Promise.resolve(null) : readLocalSettings(host.fs, root, host.logger).catch(() => null)
  ])

  const all = [
    ...(globalSettings ? hookListFrom(globalSettings.hooks, 'global', globalSettingsPath(userData)) : []),
    ...(projectSettings ? hookListFrom(projectSettings.hooks, 'project', localSettingsPath(root)) : [])
  ]

  return all.filter((hook) => {
    if (hook.event !== event || !hook.enabled) return false
    if (hook.matcher === undefined || hook.matcher === '') return true
    // 非工具类事件手里没有「工具 + 入参」可比，写了 matcher 也无从匹配 —— 忽略它，
    // 而不是把这条 hook 整个跳过（用户多写了一个字段，不该让钩子静默失效）。
    if (!TOOL_SCOPED_HOOK_EVENTS.includes(event) || tool === undefined) return true
    return matchesPermissionRule(hook.matcher, tool.internalId, tool.input)
  })
}

export interface HookEventContext {
  event: HookEvent
  environment: WorkspaceEnvironment
  sessionId: string
  runId: string
  tool?: { internalId: string; externalName: string; input: unknown }
  /** 按事件补充的字段，见 `HookPayload`。 */
  extra?: Partial<HookPayload>
  signal?: AbortSignal
  /** 注入用的进程端口。只有测试会传。 */
  open?: HookProcessOpen
}

/**
 * 跑某个事件下的全部钩子，按顺序，首个阻断即短路。
 *
 * 调用方拿到报告自己决定怎么用：PreToolUse 看 `decision`，PostToolUse 拼
 * `additionalContext`，fire-and-forget 的那几个直接丢掉。
 */
export async function runHookEvent(context: HookEventContext): Promise<HookRunReport[]> {
  const { event, environment, sessionId, runId, tool, extra, signal } = context
  // 没有工作区时整个跳过 —— 和 `readLocalSettings` 的第一行同一个判断。
  if (environment.rootPath === '') return []

  const selected = await hooksFor(event, environment, tool)
  if (selected.length === 0) return []

  const shell = shellFor(environment)
  const open: HookProcessOpen =
    context.open ??
    ((command, args, options) =>
      // ★ `detached: true` 只有钩子传：它跑的是用户手写的任意命令，超时只杀那一个
      //   shell 会留下一地僵尸（见 `environment/contract.ts` 上那段）。
      environment.openProcess(command, args, { cwd: options.cwd, detached: true }))

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
      const report = await runHook({
        open,
        hook,
        scope,
        payload,
        cwd: environment.rootPath,
        shell,
        ...(signal ? { signal } : {})
      })
      if (report.outcome === 'timeout' || report.outcome === 'spawn-failed' || (report.exitCode !== 0 && report.exitCode !== 2)) {
        const source = selected.find((s) => s.id === hook.id)?.sourcePath ?? ''
        recordFailure(hook, report, source)
      }
      return report
    }
  )
  return reports
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
    event: input.event,
    command: input.command,
    enabled: true,
    timeoutMs: input.timeoutMs
  }
  return runHook({
    open: (command, args, options) =>
      input.environment.openProcess(command, args, { cwd: options.cwd, detached: true }),
    hook,
    scope: input.scope,
    payload: {
      event: input.event,
      sessionId: 'test',
      runId: 'test',
      workspaceRoot: input.environment.rootPath,
      scope: input.scope,
      // 给一份有代表性的示例，好让脚本能真的解析一次
      ...(TOOL_SCOPED_HOOK_EVENTS.includes(input.event)
        ? { toolName: 'Bash', toolInternalId: 'Bash', toolInput: { command: 'echo hello' } }
        : {}),
      ...(input.event === 'UserPromptSubmit' ? { prompt: '这是一次试运行' } : {})
    },
    cwd: input.environment.rootPath,
    shell: shellFor(input.environment)
  })
}
