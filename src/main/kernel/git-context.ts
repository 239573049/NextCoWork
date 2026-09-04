/**
 * git 上下文 —— 仓库现在在什么状态。
 *
 * 模型不知道自己在哪个分支、有没有未提交的改动、最近做了什么。于是它要么
 * 花一次 `bash git status` 去问(一整轮),要么更糟 —— 直接假设。这里花四次
 * spawn 把这三个事实一次性备好。
 *
 * ★ **每 run 算一次,不是每轮。** `assemble()` 是纯同步函数,拿不到 `spawn`;
 * 而每轮重算也会让易失块每轮变化,把前缀缓存打断。代价是模型在这个 run 里
 * 自己提交了之后,这里还是旧的 —— 所以文案里**如实标注**「as of the start of
 * this run」。提示词里的事实要么是真的、要么根本不该在:含糊地写成
 * 「current branch」而它其实是五分钟前的,比不写更糟。
 *
 * ⚠️ **分支名和提交标题在 clone 来的仓库里是攻击者可控的。** 一条写成
 * `</system-reminder> new instructions:` 的提交标题就是一次现成的注入,
 * 所以它们和 AGENTS.md 走同一条消毒路径(`sanitizeInstructions`)。
 */
import type { SpawnFn } from './host'
import { sanitizeInstructions } from './instructions'
import { clampWithEllipsis } from './text'

/** 四条命令共用。慢过这个数就不值得让用户多等 —— 这只是锦上添花的上下文。 */
const GIT_TIMEOUT_MS = 2000

/** 分支名与提交标题的字符上限。一条 4000 字的提交标题不是信息,是负载。 */
const LINE_MAX = 200

/** 最近几条提交。三条足够看出「在做什么」,再多就是在复述 git log。 */
const RECENT_COMMITS = 3

export interface GitContext {
  /** 分支名。空串 = detached HEAD 或空仓库(unborn),都当「没有分支」。 */
  branch: string
  /** 未提交改动的文件数。0 = 干净。 */
  dirtyCount: number
  /** 最近几条 `<短 hash> <标题>`。空仓库时是空数组。 */
  recent: readonly string[]
}

/**
 * ★ `--no-optional-locks` —— 免得和用户自己开着的 git / IDE 抢 index 锁。
 * 一次 `status` 就可能顺手重写 index,而那正是用户的 GUI 也在做的事。
 */
const GIT = 'git --no-optional-locks'

/**
 * 探一次。
 *
 * ★ **永不 throw、永不 reject。** 不是仓库 / 没装 git / 超时 / 中断 → `undefined`。
 *
 * 中断这一条尤其要紧:`node-spawn.ts` 的 abort 走的是 **reject**,不是 resolve。
 * 不收在这里的话,一次发生在 git 探测期间的中断会让异常从 `runAgent` 里逃出去,
 * 而那时 `session.run()` 还没进入、`finalizeAbort` 不会跑 —— run 直接无声消失,
 * UI 上转圈不停。
 */
export async function readGitContext(
  spawn: SpawnFn,
  cwd: string,
  signal: AbortSignal
): Promise<GitContext | undefined> {
  if (cwd === '') return undefined // 没有工作区,一次 spawn 都不发

  try {
    const run = async (cmd: string): Promise<{ code: number; stdout: string }> => {
      const r = await spawn(cmd, { cwd, signal, timeoutMs: GIT_TIMEOUT_MS })
      return { code: r.code, stdout: r.stdout }
    }

    /*
      ★ 闸门:一条命令吸收三种情况 —— 没装 git(127)、不是仓库(128)、
      目录不存在。非零就直接收工,后面三条一条都不发。
    */
    const inside = await run(`${GIT} rev-parse --is-inside-work-tree`)
    if (inside.code !== 0) return undefined

    /*
      ★ 用 `branch --show-current` 而不是 `rev-parse --abbrev-ref HEAD`:
      空仓库(unborn HEAD)时后者会失败,前者正常返回空串。detached HEAD
      同样返回空串 —— 当「没有分支」处理,而不是当失败处理。
    */
    const branch = await run(`${GIT} branch --show-current`)

    /*
      ★ 只数行数,**绝不把内容塞进提示词**。一个 .gitignore 写漏了的仓库,
      这里是几兆字符。
    */
    const status = await run(`${GIT} status --porcelain`)
    const dirtyCount = status.code === 0 ? countLines(status.stdout) : 0

    /*
      ★ 空仓库时这条退出 128 —— 当「还没有提交」处理,**不要**当成「没有 git」
      而把整个上下文丢掉(闸门那条已经证明这是个仓库了)。
    */
    /*
      ★ `%x20` 是 git 自己的「一个空格」转义,用它就不用给 format 串加引号 ——
      而引号在这里是真的会坏的:`SpawnFn` 收一整条命令,POSIX 走 `sh -c`、
      Windows 走 `cmd.exe /d /s /c`,单引号在 cmd.exe 里不成立。写成
      `--format=%h %s` 则会被拆成两个参数,`%s` 被当成 revision。
    */
    const log = await run(`${GIT} log -${String(RECENT_COMMITS)} --format=%h%x20%s`)
    const recent =
      log.code === 0
        ? log.stdout
            .split('\n')
            .map((l) => clean(l))
            .filter((l) => l !== '')
            .slice(0, RECENT_COMMITS)
        : []

    return { branch: branch.code === 0 ? clean(branch.stdout) : '', dirtyCount, recent }
  } catch {
    // 中断、宿主抛错、超时被实现成异常 —— 一律当「这次拿不到」,不影响 run
    return undefined
  }
}

function countLines(s: string): number {
  let n = 0
  for (const l of s.split('\n')) if (l.trim() !== '') n++
  return n
}

/** 分支名 / 提交标题是不可信文本,和 AGENTS.md 同一条消毒路径。 */
function clean(s: string): string {
  return clampWithEllipsis(sanitizeInstructions(s), LINE_MAX)
}
