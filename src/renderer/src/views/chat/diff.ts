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

/** 高亮占比超过这个数,就说明「几乎整行都变了」。 */
const SATURATED = 0.8

/**
 * 一侧几乎全是高亮时抹平它。
 *
 * 配对的两行有时其实毫不相干(LCS 只是按位置把它们凑成了一对),逐词 diff 会
 * 把整行几乎全标上 —— 那和整行高亮一样没有信息量,还会盖住行底色。
 */
function unlitIfSaturated(spans: DiffSpan[]): DiffSpan[] {
  const total = spans.reduce((n, s) => n + s.text.length, 0)
  if (total === 0) return spans
  const lit = spans.reduce((n, s) => (s.hi ? n + s.text.length : n), 0)
  return lit / total < SATURATED ? spans : whole(spans.map((s) => s.text).join(''))
}

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

    // ★ 只有增删行数**相等**时才逐行配对做词级 diff。
    //
    // 一删九增这种块(把一行展开成一整段),拿第一条删去和第一条增凑对纯属
    // 位置巧合,标出来的「差异」没有意义。此时整行就是改动本身,行底色已经
    // 说清楚了 —— 再叠一层词级高亮只会把整行糊成一块实心底,反而看不出改了哪。
    if (dels.length === adds.length) {
      for (let p = 0; p < dels.length; p++) {
        const { del, add } = wordSpans(dels[p]!, adds[p]!)
        rows.push({ type: 'del', spans: unlitIfSaturated(del) })
        rows.push({ type: 'add', spans: unlitIfSaturated(add) })
      }
    } else {
      for (const d of dels) rows.push({ type: 'del', spans: whole(d) })
      for (const a of adds) rows.push({ type: 'add', spans: whole(a) })
    }
  }
  return rows
}
