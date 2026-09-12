import type { Element, Root, RootContent } from 'hast'
import { markdownHeadingId } from './links'

export function textOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node && Array.isArray(node.children)) return node.children.map(textOf).join('')
  return ''
}

/** A fresh AST pass avoids mutable slug counters inside React render functions. */
export function rehypeMarkdownIds({ prefix, mathErrorLabel }: { prefix: string; mathErrorLabel: string }): (tree: Root) => void {
  return (tree) => {
    const counts = new Map<string, number>()
    const reserved = new Set<string>([`${prefix}footnote-label`])
    const reserve = (node: Root | RootContent): void => {
      if (node.type === 'element' && typeof node.properties.id === 'string') reserved.add(node.properties.id)
      if ('children' in node) node.children.forEach(reserve)
    }
    reserve(tree)
    const visit = (node: Root | RootContent): void => {
      if (node.type === 'element') {
        if (/^h[1-6]$/.test(node.tagName)) {
          if (node.properties.id === 'footnote-label') {
            node.properties.id = `${prefix}footnote-label`
          } else {
            const base = markdownHeadingId(textOf(node)).slice('markdown-'.length)
            let count = counts.get(base) ?? 0
            let id = `${prefix}${base}${count === 0 ? '' : `-${count}`}`
            while (reserved.has(id)) id = `${prefix}${base}-${++count}`
            counts.set(base, count + 1)
            reserved.add(id)
            node.properties.id = id
          }
        }
        if (node.properties.ariaDescribedBy?.includes('footnote-label')) {
          node.properties.ariaDescribedBy = [`${prefix}footnote-label`]
        }
        if (Array.isArray(node.properties.className) && node.properties.className.includes('katex-error')) {
          node.properties.title = mathErrorLabel
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

/**
 * The marker `rehypeStreamingFence` leaves on a `<pre>` whose fence has not closed yet.
 * `MarkdownPre` 只读它、不透传,所以它不会出现在 DOM 里。
 */
export const STREAMING_FENCE = 'data-ncw-streaming'

/** CommonMark already accepts unfinished fences. Rich renderers wait for the closing fence. */
function hasOpenFence(node: Element, source: string, scoped: boolean): boolean {
  if (!node.position) return false
  const start = node.position.start.offset ?? 0
  const end = node.position.end.offset ?? source.length
  const raw = source.slice(start, end)
  const lines = raw.split(/\r?\n/)
  const opening = /^(?:`{3,}|~{3,})/.exec((lines[0] ?? '').trimStart())?.[0]
  // 缩进代码块没有围栏,只能靠「是不是文档最后一个块」推断还在接收中。块作用域下
  // 这个推断恒真(每个块都结束于自己的末尾),会把已完成的缩进代码块误判成流式。
  if (!opening) return !scoped && end >= source.trimEnd().length
  if (lines.length > 1) {
    // The AST span starts at the fence, but nested closing lines retain quote indentation.
    const last = lines.at(-1)!.replace(/^(?:\s*>\s*)+/, '').trim()
    if (last.length >= opening.length && [...last].every((char) => char === opening[0])) return false
  }
  return true
}

/**
 * 围栏是否闭合必须在 rehype 阶段判定,不能在 React 组件里拿整篇原文去切:
 * Streamdown 按顶层块独立解析,hast 的 `position.offset` 是**块内相对**的,
 * 用它去切整篇文档会取到别的块。插件里取 `file.value` 才总能拿到与 offset
 * 同坐标系的源串 —— ReactMarkdown 下是全文,Streamdown 下是该块的内容。
 *
 * `scoped` 即「source 是单个块而非整篇」,两个选项在一次流式过程中都不变,
 * 因此不会让 Streamdown 的块缓存失效。
 */
export function rehypeStreamingFence({ streaming, scoped }: { streaming: boolean; scoped: boolean }): (tree: Root, file: unknown) => void {
  return (tree, file) => {
    if (!streaming) return
    const source = String(file)
    const visit = (node: Root | RootContent): void => {
      if (node.type === 'element' && node.tagName === 'pre' && hasOpenFence(node, source, scoped)) {
        node.properties[STREAMING_FENCE] = true
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}
