/**
 * 钩子执行器 —— 在一次 run 的固定时机上跑一条本机命令。
 *
 * ## 为什么不用 `SpawnFn`
 *
 * `kernel/node-spawn.ts` 的 stdio 是 `['ignore', 'pipe', 'pipe']` —— **没有 stdin**
 * （那是刻意的，见该文件的注释）。而钩子的全部输入都靠 stdin 上那一行 JSON。
 * 所以底座是 `WorkspaceEnvironment.openProcess`：它用 `stdio: 'pipe'`，本地和
 * SSH 两条路径都实现了，钩子因此在远程工作区上跑在**远端**（payload 里的
 * `file_path` 是远端路径，在客户端跑没有意义）。
 *
 * ## 协议
 *
 * - **stdin**：一行 JSON，然后 `end()`。★ **不设环境变量** —— SSH 那条路径的
 *   `remoteProcessRequest` 在 env 非空时会用 stdin 的第一行传环境变量，和我们
 *   自己要用 stdin 传 JSON 直接打架。全部信息进 JSON，两个环境行为一致。
 *   将来要给钩子加环境变量注入的人，先看这里。
 * - **exit 0**：stdout 若是形如 `{decision?,reason?,additionalContext?}` 的 JSON
 *   就结构化读，否则整段当 `additionalContext`（脚本 `echo` 一句话就能用）。
 * - **exit 2**：阻断，stderr 当理由。照搬 Claude Code 的约定。
 * - **其余非零 / 超时 / 起不来**：记诊断，**不阻断**。
 *
 * ## 失败时为什么 fail-open
 *
 * 一条安全用途的 PreToolUse 钩子超时了，放行还是拦住？选**放行**：钩子最常见的
 * 故障是脚本写错、依赖没装、路径不对，而 fail-closed 的表现是「整个应用突然什么
 * 工具都用不了，且没有任何线索指向钩子」。代价用可见性补 —— 失败会进
 * `hooks:diagnostics`，面板顶部挂红条。
 */
import type { HookDefinition, HookEvent, HookRunReport, HookScope } from '../../../shared/domain/hook'
import { HOOK_STDERR_MAX, HOOK_STDOUT_MAX } from '../../../shared/domain/hook'

export type { HookRunReport }

export interface HookProcess {
  stdin: { write(chunk: string): unknown; end(): unknown }
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  exited: Promise<{ code: number | null; signal?: string | null }>
  kill(): void
}

export type HookProcessOpen = (
  command: string,
  args: readonly string[],
  options: { cwd: string }
) => Promise<HookProcess>

/** 喂给钩子的那一行 JSON。 */
export interface HookPayload {
  event: HookEvent
  sessionId: string
  runId: string
  workspaceRoot: string
  /** 这条钩子自己所在的层，便于一份脚本兼顾两种安装位置。 */
  scope: HookScope
  /** PreToolUse / PostToolUse 才有 */
  toolName?: string
  toolInternalId?: string
  toolInput?: unknown
  /** PostToolUse 才有 */
  toolOutput?: string
  toolIsError?: boolean
  /** UserPromptSubmit 才有 */
  prompt?: string
  /** Stop / SubagentStop 才有 */
  status?: string
  /** Notification 才有 */
  notification?: { kind: string; toolName?: string }
}

/**
 * 读干净一条流，但只留前 `max` 个字符。
 *
 * ★ 超出上限之后**继续读**，不 pause、不 destroy。不读会把管道写满，子进程
 *   卡在 write 上永远不退出 —— 表现是「这条钩子每次都超时」，而它其实早就
 *   把事情做完了。
 */
async function readCapped(stream: AsyncIterable<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  for await (const chunk of stream) {
    if (out.length < max) out += decoder.decode(chunk, { stream: true })
  }
  out += decoder.decode()
  return out.length > max ? out.slice(0, max) : out
}

/** 钩子 stdout 里那个可选的结构化回包。 */
function parseDecision(stdout: string): Pick<HookRunReport, 'decision' | 'reason' | 'additionalContext'> {
  const text = stdout.trim()
  if (text === '') return {}
  if (!text.startsWith('{')) return { additionalContext: text }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const decision = parsed.decision
    return {
      ...(decision === 'allow' || decision === 'deny' || decision === 'ask' ? { decision } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      ...(typeof parsed.additionalContext === 'string' ? { additionalContext: parsed.additionalContext } : {})
    }
  } catch {
    // 看着像 JSON 但不是 —— 当普通文本用，别把用户的输出丢掉
    return { additionalContext: text }
  }
}

export interface RunHookOptions {
  open: HookProcessOpen
  hook: HookDefinition
  scope: HookScope
  payload: HookPayload
  cwd: string
  /** 走 shell 的参数，比如 `['-c', command]`。由调用方按平台拼。 */
  shell: { command: string; args: (hookCommand: string) => string[] }
  signal?: AbortSignal
  now?: () => number
}

export async function runHook(options: RunHookOptions): Promise<HookRunReport> {
  const { open, hook, scope, payload, cwd, shell, signal } = options
  const now = options.now ?? ((): number => Date.now())
  const started = now()
  const base = { hookId: hook.id, scope }

  let child: HookProcess
  try {
    child = await open(shell.command, shell.args(hook.command), { cwd })
  } catch (error) {
    return {
      ...base,
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: now() - started,
      outcome: 'spawn-failed'
    }
  }

  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    child.stdin.end()
  } catch {
    // stdin 早关了（脚本没读就退出）不是错误 —— 它可能根本不关心输入。
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, hook.timeoutMs)
  const onAbort = (): void => {
    timedOut = true
    child.kill()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const [stdout, stderr, exit] = await Promise.all([
      readCapped(child.stdout, HOOK_STDOUT_MAX),
      readCapped(child.stderr, HOOK_STDERR_MAX),
      child.exited
    ])
    const durationMs = now() - started

    if (timedOut) {
      return { ...base, exitCode: exit.code, stdout, stderr, durationMs, outcome: 'timeout' }
    }
    if (exit.code === 2) {
      // exit 2 = 阻断。理由取 stderr；它空着的话退回 stdout，总好过给用户一个空原因。
      const reason = stderr.trim() !== '' ? stderr.trim() : stdout.trim()
      return { ...base, exitCode: 2, stdout, stderr, durationMs, outcome: 'blocked', decision: 'deny', reason }
    }
    if (exit.code !== 0) {
      return { ...base, exitCode: exit.code, stdout, stderr, durationMs, outcome: 'ok' }
    }
    return { ...base, exitCode: 0, stdout, stderr, durationMs, outcome: 'ok', ...parseDecision(stdout) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 按顺序跑一组钩子，**首个阻断即短路**。
 *
 * ★ 顺序而不是并行：PreToolUse 要「首个 deny 短路」才有确定的归因；
 *   PostToolUse 的 `additionalContext` 拼接顺序必须可复现；而钩子数量是个位数，
 *   并行省不下什么。
 */
export async function runHookChain(
  hooks: ReadonlyArray<{ hook: HookDefinition; scope: HookScope }>,
  run: (hook: HookDefinition, scope: HookScope) => Promise<HookRunReport>
): Promise<HookRunReport[]> {
  const reports: HookRunReport[] = []
  for (const { hook, scope } of hooks) {
    if (!hook.enabled) continue
    const report = await run(hook, scope)
    reports.push(report)
    if (report.outcome === 'blocked' || report.decision === 'deny') break
  }
  return reports
}
