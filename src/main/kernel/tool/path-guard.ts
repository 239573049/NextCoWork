/**
 * 路径围栏 —— **任何工具、任何 handler 碰工作区里的路径,唯一的入口**(方案 §9)。
 *
 * 路径逃逸是那种真的会发布出去的安全 bug,而朴素的 `path.join` 一个都拦不住:
 *
 *   - `../../etc/passwd`      —— 词法逃逸
 *   - `/etc/passwd`           —— 模型直接给绝对路径,join 会把它当成新根
 *   - `link -> /etc`          —— 词法上在根里面,realpath 之后在外面
 *   - `/var` vs `/private/var`—— macOS 上同一个目录的两个"正确"写法
 *   - `/Users/x/WS` vs `/users/x/ws` —— macOS/Windows 大小写不敏感
 *
 * 每个工具各自拼路径的话,这五个点会遍地都是,且**无法在一个地方修好**。
 * 所以这里只导出一个函数,别在别处 `path.join(root, ...)`。
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 逃逸不是"错误情况",是攻击 —— 用独立类型让上层能分辨出来并单独记日志。 */
export class PathEscapeError extends Error {
  constructor(
    readonly attempted: string,
    readonly root: string
  ) {
    super(`路径越出工作区: ${attempted}`)
    this.name = 'PathEscapeError'
  }
}

/**
 * macOS 与 Windows 的文件系统**大小写不敏感**,所以 `/Users/x/ws/a` 和
 * `/users/X/WS/a` 是同一个文件。用 `===` 比较会让攻击者靠改大小写绕过围栏。
 *
 * Linux 反过来:大小写敏感,折叠比较会把两个**不同**的目录当成同一个,
 * 那是另一个方向的错。所以这个判断必须看平台。
 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

function sameOrInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  // `relative` 返回 '' 表示就是根本身;以 `..` 开头表示在根外面;
  // 绝对路径表示两者根本不在同一个卷(Windows 的 C: / D:)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return !rel.startsWith(`..${sep}`) && rel !== '..'
}

function contains(root: string, target: string): boolean {
  return CASE_INSENSITIVE
    ? sameOrInside(root.toLowerCase(), target.toLowerCase())
    : sameOrInside(root, target)
}

/**
 * 目标还不存在时(写新文件)`realpath` 会抛,所以往上退到**最深的存在的祖先**
 * 再 realpath —— 这一步才是挡符号链接的地方。
 *
 * 只 realpath 根、不 realpath 目标,等于没做:`<root>/link` 指向 `/etc` 时,
 * 词法检查一路绿灯。
 */
function realpathOfDeepestExisting(p: string): string {
  let cur = p
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync.native(cur) : join(realpathSync.native(cur), ...tail)
    } catch {
      const parent = resolve(cur, '..')
      // 一路退到卷根都读不到 —— 交给调用方按"不存在"处理,别在这里静默通过
      if (parent === cur) return p
      tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''))
      cur = parent
    }
  }
}

/**
 * 把一个**不可信**的路径解析成工作区内的绝对路径,越界就抛 `PathEscapeError`。
 *
 * `p` 可以是相对工作区的(`src/main`)也可以是绝对的 —— 绝对路径不特殊照顾,
 * 一样要落在根里面才放行。返回值是 realpath 之后的真实路径,调用方直接拿去用。
 */
export function resolveInWorkspace(root: string, p: string): string {
  const realRoot = realpathSync.native(root)
  const joined = isAbsolute(p) ? resolve(p) : resolve(realRoot, p)

  /*
    ★ 只比一次,而且**两边都必须是 realpath 之后的形式**。

    这里曾经先拿 `joined` 词法比一道再拿 `real` 比第二道,那是错的:
    `realRoot` 是 realpath 过的、`joined` 没有,macOS 上工作区落在 `/var`
    (或用户自己建的软链,把 `~/code` 指到外置卷是常见做法)时,
    根是 `/private/var/…` 而调用方给的绝对路径是 `/var/…` ——
    **两个字符串指同一个目录,词法那道却判它越界**。
    工作区记录里的 `rootPath` 就是 `showOpenDialog` 原样返回的没折算过的那种,
    所以这不是理论情况,是自家代码就会踩的。

    去掉那道也不会变松:`resolve()` 在 realpath 之前就把 `..` 折叠掉了,
    而 `realpathOfDeepestExisting` 本来就处理"目标还不存在"。
    词法能拦的每一种,realpath 这道都拦得住,并且它还多拦一种(软链)。
  */
  const real = realpathOfDeepestExisting(joined)
  if (!contains(realRoot, real)) throw new PathEscapeError(p, realRoot)

  return real
}

/**
 * 反向:把绝对路径压回**工作区相对**的、始终用 `/` 的形式。
 *
 * 渲染层拿到的一律是这种形式 —— 一来它是跨平台稳定的 key,
 * 二来 UI 里永远不出现用户的绝对路径。
 */
export function toWorkspaceRelative(root: string, abs: string): string {
  return relative(realpathSync.native(root), abs).split(sep).join('/')
}
