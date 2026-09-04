/**
 * glob 匹配器 —— **纯函数,零 IO**。
 *
 * 不引 `fast-glob` / `globby`:它们**自己做 fs 遍历**,正好绕过 `KernelFs` 和
 * `resolveInWorkspace` —— 安全相关的那一半会被库整个吃掉,而那一半正是
 * `path-guard.ts` 存在的全部理由。这里只负责匹配,遍历留给 `walk.ts`。
 *
 * ## 支持的子集(这就是契约)
 *
 * | 写法 | 含义 |
 * |---|---|
 * | `*` | 段内任意字符,**不跨 `/`** |
 * | `**` | 任意层级;后面跟 `/` 时可以匹配**零**层 |
 * | `?` | 段内单个字符 |
 * | `{a,b}` | 二选一,**不支持嵌套** |
 * | 其余 | 全部按字面量,正则元字符一律转义 |
 *
 * **明确不支持**:字符类 `[abc]`、取反 `!`、扩展 glob `+(a|b)`。
 * 它们会被当成字面量,不会静默变成别的意思。
 */
import { sep } from 'node:path'

/**
 * 和 `path-guard.ts` 用同一条判断:macOS / Windows 的文件系统大小写不敏感,
 * 匹配就得跟着文件系统走 —— 否则 `*.TS` 在 mac 上明明有文件却匹配不到。
 */
const PLATFORM_CASE_SENSITIVE = !(process.platform === 'darwin' || process.platform === 'win32')

/** 编译结果的小缓存。`globMatch` 每个文件调一次,不缓存就是每次现编一个正则。 */
const CACHE = new Map<string, RegExp>()
const CACHE_MAX = 256

/** 正则元字符。注意 `*` `?` `{` `}` `,` 不在里面 —— 它们由匹配器自己消费。 */
function escapeLiteral(ch: string): string {
  return /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * 把 glob 编成正则。
 *
 * ★ 后面跟着斜杠的双星,编出来的必须是「**零层也算命中**」的那种形式
 * (见下面那行 `(?:[^/]*` 加斜杠再加 `)*`),而不是简单的「任意字符 + 斜杠」。
 * 用后者的话,「搜所有 ts 文件」会**静默漏掉根目录下的那几个**,而结果看起来
 * 完全合理 —— 这是这个文件里最容易写错、也最难发现的一处。
 */
export function compileGlob(pattern: string, caseSensitive = PLATFORM_CASE_SENSITIVE): RegExp {
  let out = '^'
  let braceDepth = 0

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          out += '(?:[^/]*/)*' // ★ 零层也算命中
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }

    if (ch === '?') {
      out += '[^/]'
      continue
    }

    if (ch === '{') {
      braceDepth++
      out += '(?:'
      continue
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--
      out += ')'
      continue
    }
    if (ch === ',' && braceDepth > 0) {
      out += '|'
      continue
    }

    out += escapeLiteral(ch)
  }

  // 花括号没闭合 —— 不抛错(pattern 来自模型),补齐了事,大不了匹配不到
  while (braceDepth-- > 0) out += ')'

  return new RegExp(`${out}$`, caseSensitive ? '' : 'i')
}

/**
 * 归一化成匹配用的形式:Windows 分隔符换成 `/`,去掉开头的 `./`。
 *
 * 匹配的目标一律是**工作区相对路径**,所以这里不接受也不产生绝对路径。
 */
export function normalizeGlobPath(p: string): string {
  let s = sep === '/' ? p : p.split(sep).join('/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

/** 一次性匹配。批量匹配请自己 `compileGlob` 一次再复用,别在循环里调它。 */
export function globMatch(pattern: string, path: string, caseSensitive?: boolean): boolean {
  const key = `${caseSensitive === undefined ? 'p' : caseSensitive ? 's' : 'i'} ${pattern}`
  let re = CACHE.get(key)
  if (re === undefined) {
    re = compileGlob(pattern, caseSensitive)
    // 满了就整个丢掉重来 —— LRU 在这里不值那几行代码
    if (CACHE.size >= CACHE_MAX) CACHE.clear()
    CACHE.set(key, re)
  }
  return re.test(normalizeGlobPath(path))
}
