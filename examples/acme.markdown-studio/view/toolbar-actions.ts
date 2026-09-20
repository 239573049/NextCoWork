/**
 * 工具栏动作 —— 对 CodeMirror 视图的一次事务 = 一次可撤销的编辑。
 *
 * ## 约定
 *
 * - 有选区时:**包裹/变换选区**;无选区:插入占位文本并把光标放进最有意义的位置
 *   (比如 `[链接文字](url)` 里选中「链接文字」)。
 * - 行级前缀(标题/引用/列表)作用于**所有被选行**,哪怕选区只落在一行中间 ——
 *   这是列表按钮的本意:「把这几行变成列表」,不是「在这个字符前插一个杠」。
 * - 不碰 undo 历史:每个动作恰好一个 transaction,CM 原生撤销一步一个。
 */
import type { EditorView } from '@codemirror/view'

function replaceRange(view: EditorView, from: number, to: number, insert: string, select?: { from: number; to: number }): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: select === undefined ? undefined : { anchor: select.from, head: select.to },
    scrollIntoView: true
  })
  view.focus()
}

/** 行内包裹:`**bold**`、`` `code` ``、`$x$`…… */
export function wrapSelection(view: EditorView, marker: string, placeholder: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const text = selected === '' ? placeholder : selected
  const insert = `${marker}${text}${marker}`
  replaceRange(view, from, to, insert, { from: from + marker.length, to: from + marker.length + text.length })
}

/** 链接/图片:选区当文字,光标落在 url 上等着输入。 */
export function insertLink(view: EditorView, image: boolean): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const text = selected === '' ? (image ? 'alt' : 'link') : selected
  const prefix = image ? '![' : '['
  const insert = `${prefix}${text}](url)`
  const urlStart = from + prefix.length + text.length + 2
  replaceRange(view, from, to, insert, { from: urlStart, to: urlStart + 3 })
}

/**
 * 行级前缀切换。`match` 识别「这行已是什么前缀」(用于摘除),
 * `build(i)` 给出第 i 行(0 基,连选时用于有序列表编号)的新前缀。
 *
 * 语义:被选的行**全部**已带前缀 → 再点一次整体摘除;否则统一加上/替换。
 */
export function toggleLinePrefix(
  view: EditorView,
  match: (line: string) => string | null,
  build: (index: number) => string
): void {
  const { state } = view
  const { from, to } = state.selection.main
  const firstLine = state.doc.lineAt(from)
  const lastLine = state.doc.lineAt(to)
  const lines: string[] = []
  for (let n = firstLine.number; n <= lastLine.number; n += 1) lines.push(state.doc.line(n).text)
  // 空行视同「无前缀」,让「把一段中间的空行一起选上再点列表」也不至于摘不掉
  const allPrefixed = lines.every((text) => match(text) !== null || text.trim() === '')

  const changes: { from: number; to?: number; insert: string }[] = []
  let index = 0
  for (let n = firstLine.number; n <= lastLine.number; n += 1) {
    const line = state.doc.line(n)
    const existing = match(line.text) ?? ''
    const indentLen = line.text.length - line.text.trimStart().length
    const at = line.from + indentLen
    if (allPrefixed) {
      if (existing !== '') changes.push({ from: at, to: at + existing.length, insert: '' })
    } else {
      changes.push({ from: at, to: at + existing.length, insert: build(index) })
    }
    index += 1
  }
  view.dispatch({ changes, scrollIntoView: true })
  view.focus()
}

/** 在光标所在块的下方插入一段模板(表格/代码块/分割线等)。 */
export function insertBlock(view: EditorView, template: string, cursorOffset?: number): void {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.to)
  // 当前行非空 → 先空一行再插模板;空行/文档末尾 → 直接插
  const prefix = line.text.trim() === '' ? '' : '\n\n'
  const insert = `${prefix}${template}`
  const at = line.to
  const cursor = at + (cursorOffset === undefined ? insert.length : prefix.length + cursorOffset)
  view.dispatch({
    changes: { from: at, to: at, insert },
    selection: { anchor: cursor },
    scrollIntoView: true
  })
  view.focus()
}

export const TEMPLATES = {
  codeBlock: '```js\n\n```\n',
  codeBlockCursor: 7,
  table: '| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n',
  hr: '---\n',
  mathBlock: '$$\nE = mc^2\n$$\n',
  mermaid: '```mermaid\ngraph TD\n  A --> B\n  B --> C\n```\n',
  taskItem: '- [ ] '
} as const
