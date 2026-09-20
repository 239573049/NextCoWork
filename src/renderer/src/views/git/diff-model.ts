/**
 * 统一 diff 文本 → 可渲染的行模型。
 *
 * 需求:右栏原本把 `git diff` 的原文整段按首字符上色铺出来,于是用户要在
 * `diff --git` / `index 26282a78..2b278cb8` / `--- a/…` / `+++ b/…` 这四行噪音里
 * 自己找改动,而且**没有行号** —— 想知道「这段改在第几行」只能回编辑器数。
 * 这里把原文拆成带行号的行模型,让组件只管画。
 *
 * 不变式:`rows` 的顺序就是原文顺序,一行都不重排。diff 的价值在于上下文相邻,
 * 排序/折叠/合并同类项都会让它不再是那份 git 生成的东西。
 *
 * 故意不做的事:
 * - **不做左右分栏(side-by-side)**。这一栏最窄时只有几百像素(左栏 340px 是固定的),
 *   劈成两半之后每一半都要横向滚动,比单栏更难读。
 * - **不做语法高亮**。那需要按扩展名挑 grammar 并在渲染时跑一遍 —— 而 diff 是
 *   选中文件时同步渲染的,见 `DIFF_LINE_LIMIT` 上那条「大 diff 能卡住半秒」。
 *
 * ★ **`---` / `+++` 只在 hunk 之外才是文件头。** 一行被删掉的正文如果本身以 `--`
 *   开头(Markdown 的分隔线、C 的注释、`--flag` 的文档),它在 diff 里就长成 `---…`。
 *   按前缀无条件当文件头丢掉的表现是:**删掉一条分隔线的改动在界面上凭空消失**,
 *   而且后面所有行的行号都往前串一位。所以这里靠 `@@` 维护 inHunk 状态来判。
 */

export type DiffRowKind =
  /** `@@ -a,b +c,d @@` 那一行 */
  | 'hunk'
  /** 文件头里值得留的那几行(new file mode / rename from…)、`\ No newline at end of file` */
  | 'meta'
  | 'add'
  | 'del'
  | 'context'

export interface DiffRow {
  kind: DiffRowKind
  /** 正文。add/del/context 已去掉前导的 `+` / `-` / 空格 */
  text: string
  /** 旧文件里的行号。新增行没有 */
  oldLine: number | null
  /** 新文件里的行号。删除行没有 */
  newLine: number | null
}

export interface ParsedDiff {
  rows: DiffRow[]
  /** 新增 / 删除的行数。统计覆盖**整份** diff,即使 `rows` 被 limit 截断了 */
  added: number
  removed: number
  /** 截断前本该有多少行(用于「只显示了前 N 行」那句话) */
  total: number
}

/** 纯噪音的文件头。只在 hunk 之外成立,见文件头 ★。 */
const NOISE = ['diff --git ', 'index ', '--- ', '+++ ']

/**
 * `@@ -12,7 +12,9 @@` → 起始行号。`,count` 可以省略(表示 1 行)。
 * 尾部可能还跟着函数名(`@@ -1,2 +1,2 @@ function foo()`),不参与解析。
 */
const HUNK = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * @param limit 最多产出多少行 —— 超出的部分只统计不落 `rows`,理由见
 *              `GitFeature` 里的 `DIFF_LINE_LIMIT`。
 */
export function parseUnifiedDiff(text: string, limit: number): ParsedDiff {
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let total = 0
  let inHunk = false
  let oldLine = 0
  let newLine = 0

  const lines = text.split('\n')
  // git 的输出以换行结尾,split 之后末尾留一个空串 —— 它不是 diff 的一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    if (!inHunk && NOISE.some((prefix) => line.startsWith(prefix))) continue

    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      inHunk = true
      oldLine = Number.parseInt(hunk[1] ?? '1', 10)
      newLine = Number.parseInt(hunk[2] ?? '1', 10)
      total += 1
      if (rows.length < limit) rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null })
      continue
    }

    if (!inHunk) {
      // 文件头里剩下的:new file mode / deleted file mode / rename from / similarity index…
      if (line === '') continue
      total += 1
      if (rows.length < limit) rows.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
      continue
    }

    const mark = line[0]
    if (mark === '+') {
      added += 1
      total += 1
      if (rows.length < limit) {
        rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine })
      }
      newLine += 1
    } else if (mark === '-') {
      removed += 1
      total += 1
      if (rows.length < limit) {
        rows.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null })
      }
      oldLine += 1
    } else if (mark === '\\') {
      // `\ No newline at end of file` —— 不占任何一侧的行号
      total += 1
      if (rows.length < limit) rows.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
    } else {
      // 上下文行(前导空格)。空行在 diff 里也可能真的是空串,同样当上下文
      total += 1
      if (rows.length < limit) {
        rows.push({ kind: 'context', text: mark === ' ' ? line.slice(1) : line, oldLine, newLine })
      }
      oldLine += 1
      newLine += 1
    }
  }

  return { rows, added, removed, total }
}
