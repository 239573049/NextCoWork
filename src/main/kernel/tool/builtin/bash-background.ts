/**
 * `BashOutput` / `KillShell` —— `Bash({ run_in_background: true })` 的另外两半。
 *
 * 需求:后台命令返回的只是一个 id,它此后的一切(有没有起来、报了什么错、
 * 什么时候该收工)都得有路可问、有路可停。三个工具缺任何一个,后台这件事
 * 都不成立:
 * - 只有 `Bash` 后台:模型起了个服务,再也读不到它说了什么 —— 和没起一样;
 * - 只有 `BashOutput`:进程永远停不下来,退出应用才收得掉;
 * - 只有 `KillShell`:能停,但没人知道该不该停。
 *
 * ★ **两个工具,不是一个带 `action` 的**。理由同 `scheduled.ts` 文件头那段:
 * `readOnly` 是工具级的静态标记,plan 模式按它摘工具、权限闸门按它决定要不要
 * 弹审批。合成一个的话只能整体标成「写」—— 于是计划模式下连「那个构建跑完没有」
 * 都查不了,而查一下本来是零风险的。
 *
 * ★ **没有 `list` 工具。** id 在 `Bash` 的返回里,找不到时 `read`/`kill` 的错误
 * 消息会把现有的全列出来(见 `agent-shells.ts` 的 `unknownShell`)。为「列一下」
 * 单开一个工具,等于让模型多花一轮去问一件它上一条消息里就有的事。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { clampWithEllipsis } from '../../text'
import { defineTool } from '../define'
import type { ToolContext, ToolRegistration } from '../registry'
import { redosRisk } from './redos'

/** 一次回读给模型的上限。比 Bash 的 30K 小:日志是会一直长的,而它每轮都可能读一次。 */
const MAX_READ_CHARS = 16_000

/** 三道门同 `scheduled.ts`:没有注册表的环境里整体不下发,而不是下发了再失败。 */
function hasShells(ctx: ToolContext): boolean {
  return ctx.shells !== undefined
}

const UNAVAILABLE =
  'Background shells are unavailable in this session. Do not retry — run commands in the foreground instead.'

function section(title: string, body: string): string {
  const trimmed = body.trim()
  return trimmed === '' ? '' : `<${title}>\n${clampWithEllipsis(trimmed, MAX_READ_CHARS)}\n</${title}>`
}

export const bashOutputTool: ToolRegistration = defineTool({
  internalId: 'BashOutput',
  description:
    'Reads output from a background shell started by Bash with run_in_background.\n\n'
    + '- Each call returns ONLY the output that arrived since your previous call on that shell, so poll it '
    + 'instead of re-reading from the start\n'
    + '- Returns the shell status too: running, exited (with its exit code), or killed. A shell that has '
    + 'exited can still be read once for whatever it printed last\n'
    + '- filter is an optional regular expression applied per line; only matching lines are returned. Output '
    + 'that does not match is DISCARDED, not saved for the next call\n'
    + '- An empty result while the shell is still running means nothing new was printed. Do not poll it in a '
    + 'tight loop; do something else and check again later',
  schema: z.object({
    bash_id: z.string().min(1).describe('The id returned when the command was started'),
    filter: z
      .string()
      .optional()
      .describe('Optional regular expression; only output lines matching it are returned')
  }),
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  isEnabled: hasShells,
  async run(input, ctx) {
    // 快照取自这一轮的开头,而 run() 可能几十秒后才执行 —— 同一份判定两处都跑(同 scheduled.ts)
    if (ctx.shells === undefined) return toolFail(UNAVAILABLE)

    /*
      ★ 正则先过 ReDoS 静态筛查,和 `Grep` 同一道闸(见 `redos.ts` 文件头)。
      `RegExp.test` 在 V8 里是原子的:跑进一个 `(a+)+` 就再也出不来,
      signal 查不了、时钟查不了,用户只能强杀整个应用。
    */
    if (input.filter !== undefined) {
      const risk = redosRisk(input.filter)
      if (risk !== null) return toolFail(risk)
    }

    try {
      const result = ctx.shells.read(input.bash_id, input.filter)
      const { info } = result
      const state = info.status === 'exited'
        ? `exited with code ${info.exitCode === undefined ? 'unknown' : String(info.exitCode)}`
        : info.status === 'killed'
          ? 'was killed'
          : 'is still running'
      const parts = [section('stdout', result.stdout), section('stderr', result.stderr)].filter((s) => s !== '')
      const dropped = result.dropped
        ? '\nNOTE: this shell produced more output than the buffer holds; the OLDEST part was dropped and is gone.'
        : ''
      return toolOk(
        `Shell ${info.id} (${info.command}) ${state}.\n`
        + (parts.length === 0 ? '(no new output since the last read)' : parts.join('\n'))
        + dropped
      )
    } catch (error) {
      // 桥抛的是给模型看的英文原因(同 SchedulingBridge 的约定),原样转交。
      return toolFail(error instanceof Error ? error.message : String(error))
    }
  }
})

export const killShellTool: ToolRegistration = defineTool({
  internalId: 'KillShell',
  description:
    'Stops a background shell started by Bash with run_in_background, killing its whole process tree.\n\n'
    + '- Kill a shell as soon as you no longer need it. A dev server you forget about keeps holding its port '
    + 'after this conversation ends\n'
    + '- Killing an already finished shell is not an error; it reports the status it already had\n'
    + '- Any output it printed but you never read is discarded. Call BashOutput first if you still need it',
  schema: z.object({
    shell_id: z.string().min(1).describe('The id of the background shell to stop')
  }),
  readOnly: false,
  /*
    ★ 不是 `destructive`。它能造成的最大后果是「一个后台进程提前结束」,
    而那个进程正是模型自己起的;标成破坏性会让 `auto` 档每次收工都弹一次审批,
    于是模型学会不收工 —— 那比多杀一个 dev server 坏得多。
  */
  destructive: false,
  needsNetwork: false,
  isEnabled: hasShells,
  async run(input, ctx) {
    if (ctx.shells === undefined) return toolFail(UNAVAILABLE)
    try {
      const info = ctx.shells.kill(input.shell_id)
      return toolOk(
        info.status === 'killed'
          ? `Killed shell ${info.id} (${info.command}) and its process tree.`
          : `Shell ${info.id} (${info.command}) had already finished (${info.status}); nothing to kill.`
      )
    } catch (error) {
      return toolFail(error instanceof Error ? error.message : String(error))
    }
  }
})

export const backgroundShellTools: ToolRegistration[] = [bashOutputTool, killShellTool]
