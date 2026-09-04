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
  command: z.string().min(1).describe('要执行的命令'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`可选的超时,单位毫秒,最大 ${String(MAX_TIMEOUT_MS)}。省略则用 ${String(DEFAULT_TIMEOUT_MS)}`),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('用 5-10 个字说清这条命令做什么,会显示在界面上给用户看')
})

/** 一段输出的呈现:空的时候要说「空」,不能给一段静默的空白让模型以为没读到。 */
function section(title: string, body: string): string {
  const t = body.trim()
  return t === '' ? '' : `<${title}>\n${clampWithEllipsis(t, MAX_OUTPUT_CHARS)}\n</${title}>`
}

export const bashTool: ToolRegistration = defineTool({
  internalId: 'Bash',
  description:
    '在工作区目录里执行一条 shell 命令,带超时和输出上限。\n\n' +
    '执行之前:\n' +
    '1. **确认目录**:要在新目录里建文件时,先用 LS 确认父目录确实存在、确实是你想的那个位置。\n' +
    '2. **确认命令**:命令是直接在用户机器上跑的。会删数据、会改全局配置、会往外发东西的命令,' +
    '先跟用户说清楚再执行。\n\n' +
    '用法说明:\n' +
    `- command 必填。timeout 可选,单位毫秒,最大 ${String(MAX_TIMEOUT_MS)}(10 分钟),` +
    `省略则 ${String(DEFAULT_TIMEOUT_MS)}(2 分钟)\n` +
    '- 用 5-10 个字写一下 description,用户在界面上看到的就是它\n' +
    `- 输出超过 ${String(MAX_OUTPUT_CHARS)} 个字符会被截断\n` +
    '- ★ **每次调用都是一个全新的 shell,状态不保留**。上一次的 cd、export、变量赋值' +
    '在下一次调用里全都不在了。工作目录始终是工作区根目录,所以**请用绝对路径或工作区相对路径**,' +
    '不要靠 cd 来定位。要在别处执行就写成 `cd 子目录 && 命令`,放在**同一次调用**里\n' +
    '- ★ **标准输入是关闭的**。任何会等输入的命令都会挂到超时:' +
    'git commit 要带 -m,包管理器要带 --yes / --no-input,不要用需要登录交互的命令\n' +
    '- **非常重要**:不要用 shell 里的 `find` / `grep` 搜索,请用 Grep 和 Glob;' +
    '不要用 `cat` / `head` / `tail` / `ls` 读文件和列目录,请用 Read 和 LS。' +
    '那几个工具做了忽略规则、二进制跳过、行号和超时保护,而 shell 版本没有\n' +
    '- 多条命令请用 `&&`(前一条成功才继续)或 `;` 连在一行里\n' +
    '- 路径里有空格时要加引号:`cd "路径 带空格"`\n' +
    '- 退出码非 0 时会作为错误返回给你,stdout 和 stderr 都在里面',
  schema: BashInput,
  readOnly: false,
  // ★ 破坏性:一条 shell 命令能做的事没有上界。`auto` 档下会走到「需要询问」。
  destructive: true,
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
      return toolOk(parts.length === 0 ? '(命令执行成功,没有任何输出)' : parts.join('\n'))
    }

    const head =
      r.code === 124
        ? `命令超时(超过 ${String(timeoutMs)}ms),整个进程组已被终止。`
        : `命令退出码 ${String(r.code)}。`
    return toolFail(
      parts.length === 0 ? `${head}(没有任何输出)` : `${head}\n${parts.join('\n')}`
    )
  }
})

export const BASH_LIMITS = { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_CHARS } as const
