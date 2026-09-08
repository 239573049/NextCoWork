/**
 * 目录遍历 —— `glob` / `grep` 共用的那一趟走。
 *
 * ★ **不做成 `KernelHost` 的端口**。遍历带着忽略规则,而忽略规则是**策略**;
 * `KernelHost` 是**能力**。一旦 `walk` 端口开始长 `ignore` 参数,端口就变成了
 * 半个业务层,而「换一套忽略规则」这种事就得去改宿主。
 *
 * ★ `root` 是**这一趟的基点**,不一定是工作区根:模型指到工作区外的目录时,
 * 基点就换成那个目录(见 `paths.ts` 的 `walkBaseOf`)。`rel` 一律相对 `root` 算。
 *
 * 这里有三道闸门,每一道都对应一种真实的挂死方式:
 *
 * 1. **软链成环**。`a/link -> ..` 在词法上完全正常,遍历会无限深下去。
 *    按目录的 realpath 去重,进过的目录不再进。
 * 2. **软链出界**。`ws/link -> /` 会让 grep 把用户的整个磁盘搜一遍并塞进上下文。
 *    每个要进的目录都过一次 `resolveInWorkspace`(基点是这一趟的 `root`),
 *    出了这一趟范围的直接跳过 —— 不是报错,因为一条这样的软链不该让整次搜索失败。
 *    注意这**不是**权限边界:模型可以直接把 `root` 指到那个目录去。它拦的是
 *    「你只要了一个目录,却顺着一条链把半个磁盘搜了」。
 * 3. **量与时间**。`maxEntries` / `maxDepth` / `deadlineMs` 三条都必须有,
 *    而且超了要**照实说**(`truncated` / `timedOut`)—— 静默的部分结果
 *    会让模型断言「仓库里没有」。
 */
import { join } from 'node:path'
import { abortError } from '../../abort'
import type { KernelFs } from '../../host'
import { PathEscapeError, resolveInWorkspace } from '../path-guard'

export interface WalkEntry {
  /** 相对这一趟的 `root`、始终用 `/` 分隔 —— 和 `FileEntry.path` 同一种形式 */
  rel: string
  abs: string
  isDir: boolean
}

export interface WalkOptions {
  fs: Pick<KernelFs, 'readDir'>
  /** 这一趟的基点(工作区根,或模型指定的那个工作区外的目录)。必须是已经 realpath 过的。 */
  root: string
  /** 从基点下的哪个子目录开始。`''` = 基点本身。 */
  start?: string
  signal: AbortSignal
  now(): number
  /** 收集到多少项就停。默认 20000。 */
  maxEntries?: number
  /** 相对 `start` 的最大深度。默认 32 —— 够深,又挡得住软链没查到的怪环。 */
  maxDepth?: number
  /** 墙钟预算,毫秒。默认 5000。 */
  deadlineMs?: number
  /** 返回 true 就跳过。默认用 `ignore.ts` 的表。 */
  skip?(name: string, isDir: boolean): boolean
}

export interface WalkResult {
  entries: WalkEntry[]
  /** 撞上 `maxEntries` 或 `maxDepth` */
  truncated: boolean
  /** 撞上 `deadlineMs` */
  timedOut: boolean
}

const DEFAULT_MAX_ENTRIES = 20_000
const DEFAULT_MAX_DEPTH = 32
const DEFAULT_DEADLINE_MS = 5_000
/** 每处理这么多项查一次中断与时间。太密会拖慢,太疏会让停止按钮迟钝。 */
const CHECK_EVERY = 128

/**
 * 广度优先。
 *
 * ★ BFS 而不是 DFS,是因为**截断的语义不一样**:撞上 `maxEntries` 时,
 * BFS 留下的是靠近根的那些文件(通常正是模型想要的),DFS 留下的是
 * 第一棵子树钻到底的那一串 —— 用户搜 `*.ts` 拿回来的可能全是
 * `packages/a/src/...` 下的,而根目录的 `index.ts` 一个都没有。
 */
export async function walk(opts: WalkOptions): Promise<WalkResult> {
  const {
    fs,
    root,
    start = '',
    signal,
    now,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxDepth = DEFAULT_MAX_DEPTH,
    deadlineMs = DEFAULT_DEADLINE_MS,
    skip
  } = opts

  const deadline = now() + deadlineMs
  const entries: WalkEntry[] = []
  let truncated = false
  let timedOut = false
  let seen = 0

  /** 进过的目录(按 realpath)。软链成环时,第二次遇到同一个真实目录就停。 */
  const visited = new Set<string>()
  let frontier: Array<{ rel: string; abs: string; depth: number }> = []

  const startAbs = start === '' ? root : join(root, start)
  frontier.push({ rel: start, abs: startAbs, depth: 0 })
  visited.add(startAbs)

  while (frontier.length > 0) {
    const next: typeof frontier = []

    for (const dir of frontier) {
      if (signal.aborted) throw abortError()

      let listing: Array<{ name: string; isDir: boolean }>
      try {
        listing = await fs.readDir(dir.abs)
      } catch {
        // 没权限 / 刚被删掉 / 是个断链。跳过这一个目录,不让整次遍历失败。
        continue
      }

      for (const item of listing) {
        if (++seen % CHECK_EVERY === 0) {
          if (signal.aborted) throw abortError()
          if (now() > deadline) {
            timedOut = true
            return { entries, truncated, timedOut }
          }
        }

        if (skip?.(item.name, item.isDir) === true) continue

        const rel = dir.rel === '' ? item.name : `${dir.rel}/${item.name}`
        const abs = join(dir.abs, item.name)

        if (entries.length >= maxEntries) {
          truncated = true
          return { entries, truncated, timedOut }
        }
        entries.push({ rel, abs, isDir: item.isDir })

        if (!item.isDir) continue
        if (dir.depth + 1 >= maxDepth) {
          truncated = true
          continue
        }

        /*
          ★ 只有**要往里走**的目录才付这次 realpath 的钱。
          放到每一项上做的话,一个 5 万文件的仓库要多 5 万次系统调用。
        */
        let real: string
        try {
          real = resolveInWorkspace(root, rel)
        } catch (err) {
          // 软链指到工作区外面。跳过它,但**不中止遍历** —— 一个越界的软链
          // 不该让「搜一下这个仓库」整体失败。
          if (err instanceof PathEscapeError) continue
          continue
        }
        if (visited.has(real)) continue
        visited.add(real)

        next.push({ rel, abs, depth: dir.depth + 1 })
      }
    }

    frontier = next
  }

  return { entries, truncated, timedOut }
}
