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

/** CommonMark already accepts unfinished fences. Rich renderers wait for the closing fence. */
export function isCodeStreaming(node: Element | undefined, source: string, streaming: boolean): boolean {
  if (!streaming || !node?.position) return false
  const start = node.position.start.offset ?? 0
  const end = node.position.end.offset ?? source.length
  const raw = source.slice(start, end)
  const lines = raw.split(/\r?\n/)
  const opening = /^(?:`{3,}|~{3,})/.exec((lines[0] ?? '').trimStart())?.[0]
  if (!opening) return end >= source.trimEnd().length
  if (lines.length > 1) {
    // The AST span starts at the fence, but nested closing lines retain quote indentation.
    const last = lines.at(-1)!.replace(/^(?:\s*>\s*)+/, '').trim()
    if (last.length >= opening.length && [...last].every((char) => char === opening[0])) return false
  }
  return true
}
