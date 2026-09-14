/**
 * Edit 工具的行内 diff —— 把 `old_string` / `new_string` 算成一份统一 diff,
 * 顺带在**改动的那一对行**里做词级高亮,好让用户一眼看清究竟动了哪几个字。
 *
 * 为什么自己写而不引库:仓库没有 diff 依赖(见 package.json),而 Edit 的两段
 * 文本都是**一次替换的片段**,通常几行到几十行,O(n·m) 的 LCS 完全够用,
 * 不值得为它拉一个 diff-match-patch 进来。纯函数,便于单测。
 */

export type DiffRowType = 'context' | 'del' | 'add'

/** 一行里的一段文本;`hi` 表示这一段相对另一侧是新增/删除的(词级高亮)。 */
export interface DiffSpan {
  text: string
  hi: boolean
}

export interface DiffRow {
  type: DiffRowType
  spans: DiffSpan[]
}

/** 通用 LCS 回溯:返回对齐后的操作序列。 */
type Op<T> = { tag: 'eq' | 'del' | 'add'; a?: T; b?: T }

function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Op<T>[] {
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
  const ops: Op<T>[] = []
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
 * 词级切分:词、空白、单个符号各成一 token。
 * 保留空白是为了让高亮不吞掉缩进,重组后能还原原文。
 */
function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]/g) ?? []
}

/** 对一对「删除行 / 新增行」做词级 diff,产出各自侧的高亮 span。 */
function wordSpans(
  oldLine: string,
  newLine: string
): {
  del: DiffSpan[]
  add: DiffSpan[]
} {
  const ops = lcsOps(tokenize(oldLine), tokenize(newLine), (x, y) => x === y)
  const del: DiffSpan[] = []
  const add: DiffSpan[] = []
  for (const op of ops) {
    if (op.tag === 'eq') {
      pushSpan(del, op.a as string, false)
      pushSpan(add, op.b as string, false)
    } else if (op.tag === 'del') {
      pushSpan(del, op.a as string, true)
    } else {
      pushSpan(add, op.b as string, true)
    }
  }
  return { del, add }
}

/** 合并同 `hi` 的相邻 span,减少 DOM 节点。 */
function pushSpan(spans: DiffSpan[], text: string, hi: boolean): void {
  const last = spans[spans.length - 1]
  if (last !== undefined && last.hi === hi) last.text += text
  else spans.push({ text, hi })
}

const whole = (text: string): DiffSpan[] => [{ text, hi: false }]

/**
 * 计算 `oldStr → newStr` 的统一 diff 行序列。
 *
 * 连续的「删除段 + 新增段」若一一对应(同样多行,或对应位置),会两两做词级
 * 高亮;数量不等时,能配上的配对,配不上的整行标为改动。
 */
export function computeDiff(oldStr: string, newStr: string): DiffRow[] {
  const ops = lcsOps(oldStr.split('\n'), newStr.split('\n'), (x, y) => x === y)
  const rows: DiffRow[] = []
  let k = 0
  while (k < ops.length) {
    const op = ops[k]!
    if (op.tag === 'eq') {
      rows.push({ type: 'context', spans: whole(op.a as string) })
      k++
      continue
    }
    // 收集一个连续的改动块:先 del 后 add(LCS 回溯天然是这个顺序)
    const dels: string[] = []
    const adds: string[] = []
    while (k < ops.length && ops[k]!.tag === 'del') dels.push(ops[k++]!.a as string)
    while (k < ops.length && ops[k]!.tag === 'add') adds.push(ops[k++]!.b as string)

    const pairs = Math.min(dels.length, adds.length)
    for (let p = 0; p < pairs; p++) {
      const { del, add } = wordSpans(dels[p]!, adds[p]!)
      rows.push({ type: 'del', spans: del })
      rows.push({ type: 'add', spans: add })
    }
    for (let p = pairs; p < dels.length; p++)
      rows.push({ type: 'del', spans: [{ text: dels[p]!, hi: true }] })
    for (let p = pairs; p < adds.length; p++)
      rows.push({ type: 'add', spans: [{ text: adds[p]!, hi: true }] })
  }
  return rows
}
