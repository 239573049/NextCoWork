/**
 * 活跃日的日历运算 —— 连续天数、日期序列、按周分组。
 *
 * 主进程算「连续天数」要用它,渲染层画热力图网格也要用它。放在 shared 是为了
 * 两边**共用同一套日期算术**:否则热力图上明明连着七个方块,指标卡却写着
 * 「连续 6 天」,而两个数字各自看都合理。
 *
 * ## 为什么全部换算成「UTC 纪元日序号」再算
 *
 * ★ 输入是本地日期字符串 `YYYY-MM-DD`,不带时刻。判断两天是否相邻,
 * **不能**拿两个本地时间戳相减除以 86400000 —— 夏令时切换那天只有 23 小时
 * (或 25 小时),相减得到 0.958 天,`=== 1` 不成立,连续天数就在那一天断掉。
 * 一年就错两次,而且只在有夏令时的时区错,本地怎么点都复现不了。
 *
 * 把 `YYYY-MM-DD` 当成 **UTC 午夜**解析,就得到一个纯粹的日历天序号:UTC 没有
 * 夏令时,相邻日期的序号必然差 1。这里只把它当整数用,从不当成某个真实时刻。
 */

/**
 * 毫秒 → **本地**日期 `YYYY-MM-DD`。与 SQLite `date(at/1000,'unixepoch','localtime')`
 * 同口径,汇总表的 `day` 列就是这么来的。
 *
 * ★ 这是本文件里唯一一个碰本地时区的函数,而且只在这一处碰:时间戳一旦变成
 * 日期字符串,后面全部是纯日历算术(见文件头)。主进程和渲染层都要把「今天」
 * 算成同一个字符串,所以它必须是共用的 —— 两边各写一遍,热力图最后一格和
 * 「当前连续天数」就有可能差一天。
 */
export function localDayOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DD` → UTC 纪元日序号。非法输入返回 `NaN`。 */
export function dayIndex(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return Number.NaN
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.floor(ms / 86400000)
}

/** UTC 纪元日序号 → `YYYY-MM-DD`。`dayIndex` 的逆运算。 */
export function dayFromIndex(index: number): string {
  const d = new Date(index * 86400000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 该日期是星期几(0 = 周日),用于热力图把方块对到正确的行。 */
export function weekdayOf(day: string): number {
  const index = dayIndex(day)
  if (Number.isNaN(index)) return 0
  // 1970-01-01 是周四 = 4
  return (((index + 4) % 7) + 7) % 7
}

/** 含两端的连续日期序列。`from > to` 时返回空数组。 */
export function dayRange(from: string, to: string): string[] {
  const start = dayIndex(from)
  const end = dayIndex(to)
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return []
  const days: string[] = []
  for (let i = start; i <= end; i++) days.push(dayFromIndex(i))
  return days
}

export interface Streaks {
  current: number
  longest: number
}

/**
 * 连续活跃天数。`days` 不要求有序或去重。
 *
 * ★ 「当前连续」以**今天或昨天**为终点都算数。只认今天的话,每天零点一过
 * 这个数字就掉到 0,直到当天第一次请求才恢复 —— 用户看到的是自己的连胜断了。
 * 昨天活跃就仍在延续,这与 GitHub 贡献图、各类打卡应用的通行口径一致。
 */
export function computeStreaks(days: readonly string[], today: string): Streaks {
  const indices = [...new Set(days.map(dayIndex).filter((n) => !Number.isNaN(n)))].sort(
    (a, b) => a - b
  )
  if (indices.length === 0) return { current: 0, longest: 0 }

  let longest = 1
  let run = 1
  for (let i = 1; i < indices.length; i++) {
    run = indices[i] === indices[i - 1]! + 1 ? run + 1 : 1
    if (run > longest) longest = run
  }

  const todayIndex = dayIndex(today)
  const last = indices[indices.length - 1]!
  let current = 0
  if (!Number.isNaN(todayIndex) && (last === todayIndex || last === todayIndex - 1)) {
    current = 1
    for (let i = indices.length - 1; i > 0; i--) {
      if (indices[i] !== indices[i - 1]! + 1) break
      current++
    }
  }

  return { current, longest }
}
