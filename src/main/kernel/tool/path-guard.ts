/**
 * 路径归一化与围栏 —— **任何工具、任何 handler 碰路径,唯一的入口**(方案 §9)。
 *
 * 朴素的 `path.join` 在这五件事上一件都做不对:
 *
 *   - `../../etc/passwd`      —— 词法逃逸
 *   - `/etc/passwd`           —— 给绝对路径时 join 会把它当成新根
 *   - `link -> /etc`          —— 词法上在根里面,realpath 之后在外面
 *   - `/var` vs `/private/var`—— macOS 上同一个目录的两个"正确"写法
 *   - `/Users/x/WS` vs `/users/x/ws` —— macOS/Windows 大小写不敏感
 *
 * 每个调用方各自拼路径的话,这五个点会遍地都是,且**无法在一个地方修好**。
 * 所以归一化只有一份实现:`resolveAnywhere`。
 *
 * ★ 「解析」和「围栏」是两件事,现在分开了。
 *
 * `resolveAnywhere` 解析并**报告**落点在不在根里面;`resolveInWorkspace` 是它上面
 * 一层薄壳,落在外面就抛。两者共用同一套归一化 —— 分成两份实现的话,
 * 上面那五条里迟早有一条只在其中一份里修好。
 *
 * 谁该用哪个:
 *   - 内置文件工具、文件树、文档读写 → `resolveAnywhere`。用户按权限档位决定
 *     agent 能碰什么,不再由一道写死的目录边界决定。
 *   - Skill / 子代理 / `AGENTS.md` 的加载 → 仍然是 `resolveInWorkspace`。那三处读到的
 *     东西**自动进系统提示词**,一条指向 `~/.ssh/id_rsa` 的软链就是一次静默外泄,
 *     和「模型明着读一个文件」不是同一类事。
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

/** 一次解析的结果。`abs` 永远是 realpath 之后的真实路径,调用方直接拿去用。 */
export interface Resolution {
  abs: string
  /** 落点在 `root` 外面。根解析不出来(空串 / 工作区被删)时恒为 `true` */
  outside: boolean
}

/**
 * 把一个**不可信**的路径解析成绝对路径,并报告它落在工作区里面还是外面。**不抛越界。**
 *
 * `p` 可以是相对工作区的(`src/main`)也可以是绝对的。绝对路径不需要工作区就能解析 ——
 * 工作区没绑定或者被删掉时,`{ outside: true }`,而不是失败。相对路径没有基准,那时才抛。
 *
 * ★ 内外**只比一次**,而且两边都是 realpath 之后的形式。
 *
 * 这里曾经先拿词法形式比一道再拿 real 比第二道,那是错的:`realRoot` 是 realpath 过的、
 * `joined` 没有,macOS 上工作区落在 `/var`(或用户自己建的软链,把 `~/code` 指到外置卷
 * 是常见做法)时,根是 `/private/var/…` 而调用方给的绝对路径是 `/var/…` ——
 * **两个字符串指同一个目录,词法那道却判它在外面**。工作区记录里的 `rootPath` 就是
 * `showOpenDialog` 原样返回的没折算过的那种,所以这不是理论情况,是自家代码就会踩的。
 *
 * 去掉那道也不会变松:`resolve()` 在 realpath 之前就把 `..` 折叠掉了,
 * 而 `realpathOfDeepestExisting` 本来就处理"目标还不存在"。
 */
export function resolveAnywhere(root: string, p: string): Resolution {
  if (isAbsolute(p)) {
    const abs = realpathOfDeepestExisting(resolve(p))
    let realRoot: string
    try {
      realRoot = realpathSync.native(root)
    } catch {
      // 根读不到(没绑工作区 / 目录被删)。绝对路径本身照样成立,只是无从判断内外。
      return { abs, outside: true }
    }
    return { abs, outside: !contains(realRoot, abs) }
  }

  // 相对路径必须有基准。★ 根不存在时照抛,那是环境问题,调用方要能分辨出来。
  if (root === '') throw new Error(`没有工作区根,无法解析相对路径: ${p}`)
  const realRoot = realpathSync.native(root)
  const real = realpathOfDeepestExisting(resolve(realRoot, p))
  return { abs: real, outside: !contains(realRoot, real) }
}

/**
 * 同上,但**落在根外面就抛 `PathEscapeError`**。
 *
 * 用在那些「读到的东西会自动进系统提示词」的地方(见文件头)。内置文件工具**不**走这个。
 */
export function resolveInWorkspace(root: string, p: string): string {
  const r = resolveAnywhere(root, p)
  if (!r.outside) return r.abs

  let realRoot = root
  try {
    realRoot = realpathSync.native(root)
  } catch {
    // 根都读不到就用原样的根报错 —— 这条信息只进日志,不进模型的回执
  }
  throw new PathEscapeError(p, realRoot)
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

/**
 * 绝对路径 → **说给模型听的那一种形式**:工作区内的压成工作区相对,
 * 工作区外的保留绝对路径(与工具回执同形,即 realpath 之后的那一种)。
 * 没有工作区时一律绝对。
 *
 * ★ 这是全项目对「一条路径怎么写给模型」的**唯一**答案 —— 工具回执(`relOf`)
 * 和用户拖/选进来的文件引用(`file_ref`)都走它。两处各写一遍的后果是:模型从
 * 附件里读到 `/Users/x/proj/a.ts`,从 grep 回执里读到 `src/a.ts`,于是把同一个
 * 文件当成两个。
 *
 * ★ **绝不产出 `../../x`**。那种形式对不上任何一个根,模型再喂回来时基准全看运气。
 * 判定走 `resolveAnywhere` 而不是字符串前缀:macOS 上 `/var` 与 `/private/var`
 * 是同一个目录,词法比较会把工作区内的文件判到外面去(见本函数上方那段注释)。
 */
export function displayPath(root: string, abs: string): string {
  if (root === '') return abs
  try {
    /*
      ★ **比较之前两边都得 realpath**,而这里只有 `resolveAnywhere` 做得到 ——
      它返回的 `r.abs` 才是能和 `toWorkspaceRelative` 里那个 realpath 过的根对齐的
      形式。直接把入参喂给 `toWorkspaceRelative` 的话,根是 `/private/var/…`、
      入参是 `/var/…`,`relative()` 算出一串 `../..` 于是判定成「工作区外」——
      而调用方(`file_ref`)给的恰恰就是没折算过的那种路径。
    */
    const r = resolveAnywhere(root, abs)
    if (r.outside) return r.abs
    const rel = toWorkspaceRelative(root, r.abs)
    if (rel === '') return '.'
    return rel.startsWith('../') || rel === '..' ? r.abs : rel
  } catch {
    // 根读不到(工作区被删/改名)。绝对路径本身仍然成立,原样给出去。
    return abs
  }
}
