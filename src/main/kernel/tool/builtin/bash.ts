/**
 * `Bash` —— 在工作区里跑一条 shell 命令。
 *
 * 名字、参数(`command` / `timeout` / `description`)和描述结构都对齐 Claude Code。
 * 但有**三处必须照实说**的差异,写进描述里,一个都不能省 —— 每一处说错了,
 * 模型都会按 CC 的假设行事,然后拿到一个它无法归因的结果:
 *
 * 1. ★ **不是持久会话。** CC 的原话是 "a persistent shell session";我们脚下是
 *    `SpawnFn`,每次调用现开一个 shell(见 `host.ts` 里为什么不复用交互式 PTY)。
 *    不说的话,模型会先 `cd packages/app` 再在下一次调用里写相对路径 ——
 *    文件安安静静地落在仓库根上,而两次调用都返回成功。
 * 2. ★ **stdin 是关着的。** `node-spawn.ts` 用 `stdio: ['ignore', ...]`。
 *    任何等输入的命令(`git commit` 不带 `-m`、`npm login`)会挂到超时。
 *    描述里直接要求一律用非交互式参数。
 * 3. ★ **没有 `run_in_background`。** CC 有,配套还有 `BashOutput` / `KillShell`。
 *    我们没有那套后台 shell 注册表,所以**不声明这个参数** —— 声明一个不生效的
 *    开关,比缺一个功能坏得多:模型会以为自己起了个后台服务然后继续往下做。
 *
 * 另外**刻意没有**照抄 CC 描述里那一大段 git commit / PR 工作流。那是 CC 的产品行为,
 * 不是这个工具的用法;搬过来会让描述长一倍,而其中每一句都在教模型做我们没验证过的事。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { clampWithEllipsis } from '../../text'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'
import { NO_WORKSPACE } from './paths'

/** 和 CC 一致:默认 2 分钟。 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 和 CC 一致:最长 10 分钟。再长的活应该拆开,或者做成后台任务(还没有)。 */
const MAX_TIMEOUT_MS = 600_000
/**
 * 和 CC 一致:输出超过这个长度就截断。
 * ★ 截断发生在**进上下文之前**,而 `node-spawn.ts` 那 512KB 的上限是防内存的 ——
 * 两道是不同的目的,别以为有了一道就能去掉另一道。
 */
const MAX_OUTPUT_CHARS = 30_000

const BashInput = z.object({
  command: z.string().min(1).describe('The command to execute'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Optional timeout in milliseconds, up to ${String(MAX_TIMEOUT_MS)}. Defaults to ${String(DEFAULT_TIMEOUT_MS)}`
    ),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('Clear, concise description of what this command does in 5-10 words. The user sees it in the UI')
})

/** 一段输出的呈现:空的时候要说「空」,不能给一段静默的空白让模型以为没读到。 */
function section(title: string, body: string): string {
  const t = body.trim()
  return t === '' ? '' : `<${title}>\n${clampWithEllipsis(t, MAX_OUTPUT_CHARS)}\n</${title}>`
}

export const bashTool: ToolRegistration = defineTool({
  internalId: 'Bash',
  description:
    'Executes a shell command in the workspace directory, with a timeout and an output cap.\n\n' +
    'Before you run anything:\n' +
    '1. VERIFY THE DIRECTORY. If the command creates files in a new directory, first use LS to confirm ' +
    'the parent exists and is where you think it is.\n' +
    '2. VERIFY THE COMMAND. It runs directly on the user\'s machine. If it deletes data, changes global ' +
    'configuration, or sends anything outward, tell the user what it does before running it.\n\n' +
    'Usage notes:\n' +
    `- command is required. timeout is optional, in milliseconds, up to ${String(MAX_TIMEOUT_MS)} (10 minutes); ` +
    `it defaults to ${String(DEFAULT_TIMEOUT_MS)} (2 minutes)\n` +
    '- Write a 5-10 word description; that is what the user sees in the UI\n' +
    `- Output longer than ${String(MAX_OUTPUT_CHARS)} characters is truncated\n` +
    '- IMPORTANT: EVERY CALL GETS A FRESH SHELL AND KEEPS NO STATE. A cd, an export, or a variable you set ' +
    'in one call does not exist in the next. The working directory is always the workspace root, so use ' +
    'absolute or workspace-relative paths instead of relying on cd. To run somewhere else, write ' +
    '`cd subdir && command` inside a SINGLE call\n' +
    '- IMPORTANT: STDIN IS CLOSED. Any command that waits for input will hang until it times out: pass -m to ' +
    'git commit, pass --yes / --no-input to package managers, and never run something that needs an interactive login\n' +
    '- VERY IMPORTANT: NEVER use shell `find` or `grep` to search — use Grep and Glob. NEVER use `cat`, `head`, ' +
    '`tail`, or `ls` to read files and list directories — use Read and LS. Those tools apply the ignore list, ' +
    'skip binaries, add line numbers, and enforce a timeout; the shell equivalents do none of that\n' +
    '- Chain multiple commands on one line with `&&` (stop on first failure) or `;`\n' +
    '- Quote paths that contain spaces: `cd "path with spaces"`\n' +
    '- A non-zero exit code comes back to you as an error, with stdout and stderr included',
  schema: BashInput,
  readOnly: false,
  // ★ 破坏性:一条 shell 命令能做的事没有上界。`auto` 档下会走到「需要询问」。
  destructive: true,
  needsNetwork: false,
  async run(input, ctx) {
    if (ctx.workspaceRoot === '') return toolFail(NO_WORKSPACE)

    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS
    ctx.emit({
      callId: ctx.callId,
      message: input.description ?? clampWithEllipsis(input.command, 80)
    })

    /*
      ★ 这里**不 try/catch**。`SpawnFn` 在被中断时抛的是 abortError,而
      `defineTool` 的契约要求中断原样往上抛(见 define.ts 文件头)。
      在这里包一层 catch 转成 toolFail,会让「用户点了停止」表现成
      「命令失败了」,于是模型换个写法再试一次 —— 停止按钮就失效了。
    */
    const r = await ctx.host.spawn(input.command, {
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
      timeoutMs
    })

    const parts = [section('stdout', r.stdout), section('stderr', r.stderr)].filter((s) => s !== '')

    if (r.code === 0) {
      return toolOk(parts.length === 0 ? '(command succeeded with no output)' : parts.join('\n'))
    }

    const head =
      r.code === 124
        ? `Command timed out after ${String(timeoutMs)}ms; the whole process group was killed.`
        : `Command exited with code ${String(r.code)}.`
    return toolFail(
      parts.length === 0 ? `${head} (no output)` : `${head}\n${parts.join('\n')}`
    )
  }
})

export const BASH_LIMITS = { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_CHARS } as const
