/**
 * 把「已加载的各层目录」摊平成一维行数组。
 *
 * 单独一个文件而不是留在 FilesView.tsx 里,是因为它是这一带**唯一有分支的纯逻辑**
 * (下面那个 `splice` 撤销),而 `.tsx` 那边一 import 就要拖进 React、lucide、
 * services、store —— 在 node 环境的 vitest 里跑不起来。拆开之后它是可测的,
 * 而 FilesView 只剩渲染。
 */
import type { DirListing, SortBy } from '../../../../shared/domain/file-tree'
import { sortEntries, type FileEntry } from '../../../../shared/domain/file-tree'

export interface Row {
  entry: FileEntry
  /** 缩进层数,根的直接子项是 0 */
  depth: number
}

/**
 * 递归的是**展开状态**不是网络请求:没展开的目录直接不下去,
 * 没加载回来的目录同样不下去(`listings[path]` 是 undefined)。
 * 所以 `node_modules` 只要没被点开,就一行都不会出现在结果里。
 *
 * 搜索是在**已加载的部分**里过滤的,并且**命中项的祖先目录会被保留** ——
 * 否则一列命中的文件名会失去缩进上下文,不知道各自属于哪个目录。
 * 那个保留是靠「先无条件压进去,子树走完发现两边都没中再 `splice` 撤掉」做的:
 * 走到目录那一行时还不知道它下面有没有命中,先压后撤比先探测再压少一次遍历。
 */
export function flatten(
  listings: Readonly<Record<string, DirListing>>,
  expanded: ReadonlySet<string>,
  root: string,
  sortBy: SortBy,
  showHidden: boolean,
  query: string | null,
  selectedPath: string | null = null
): Row[] {
  const needle = query === null ? '' : query.trim().toLowerCase()
  const out: Row[] = []

  const walk = (path: string, depth: number): boolean => {
    const listing = listings[path]
    if (listing === undefined) return false

    let any = false
    for (const entry of sortEntries(listing.entries, sortBy)) {
      // ★ 被点名选中的那一项不受「不显示隐藏项」约束 —— reveal 一个 .env 的结果
      //   不能是「树开出来了,却一行都没有」。用户没有别的入口能知道要去开隐藏项开关。
      if (entry.hidden && !showHidden && entry.path !== selectedPath) continue

      if (entry.kind === 'dir') {
        const at = out.length
        out.push({ entry, depth })
        const hitBelow = expanded.has(entry.path) ? walk(entry.path, depth + 1) : false
        const self = needle === '' || entry.name.toLowerCase().includes(needle)
        if (self || hitBelow) any = true
        // 自己没中、子树也没中 —— 连同刚压进去的整棵子树一起撤掉
        else out.splice(at)
      } else if (needle === '' || entry.name.toLowerCase().includes(needle)) {
        out.push({ entry, depth })
        any = true
      }
    }
    return any
  }

  walk(root, 0)
  return out
}
