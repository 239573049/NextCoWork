/// <reference lib="dom" />
/*
 * The fixed page-side program used by both browser backends.
 *
 * It deliberately builds a new ref table for every observation. A navigation destroys the
 * isolated world; a second state-changing action consumes the host-side snapshot id. Together
 * those two boundaries make a stale ref fail instead of clicking whatever now occupies its old
 * coordinates.
 */

interface PageSnapshotValue {
  tree: string
  title: string
  url: string
  snapshotId: string
  viewport: { width: number; height: number }
}

function collectBrowserSnapshot(snapshotId: string): PageSnapshotValue {
  type BrowserState = { snapshotId: string; refs: Map<string, Element> }
  const root = globalThis as typeof globalThis & { __ncwBrowserState?: BrowserState }
  const refs = new Map<string, Element>()
  root.__ncwBrowserState = { snapshotId, refs }

  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/u)[0]
    if (explicit !== undefined && explicit !== '') return explicit
    const tag = element.tagName.toLowerCase()
    if (/^h[1-6]$/u.test(tag)) return 'heading'
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox'
    if (tag === 'option') return 'option'
    if (tag === 'img') return 'img'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'aside') return 'complementary'
    if (tag === 'header') return 'banner'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'form') return 'form'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'th') return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'hidden') return null
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    if (element.getAttribute('contenteditable') === 'true') return 'textbox'
    return null
  }

  const directText = (element: Element): string => Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()

  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const labelledBy = (element: Element): string => {
    const ids = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/u).filter(Boolean)
    return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/gu, ' ').trim()
  }

  const accessibleName = (element: Element, role: string): string => {
    const ariaLabel = element.getAttribute('aria-label')?.trim()
    if (ariaLabel !== undefined && ariaLabel !== '') return ariaLabel
    const by = labelledBy(element)
    if (by !== '') return by
    if (element instanceof HTMLInputElement && element.labels !== null && element.labels.length > 0) {
      const label = Array.from(element.labels).map((item) => item.textContent ?? '').join(' ').replace(/\s+/gu, ' ').trim()
      if (label !== '') return label
    }
    const alt = element.getAttribute('alt')?.trim()
    if (alt !== undefined && alt !== '') return alt
    if (role === 'button' && element instanceof HTMLInputElement && element.value !== '') return element.value
    const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
    if (text !== '') return text.slice(0, 500)
    const title = element.getAttribute('title')?.trim()
    if (title !== undefined && title !== '') return title
    const placeholder = element.getAttribute('placeholder')?.trim()
    return placeholder ?? ''
  }

  const candidates: Array<{ element: Element; role: string; name: string }> = []
  const elements = Array.from(document.body?.querySelectorAll('*') ?? [])
  for (const element of elements) {
    if (candidates.length >= 5000) break
    if (!visible(element)) continue
    let role = roleOf(element)
    const ownText = directText(element)
    const focusable = element instanceof HTMLElement && element.tabIndex >= 0
    if (role === null && (ownText !== '' || focusable)) role = focusable ? 'generic' : 'text'
    if (role === null) continue
    const name = accessibleName(element, role)
    if (role === 'text' && ownText === '') continue
    candidates.push({ element, role, name: role === 'text' ? ownText : name })
  }

  const included = new Set(candidates.map((candidate) => candidate.element))
  const lines: string[] = []
  for (const [index, candidate] of candidates.entries()) {
    const ref = `e${String(index + 1)}`
    refs.set(ref, candidate.element)
    let depth = 0
    let parent = candidate.element.parentElement
    while (parent !== null) {
      if (included.has(parent)) depth++
      parent = parent.parentElement
    }
    const attrs: string[] = [`ref=${ref}`]
    if (candidate.role === 'heading') attrs.push(`level=${candidate.element.tagName.slice(1)}`)
    if (candidate.element.getAttribute('aria-expanded') !== null) attrs.push(`expanded=${candidate.element.getAttribute('aria-expanded')}`)
    if (candidate.element.getAttribute('aria-pressed') !== null) attrs.push(`pressed=${candidate.element.getAttribute('aria-pressed')}`)
    if (candidate.element instanceof HTMLInputElement || candidate.element instanceof HTMLTextAreaElement || candidate.element instanceof HTMLSelectElement) {
      if (!(candidate.element instanceof HTMLInputElement && candidate.element.type === 'password')) {
        attrs.push(`value=${JSON.stringify(candidate.element.value.slice(0, 500))}`)
      }
      if (candidate.element.disabled) attrs.push('disabled=true')
      if (candidate.element instanceof HTMLInputElement && (candidate.element.type === 'checkbox' || candidate.element.type === 'radio')) {
        attrs.push(`checked=${String(candidate.element.checked)}`)
      }
      const placeholder = candidate.element.getAttribute('placeholder')
      if (placeholder !== null && placeholder !== '') attrs.push(`placeholder=${JSON.stringify(placeholder)}`)
    }
    if (candidate.element instanceof HTMLOptionElement && candidate.element.selected) attrs.push('selected=true')
    const name = candidate.name === '' ? '' : ` ${JSON.stringify(candidate.name)}`
    lines.push(`${'  '.repeat(Math.min(depth, 12))}- ${candidate.role}${name} [${attrs.join(' ')}]`)
  }

  return {
    tree: lines.join('\n'),
    title: document.title,
    url: location.href,
    snapshotId,
    viewport: {
      width: Math.max(0, Math.round(globalThis.innerWidth)),
      height: Math.max(0, Math.round(globalThis.innerHeight))
    }
  }
}

export function browserSnapshotExpression(snapshotId: string): string {
  return `(${collectBrowserSnapshot.toString()})(${JSON.stringify(snapshotId)})`
}
