/**
 * 双击标签改名 —— 能测的那部分。
 *
 * ★ **为什么单独一个 `.ts` 文件**:`vitest.config.ts` 是 `environment: 'node'` +
 * `include: ['src/**\/*.test.ts']` —— `.tsx` 既不会被收集、也没有 DOM。改名这件事
 * 里真正会出错的是「这个标签该改什么」和「扩展名保不保得住」,把它们留在
 * `InnerTabBar.tsx` 里就等于一条用例都写不了。
 *
 * ★★ 三种去向**互不相通**,选错的表现都是「改完了,过一会儿又变回去」:
 * - 对话标签的标题**属于会话**,只改本地 Tab 的话,`syncSessionTitle` 和下一次
 *   重载都会从会话里把旧标题覆盖回来;
 * - 文件类标签的标题**派生自路径**,`applyFileMutation` 每次都按新 basename 重置,
 *   只改 Tab 标题同样活不过一次文件改动;
 * - 剩下的(终端 / 浏览器 / 文件树)才是真正的「本地别名」,存在 Tab 自己身上。
 */
import type { InnerTab } from '../../../shared/domain/tab'

export type TabRenameTarget =
  /** 标题属于会话,要走 `sessions:rename` */
  | { kind: 'session' }
  /** 标题派生自路径,改的是**磁盘上的文件名** */
  | { kind: 'file'; path: string }
  /** 纯本地别名,存在 Tab 上 */
  | { kind: 'local' }

/**
 * 这个标签双击之后该改什么。`null` = 不给改名入口。
 *
 * ★ 文件类标签在 `path` 为空时返回 `null` 而不是退回 `'local'`:那是一张还没落盘的
 * 草稿(`tab.untitledDoc`),给它改一个"本地别名"只会让用户以为文件已经叫这个名字了,
 * 而保存时弹出来的仍然是原来那个名字。
 */
export function tabRenameTarget(tab: InnerTab): TabRenameTarget | null {
  switch (tab.kind) {
    case 'chat':
      return { kind: 'session' }
    case 'doc':
    case 'draw':
    case 'preview':
    case 'custom':
      return tab.ref.path === '' ? null : { kind: 'file', path: tab.ref.path }
    case 'terminal':
    case 'browser':
    case 'files':
      return { kind: 'local' }
    case 'changes':
      // 审查 tab 的标题是派生的(哪一轮),不给改名入口。
      return null
    case 'webapp':
      /*
        网页应用的标题来自插件清单(而且跟着语言走),不给改名入口 ——
        改了之后插件一升级、或者用户切一次语言,那个别名就和它指向的东西对不上了。
      */
      return null
  }
}

/**
 * 输入框里默认选中的那一段 —— **文件名去掉扩展名**(VS Code / Finder 的行为)。
 *
 * ★ `lastIndexOf('.') > 0` 而不是 `>= 0`:`.gitignore` 的点在下标 0,它整个就是
 * 文件名,没有扩展名。判成"扩展名是 gitignore、主干是空"的话,双击它会得到一个
 * 全空的选区,看起来就像什么都没选中。
 */
export function fileNameStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 用户没打扩展名时补回原来那个。
 *
 * 默认选区本来就不含扩展名,所以"用户把整串都替换掉了、而且新串里没有点"这件事
 * 只能是他整段重打过 —— 此时保住扩展名比忠实照搬更符合预期:把 `a.excalidraw`
 * 改成 `b`,要的是 `b.excalidraw`,不是一个宿主再也认不出来的 `b`。
 *
 * ★ 用户**自己打了**扩展名(`b.md`)就照搬,这是他明确要换类型。
 * ★ 以点开头的裸名(`.gitignore`)也照搬 —— 那是个点文件名,不是"缺了扩展名"。
 */
export function restoreExtension(input: string, original: string): string {
  const name = input.trim()
  if (name === '') return name
  if (name.startsWith('.')) return name
  if (name.includes('.')) return name
  const dot = original.lastIndexOf('.')
  return dot > 0 ? `${name}${original.slice(dot)}` : name
}

/** 路径的最后一段 —— 标签标题和改名输入框的初值都用它。 */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}
