/**
 * `git status --porcelain=v2 -z` 的解析 —— 从 `ipc/git.ts` 抽出来的纯函数。
 *
 * 需求:分组「暂存区 / 未暂存」是整个 Git 面板唯一的结构,而它完全由这里算出的
 * `staged` / `unstaged` 决定。抽成独立模块是为了能直接喂字符串跑断言 ——
 * 留在 `ipc/git.ts` 里就得连 `state/store`、`runtime` 一起拖进测试进程(它们要 electron),
 * 于是这段最容易错的解析反而是唯一没被测到的。
 *
 * ★ **v2 的「这一栏没有改动」是 `.`,不是空格。** v1(`--porcelain`)用空格,v2 换成了
 *   点号,两者只差一个字符,肉眼看输出几乎分辨不出。判成空格的表现是:**每一个已暂存
 *   的文件同时出现在「未暂存」分组里**(XY=`M.` 的 Y 位不等于空格),列表里 109 个
 *   改动显示成 109+109,而点「暂存」按钮等于对一个已暂存文件再 `git add` 一次 ——
 *   界面纹丝不动,像是暂存功能坏了。两位都按 `.` 和空格一起判,是因为
 *   `u`(冲突)记录的 XY 里确实只会出现字母。
 */
import type { GitFileChange } from '../../shared/domain/git'

/** 改动文件列表的上限。一个 .gitignore 写漏的仓库能有几十万条。 */
export const MAX_FILES = 2000

export interface StatusSnapshot {
  branch: string
  detached: boolean
  unborn: boolean
  upstream: string
  ahead: number
  behind: number
  files: GitFileChange[]
  filesTruncated: boolean
}

/** porcelain v2 里「这一栏没有改动」的两种写法。见文件头 ★。 */
function unchanged(letter: string): boolean {
  return letter === '.' || letter === ' ' || letter === ''
}

/**
 * ★ 用 `--porcelain=v2 --branch -z` 而不是 v1。
 *
 * 一次调用同时拿到:分支名、上游、ahead/behind、以及文件列表。v1 要另外发三条
 * (`branch --show-current` / `rev-parse @{u}` / `rev-list --count`),而 `@{u}`
 * 在没设上游时退出码非零,又得分辨「没上游」和「命令坏了」。
 *
 * ★ `-z` 是为了中文和带空格的文件名:非 -z 的输出会把这类路径加引号并转义,
 * 解析端必须自己反转义 —— 解析错的表现是文件点不开,而且**只在中文路径上**出现。
 */
export function parseStatus(stdout: string): StatusSnapshot {
  // -z:每条记录以 NUL 结尾(不是分隔),末尾会留一个空串
  const records = stdout.split('\0')
  let branch = ''
  let detached = false
  let unborn = false
  let upstream = ''
  let ahead = 0
  let behind = 0
  const files: GitFileChange[] = []
  let filesTruncated = false

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined || record === '') continue

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      // `(initial)` = 还没有第一个提交
      if (key === 'branch.oid') unborn = value === '(initial)'
      else if (key === 'branch.head') {
        // `(detached)` 是 git 的字面输出,不是一个真的分支名
        if (value === '(detached)') detached = true
        else branch = value
      } else if (key === 'branch.upstream') upstream = value
      else if (key === 'branch.ab') {
        // 形如 `+1 -2`
        const [a, b] = value.split(' ')
        ahead = Number.parseInt((a ?? '').replace('+', ''), 10) || 0
        behind = Math.abs(Number.parseInt(b ?? '', 10) || 0)
      }
      continue
    }

    if (files.length >= MAX_FILES) {
      filesTruncated = true
      // 仍然继续扫,只是不再收 —— rename 记录要吃掉它后面那条来源路径
      if (record.startsWith('2 ')) i++
      continue
    }

    const kind = record[0]
    if (kind === '1' || kind === '2') {
      /*
        1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
        —— 固定字段都不含空格,路径可能含,所以按 slice(n).join(' ') 收尾。
        ★ -z 模式下 rename 的**来源路径是下一条记录**,不是同一条里的 tab 分隔。
          少读这一条,后面每一条记录的类型判断都会错位一格。
      */
      const parts = record.split(' ')
      const xy = parts[1] ?? '  '
      const fixed = kind === '1' ? 8 : 9
      const path = parts.slice(fixed).join(' ')
      let renamedFrom: string | undefined
      if (kind === '2') {
        i++
        const from = records[i]
        if (from !== undefined && from !== '') renamedFrom = from
      }
      if (path === '') continue
      files.push(change(path, xy[0] ?? ' ', xy[1] ?? ' ', false, renamedFrom))
    } else if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = record.split(' ')
      const xy = parts[1] ?? '  '
      const path = parts.slice(10).join(' ')
      if (path === '') continue
      files.push(change(path, xy[0] ?? ' ', xy[1] ?? ' ', false))
    } else if (kind === '?') {
      const path = record.slice(2)
      if (path === '') continue
      files.push(change(path, '?', '?', true))
    }
    // `!`(ignored)不会出现 —— 我们没传 --ignored
  }

  return { branch, detached, unborn, upstream, ahead, behind, files, filesTruncated }
}

export function change(
  path: string,
  index: string,
  worktree: string,
  untracked: boolean,
  renamedFrom?: string
): GitFileChange {
  /*
    ★ 冲突的判据是 `U`,外加 `AA`(双方都新增)和 `DD`(双方都删除)——
    后两种 XY 里一个 U 都没有,只看 U 会把它们当成普通改动给出暂存按钮。
  */
  const conflicted =
    index === 'U' ||
    worktree === 'U' ||
    (index === 'A' && worktree === 'A') ||
    (index === 'D' && worktree === 'D')
  return {
    path,
    renamedFrom,
    index,
    worktree,
    staged: !untracked && !conflicted && !unchanged(index) && index !== '?',
    unstaged: !untracked && !conflicted && !unchanged(worktree) && worktree !== '?',
    untracked,
    conflicted
  }
}
