/**
 * 每个碰路径的内置工具都要做的那几件事,收口成一处。
 *
 * ★ 存在的理由和 `path-guard.ts` 一样,只是低一层:围栏本身只有一个入口了,
 * 但「围栏抛出来之后跟模型怎么说」如果每个工具各写一遍,就会出现
 * 「read_file 越界时说人话、grep 越界时甩一个 Error.message」这种不一致 ——
 * 而模型是照着错误消息决定下一步做什么的。
 */
import type { ToolResult } from '../../../../shared/agent/tool'
import { toolFail } from '../../../../shared/agent/tool'
import { PathEscapeError, resolveInWorkspace, toWorkspaceRelative } from '../path-guard'
import type { ToolContext } from '../registry'

/**
 * 没有工作区时的说辞。
 *
 * ★ `runtime.ts` 的 `workspaceRootFor` 查不到工作区时给的是**空串**,而不是
 * 一个临时目录 —— 给临时目录的话,模型会以为自己在用户的项目里干活,
 * 然后把文件写进一个谁也不会去看的地方,并报告「已完成」。
 */
export const NO_WORKSPACE =
  'This session has no workspace bound, so file tools are unavailable. Ask the user to open a workspace ' +
  'directory first, then retry this step.'

export type Resolved = { ok: true; abs: string } | { ok: false; result: ToolResult }

/**
 * 把模型给的路径解析成工作区内的绝对路径。**所有碰路径的工具的第一行。**
 *
 * ★ 失败信息里**只出现模型自己传进来的那个路径**,不出现工作区根、
 * 也不出现目标文件的任何内容 —— 越界尝试的回执不该变成一次信息泄露。
 */
export function resolvePath(ctx: ToolContext, p: string): Resolved {
  if (ctx.workspaceRoot === '') return { ok: false, result: toolFail(NO_WORKSPACE) }
  try {
    return { ok: true, abs: resolveInWorkspace(ctx.workspaceRoot, p) }
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return {
        ok: false,
        result: toolFail(
          `The path "${p}" is outside the workspace. File tools can only reach files inside the workspace ` +
            `directory. Use a workspace-relative path instead, e.g. src/main/index.ts.`
        )
      }
    }
    // 根本身不存在(工作区被删了/改名了)。这是环境问题,不是模型的错。
    return {
      ok: false,
      result: toolFail(`Could not resolve the path "${p}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 绝对路径压回工作区相对形式。展示给模型的路径**一律**是这一种。 */
export function relOf(ctx: ToolContext, abs: string): string {
  try {
    return toWorkspaceRelative(ctx.workspaceRoot, abs) || '.'
  } catch {
    return abs
  }
}

/** 人类可读的字节数。工具输出里出现绝对字节数只会占 token,不会帮上忙。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 二进制探测:前若干字节里出现 NUL 就算二进制。
 *
 * 和 git 用的是同一条判据。★ 探测必须在**解码之前**做完,所以入参是字节不是字符串
 * —— 见 `KernelFs.readFileBytes` 的注释。
 */
export function looksBinary(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b === 0) return true
  return false
}
