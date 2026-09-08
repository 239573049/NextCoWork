import { describe, expect, it } from 'vitest'
import { markdownHeadingId, resolveMarkdownTarget } from '../markdown-links'

describe('Markdown workspace references', () => {
  it('resolves siblings, parents, spaces, and fragments inside the workspace', () => {
    expect(resolveMarkdownTarget('docs/start.md', '../assets/my%20image.png')).toEqual({ kind: 'file', path: 'assets/my image.png', fragment: '' })
    expect(resolveMarkdownTarget('docs/start.md', './guide.md?view=1#install')).toEqual({ kind: 'file', path: 'docs/guide.md', fragment: 'install' })
    expect(resolveMarkdownTarget('docs/start.md', '#中文标题')).toEqual({ kind: 'anchor', fragment: '中文标题' })
    expect(resolveMarkdownTarget('docs/start.md', 'start.md#install')).toEqual({ kind: 'anchor', fragment: 'install' })
  })

  it('preserves escaped filename punctuation and decodes it only once', () => {
    expect(resolveMarkdownTarget('start.md', 'image%23one%3F.png')).toEqual({ kind: 'file', path: 'image#one?.png', fragment: '' })
    expect(resolveMarkdownTarget('start.md', '%252e%252e.png')).toEqual({ kind: 'file', path: '%2e%2e.png', fragment: '' })
  })

  it.each([
    '../../secret.txt', '../..%2fsecret.txt', '%2e%2e/%2e%2e/secret.txt',
    '//example.com/a.png', '\\server\\image.png',
    'C:\\secret.txt', 'file:///etc/passwd', 'javascript:alert(1)',
    'javascript%3Aalert(1)', 'data:image/svg+xml;base64,PHN2Zz4=',
    'vbscript:msgbox(1)', 'ncw://private/image.png', 'blob:secret',
    'foo%00bar.png', 'foo%0Abar.png', 'foo%5Cbar.png', '%E0%A4%A', ''
  ])('blocks unsafe or malformed references: %s', (reference) => {
    // Without a workspace root there is no way to name a target above the document, so climbing out stays blocked.
    expect(resolveMarkdownTarget('docs/start.md', reference)).toEqual({ kind: 'blocked' })
  })

  it('uses only HTTP(S) for system browser links', () => {
    expect(resolveMarkdownTarget('start.md', 'https://example.com/help?q=1#part')).toEqual({ kind: 'external', url: 'https://example.com/help?q=1#part' })
    expect(resolveMarkdownTarget('start.md', 'http://localhost:3000')).toEqual({ kind: 'external', url: 'http://localhost:3000/' })
    expect(resolveMarkdownTarget('start.md', 'https://')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownTarget('start.md', 'mailto:test@example.com')).toEqual({ kind: 'blocked' })
  })

  it('creates predictable IDs without colliding with app elements', () => {
    expect(markdownHeadingId(' Hello, world! ')).toBe('markdown-hello-world')
    expect(markdownHeadingId('开始 使用')).toBe('markdown-开始-使用')
  })

  it('keeps workspace links relative and lets links that leave the workspace stay absolute', () => {
    expect(resolveMarkdownTarget('', '/work/project/src/app.ts', '/work/project')).toEqual({ kind: 'file', path: 'src/app.ts', fragment: '' })
    expect(resolveMarkdownTarget('', '/work/project/src/../README.md#intro', '/work/project')).toEqual({ kind: 'file', path: 'README.md', fragment: 'intro' })

    // Outside the workspace the target keeps its absolute form — the host resolves and permission mode governs it.
    expect(resolveMarkdownTarget('', '/work/project-other/secret', '/work/project')).toEqual({ kind: 'file', path: '/work/project-other/secret', fragment: '' })
    expect(resolveMarkdownTarget('', '/work/project/../secret', '/work/project')).toEqual({ kind: 'file', path: '/work/secret', fragment: '' })
    expect(resolveMarkdownTarget('', '/etc/passwd')).toEqual({ kind: 'file', path: '/etc/passwd', fragment: '' })
    // A relative reference climbing past the root can only be named once we know where the root is.
    expect(resolveMarkdownTarget('docs/start.md', '../../secret.txt', '/work/project')).toEqual({ kind: 'file', path: '/work/secret.txt', fragment: '' })
    // A document that is itself outside the workspace resolves its siblings next to it.
    expect(resolveMarkdownTarget('/etc/hosts', 'passwd')).toEqual({ kind: 'file', path: '/etc/passwd', fragment: '' })

    // A protocol-relative URL is not a path, whatever the root is.
    expect(resolveMarkdownTarget('', '//evil.example/file', '/work/project')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownTarget('', 'https://user:secret@example.com')).toEqual({ kind: 'blocked' })
  })
})
