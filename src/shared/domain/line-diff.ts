/**
 * 通用 LCS 与「按行数增删计数」—— 主进程封包改动集时算 `+X −Y`,渲染层的
 * `views/chat/diff.ts` 也复用同一份 LCS,避免两处 diff 口径漂移。
 *
 * 纯函数、零依赖(不碰 electron / DOM),所以放 shared,main 与 renderer 都能 import。
 */

export type LcsTag = 'eq' | 'del' | 'add'
export interface LcsOp<T> {
  tag: LcsTag
  a?: T
  b?: T
}

/** 通用 LCS 回溯:返回把 a 变成 b 的对齐操作序列。 */
export function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): LcsOp<T>[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const di = dp[i]!
    const di1 = dp[i + 1]!
    const ai = a[i]!
    for (let j = m - 1; j >= 0; j--) {
      di[j] = eq(ai, b[j]!) ? di1[j + 1]! + 1 : Math.max(di1[j]!, di[j + 1]!)
    }
  }
  const ops: LcsOp<T>[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = a[i]!
    const bj = b[j]!
    if (eq(ai, bj)) {
      ops.push({ tag: 'eq', a: ai, b: bj })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ tag: 'del', a: ai })
      i++
    } else {
      ops.push({ tag: 'add', b: bj })
      j++
    }
  }
  while (i < n) ops.push({ tag: 'del', a: a[i++]! })
  while (j < m) ops.push({ tag: 'add', b: b[j++]! })
  return ops
}

/**
 * 两段文本的行级增删计数 —— 卡片上的 `+X −Y`。
 *
 * before 为 null 表示新建文件(所有行都算新增);after 为 null 表示删除(所有行都算删除)。
 * 末尾空行不参与计数(`''.split('\n')` 会给出一个空串,统一剔掉尾随空行的干扰)。
 */
export function countLineDiff(before: string | null, after: string | null): { additions: number; deletions: number } {
  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  if (before === null) return { additions: afterLines.length, deletions: 0 }
  if (after === null) return { additions: 0, deletions: beforeLines.length }
  let additions = 0
  let deletions = 0
  for (const op of lcsOps(beforeLines, afterLines, (x, y) => x === y)) {
    if (op.tag === 'add') additions++
    else if (op.tag === 'del') deletions++
  }
  return { additions, deletions }
}

/** 空文件 → 0 行;否则按 \n 切分并剔除唯一的尾随空行。 */
function toLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
