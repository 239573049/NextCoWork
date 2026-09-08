export type MarkdownTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; fragment: string }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'blocked' }

/**
 * A link resolves to a workspace-relative path when it stays inside the workspace, and to an
 * absolute path when it leaves. Both forms are accepted by the host, which resolves real paths.
 * Leaving the workspace needs `workspaceRoot`: without it there is no way to name the target.
 */
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
  // `//host/path` is a protocol-relative URL, not a path. It must never be read as an absolute path.
  if (decoded.startsWith('//')) return { kind: 'blocked' }

  // Split before decoding so escaped '#' and '?' remain valid filename characters.
  const hashAt = raw.indexOf('#')
  const fragment = hashAt < 0 ? '' : decodeURIComponent(raw.slice(hashAt + 1))
  const withoutFragment = hashAt < 0 ? raw : raw.slice(0, hashAt)
  const queryAt = withoutFragment.indexOf('?')
  let pathname = decodeURIComponent(queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt))
  if (!pathname) return { kind: 'anchor', fragment }
  const root = workspaceRoot?.replace(/\/+$/, '') ?? ''
  let absolute = documentPath.startsWith('/')
  let parts = documentPath.split('/').slice(0, -1).filter((part) => part !== '')
  if (pathname.startsWith('/')) {
    // Inside the workspace the key stays relative; anywhere else it stays absolute.
    if (root !== '' && pathname.startsWith(`${root}/`)) {
      pathname = pathname.slice(root.length + 1)
      absolute = false
    } else {
      absolute = true
    }
    parts = []
  }
  for (const part of pathname.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (parts.length > 0) {
        parts.pop()
        continue
      }
      // Climbed past the workspace root. Continuing means naming the target absolutely,
      // which is only possible when the caller told us where the root is.
      if (absolute || root === '') return { kind: 'blocked' }
      absolute = true
      parts = root.split('/').filter((segment) => segment !== '')
      parts.pop()
      if (parts.length === 0) return { kind: 'blocked' }
    } else {
      parts.push(part)
    }
  }
  if (parts.length === 0) return { kind: 'blocked' }
  const path = absolute ? `/${parts.join('/')}` : parts.join('/')
  return path === documentPath ? { kind: 'anchor', fragment } : { kind: 'file', path, fragment }
}

export function markdownHeadingId(text: string): string {
  return `markdown-${text.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-')}`
}
