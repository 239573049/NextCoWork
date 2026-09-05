export type MarkdownTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; fragment: string }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'blocked' }

/** Only workspace-relative paths are passed to the host, which also checks real paths. */
export function resolveMarkdownTarget(documentPath: string, reference: string, workspaceRoot?: string): MarkdownTarget {
  const raw = reference.trim()
  if (!raw || /\p{Cc}/u.test(raw)) return { kind: 'blocked' }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (!url.hostname || url.username || url.password) return { kind: 'blocked' }
      return { kind: 'external', url: url.href }
    } catch { return { kind: 'blocked' } }
  }

  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return { kind: 'blocked' } }
  if (/\p{Cc}/u.test(decoded) || decoded.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    return { kind: 'blocked' }
  }

  // Split before decoding so escaped '#' and '?' remain valid filename characters.
  const hashAt = raw.indexOf('#')
  const fragment = hashAt < 0 ? '' : decodeURIComponent(raw.slice(hashAt + 1))
  const withoutFragment = hashAt < 0 ? raw : raw.slice(0, hashAt)
  const queryAt = withoutFragment.indexOf('?')
  let pathname = decodeURIComponent(queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt))
  if (!pathname) return { kind: 'anchor', fragment }
  let parts = documentPath.split('/').slice(0, -1)
  if (pathname.startsWith('/')) {
    const root = workspaceRoot?.replace(/\/+$/, '')
    if (!root || !pathname.startsWith(`${root}/`)) return { kind: 'blocked' }
    pathname = pathname.slice(root.length + 1)
    parts = []
  }
  for (const part of pathname.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (parts.length === 0) return { kind: 'blocked' }
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  if (parts.length === 0) return { kind: 'blocked' }
  const path = parts.join('/')
  return path === documentPath ? { kind: 'anchor', fragment } : { kind: 'file', path, fragment }
}

export function markdownHeadingId(text: string): string {
  return `markdown-${text.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-')}`
}
