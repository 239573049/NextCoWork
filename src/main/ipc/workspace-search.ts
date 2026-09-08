/**
 * 输入框 `@` 的文件检索 —— 一次遍历,一份带 TTL 的索引,主进程侧打分。
 *
 * ## 为什么不把整份文件清单发给渲染层去筛
 *
 * 一个中等仓库遍历下来是上万条路径。整批过 IPC 是几百 KB 的结构化克隆,
 * 而用户每敲一个字都想要新结果 —— 要么每次重发(卡),要么在渲染层缓存一份
 * (于是「什么时候失效」这个问题被搬到了一个更难处理的地方)。
 * 打分在主进程做,回去的永远只有十几条。
 *
 * ## 为什么索引有 TTL 而不是靠文件监听失效
 *
 * `fs.watch` 在大仓库上要么递归开销大、要么(macOS)给不出可靠的重命名事件,
 * 而这个功能对新鲜度的要求其实很低:用户刚 `git checkout` 完就 `@` 一个新文件
 * 的概率,不值得换一整套监听的复杂度和它自己的失效 bug。
 * 一次遍历的结果留几秒,连着敲十几下键就只走一趟盘。
 *
 * ★ 遍历本身**复用 `walk`**,连同它那三道闸门(软链成环、软链出界、量与时间)
 * 和 `defaultSkip` 那张忽略表。自己写一遍 readdir 递归就等于把
 * 「`node_modules` 会不会把主进程卡住」这个问题重新犯一次。
 */
import { realpathSync } from 'node:fs'
import type { FileSuggestion } from '../../shared/domain/file-tree'
import { rankPaths } from '../../shared/domain/fuzzy-path'
import { nodeFs } from '../kernel/node-fs'
import { defaultSkip } from '../kernel/tool/builtin/ignore'
import { walk } from '../kernel/tool/builtin/walk'
import { store } from '../state/store'
import { IpcError } from './errors'

/** 索引的新鲜期。够撑住一串连续敲键,又短到「切了分支」几秒后就能看到新文件。 */
const INDEX_TTL_MS = 15_000
/** 一次遍历最多收多少项。超过就截断 —— 见 `walk` 的 `truncated`。 */
const MAX_INDEX_ENTRIES = 40_000
/** 遍历的墙钟预算。★ 这是在**主进程**里跑的,超时比结果不全严重得多。 */
const INDEX_DEADLINE_MS = 3_000
/** 单次回给渲染层的条数上限。列表本来也只放得下十几行。 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

interface Index {
  files: FileSuggestion[]
  builtAt: number
}

/**
 * 每个工作区一份。★ 同时缓存**正在建的那个 Promise**:用户敲 `@` 之后
 * 连打三个字会并发进来三次,没有这一条就是三趟全量遍历。
 */
const cache = new Map<string, Index>()
const building = new Map<string, Promise<Index>>()

async function buildIndex(workspaceId: string, root: string): Promise<Index> {
  const r = await walk({
    fs: nodeFs(),
    // ★ `walk` 要求基点已经 realpath 过 —— 它内部拿这个根做越界判定
    root: realpathSync.native(root),
    signal: new AbortController().signal,
    now: () => Date.now(),
    maxEntries: MAX_INDEX_ENTRIES,
    deadlineMs: INDEX_DEADLINE_MS,
    skip: defaultSkip
  })
  const files: FileSuggestion[] = []
  for (const e of r.entries) {
    // 目录不进候选:`@` 引用的是一个能被读的文件
    if (e.isDir) continue
    files.push({ path: e.rel, name: e.rel.slice(e.rel.lastIndexOf('/') + 1) })
  }
  const index: Index = { files, builtAt: Date.now() }
  cache.set(workspaceId, index)
  return index
}

function indexOf(workspaceId: string, root: string): Promise<Index> {
  const hit = cache.get(workspaceId)
  if (hit !== undefined && Date.now() - hit.builtAt < INDEX_TTL_MS) return Promise.resolve(hit)

  const inflight = building.get(workspaceId)
  if (inflight !== undefined) return inflight

  const p = buildIndex(workspaceId, root).finally(() => {
    building.delete(workspaceId)
  })
  building.set(workspaceId, p)
  return p
}

/**
 * `@查询` → 候选文件。**路径一律是工作区相对、`/` 分隔**(同 `FileEntry.path`)——
 * 它会原样落进用户的草稿,再原样发给模型,所以必须是 `displayPath` 认的
 * 那一种写法(见 `path-guard.ts`),不能是绝对路径。
 */
export async function searchWorkspaceFiles(req: {
  workspaceId: string
  query: string
  limit?: number
}): Promise<FileSuggestion[]> {
  const ws = store.getWorkspace(req.workspaceId)
  if (!ws) throw new IpcError('unknown', `工作区不存在: ${req.workspaceId}`)

  let index: Index
  try {
    index = await indexOf(req.workspaceId, ws.rootPath)
  } catch {
    // 根被删/改名/没权限。★ 返回空列表而不是抛:`@` 只是个便利入口,
    //   它失败不该在输入框上弹一个错误,用户照样可以把路径打出来。
    return []
  }

  const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  return rankPaths(index.files, req.query, limit)
}

/** 工作区关闭/换根时丢掉它的索引。留着只是白占内存。 */
export function forgetFileIndex(workspaceId: string): void {
  cache.delete(workspaceId)
  building.delete(workspaceId)
}
