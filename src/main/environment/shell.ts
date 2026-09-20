/**
 * 「在这个环境里跑一条 shell 命令，要用哪个 shell、怎么传参」——一处答案。
 *
 * 需求：钩子（`hooks.ts`）和 agent 的后台 shell（`agent-shells.ts`）都要经
 * `openProcess` 起一个 shell，而这件事的**平台判断不是一行**：本地看
 * `platform.shell` 并按方言拼参数（PowerShell 要编码传入），远端看 `facts.os`
 * 且只能用最保守的 `-c` / `/d /s /c`（那头的 shell 我们没有探测过方言）。
 *
 * ★ 两处各写一份的代价不是难看，是**只会有一份被改**：Windows 的引号规则
 * 以后一定还要动，而漏掉的那一份的症状是「钩子好使，后台命令在 Windows 上
 * 悄悄少了一半参数」——没有报错，只有行为差异。
 *
 * ★ 本模块刻意**不导出 `openProcess` 的封装**：`detached` 该不该给、超时谁管，
 * 两个调用方的答案不一样（钩子有超时，后台 shell 没有），合并会让那两条
 * 不同的生命周期挤进同一个参数表。
 */
import { shellCommandArgs, shellDialect } from '../kernel/node-spawn'
import type { WorkspaceEnvironment } from './contract'

/** 平台对应的 shell 调用方式。远端看 `facts.os`，本地看自己。 */
export function shellFor(environment: WorkspaceEnvironment): { command: string; args: (c: string) => string[] } {
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
 * `openProcess` 的 `windowsVerbatimArguments`。
 *
 * ★ 只对**本机的 cmd.exe** 成立：`shellCommandArgs` 给 cmd 拼的是一个自带引号的
 * `"..."`，Node 再引一次就会把引号喂进 argv。远端不适用——那头的命令行由 ssh
 * 拼，本机的引号规则说了不算。
 */
export function shellVerbatimArguments(environment: WorkspaceEnvironment, command: string): boolean {
  return !environment.remote && environment.platform.os === 'win32' && shellDialect(command) === 'cmd'
}
