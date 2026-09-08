/**
 * 每个碰路径的内置工具都要做的那几件事,收口成一处。
 *
 * ★ 存在的理由和 `path-guard.ts` 一样,只是低一层:解析本身只有一个入口了,
 * 但「解析完之后跟模型怎么说这条路径」如果每个工具各写一遍,就会出现
 * 「read_file 报的是相对路径、grep 报的是绝对路径」这种不一致 ——
 * 而模型是照着回执里的路径决定下一步喂什么参数的。
 */
import { isAbsolute, join } from 'node:path'
import type { ToolResult } from '../../../../shared/agent/tool'
import { toolFail } from '../../../../shared/agent/tool'
import { resolveAnywhere, toWorkspaceRelative } from '../path-guard'
import type { ToolContext } from '../registry'

/**
 * 没有工作区时的说辞。`Bash` 用它 —— 没有工作区就没有 cwd,一条命令无处可跑。
 *
 * ★ `runtime.ts` 的 `workspaceRootFor` 查不到工作区时给的是**空串**,而不是
 * 一个临时目录 —— 给临时目录的话,模型会以为自己在用户的项目里干活,
 * 然后把文件写进一个谁也不会去看的地方,并报告「已完成」。
 */
export const NO_WORKSPACE =
  'This session has no workspace bound, so file tools are unavailable. Ask the user to open a workspace ' +
  'directory first, then retry this step.'

/**
 * 没有工作区、而且给的是**相对**路径时的说辞。
 *
 * ★ 绝对路径不受这条限制:没有工作区也照样能读写它,因为它本来就不需要基准。
 * 所以这条不能说成「文件工具不可用」—— 那会让模型连试都不试。
 */
export const NO_WORKSPACE_RELATIVE =
  'This session has no workspace bound, so a relative path has nothing to resolve against. Pass an ' +
  'absolute path instead, or ask the user to open a workspace directory first.'

export type Resolved =
  | { ok: true; abs: string; outside: boolean }
  | { ok: false; result: ToolResult }

/**
 * 把模型给的路径解析成绝对路径。**所有碰路径的工具的第一行。**
 *
 * ★ 落在工作区外面**不是错误** —— 用户按权限档位决定 agent 能碰什么(见 `path-guard.ts`
 * 文件头)。`outside` 只影响这条路径怎么展示(见 `relOf`)和搜索工具从哪个根开始遍历。
 *
 * ★ 失败信息里**只出现模型自己传进来的那个路径**,不出现目标文件的任何内容。
 */
export function resolvePath(ctx: ToolContext, p: string): Resolved {
  if (ctx.workspaceRoot === '' && !isAbsolute(p)) return { ok: false, result: toolFail(NO_WORKSPACE_RELATIVE) }
  try {
    const r = resolveAnywhere(ctx.workspaceRoot, p)
    return { ok: true, abs: r.abs, outside: r.outside }
  } catch (err) {
    // 根本身不存在(工作区被删了/改名了)。这是环境问题,不是模型的错。
    return {
      ok: false,
      result: toolFail(`Could not resolve the path "${p}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * 绝对路径压成**展示形式**:工作区内的压回工作区相对,工作区外的原样保留绝对路径。
 *
 * ★ 绝不产出 `../../x`。那种形式对不上任何一个根 —— 模型把它再喂回来时基准是谁全看运气,
 * 而 `walk()` 的 `join(root, start)` 会被它直接带偏。
 */
export function relOf(ctx: ToolContext, abs: string): string {
  if (ctx.workspaceRoot === '') return abs
  try {
    const rel = toWorkspaceRelative(ctx.workspaceRoot, abs)
    if (rel === '') return '.'
    return rel.startsWith('../') || rel === '..' ? abs : rel
  } catch {
    return abs
  }
}

/**
 * 一次目录遍历的基准 —— `walk()` 从哪儿起步,以及它产出的 `rel` 怎么变成展示形式。
 *
 * ★ `walk()` 的 `rel` 是**相对 `root`** 算的,而 `root` 同时还是它内部挡软链成环、
 * 挡越界的信任基点。所以目标落在工作区外时,不能继续把 `root` 钉死在工作区根上再
 * 拿绝对路径当 `start` —— `join(root, start)` 会把绝对路径当成新根,遍历结果要么为空
 * 要么指向一个谁也没要求的目录。正确的做法是**把基准整个换过去**。
 */
export interface WalkBase {
  root: string
  start: string
  /** 起点本身的展示形式,用在「在 X 下面没找到」这类话里 */
  label: string
  /** 把 `walk()` 产出的 `rel` 变成展示形式 */
  display(rel: string): string
}

export function walkBaseOf(ctx: ToolContext, target: { abs: string; outside: boolean }): WalkBase {
  if (target.outside) {
    return {
      root: target.abs,
      start: '',
      label: target.abs,
      display: (rel) => (rel === '' ? target.abs : join(target.abs, rel))
    }
  }
  const rel = relOf(ctx, target.abs)
  return {
    root: ctx.workspaceRoot,
    start: rel === '.' ? '' : rel,
    label: rel,
    display: (r) => r
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
