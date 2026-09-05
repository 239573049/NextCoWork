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
    '/etc/passwd', '//example.com/a.png', '\\server\\image.png',
    'C:\\secret.txt', 'file:///etc/passwd', 'javascript:alert(1)',
    'javascript%3Aalert(1)', 'data:image/svg+xml;base64,PHN2Zz4=',
    'vbscript:msgbox(1)', 'ncw://private/image.png', 'blob:secret',
    'foo%00bar.png', 'foo%0Abar.png', 'foo%5Cbar.png', '%E0%A4%A', ''
  ])('blocks unsafe or malformed references: %s', (reference) => {
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

  it('opens Agent absolute file links only when they are inside the current workspace', () => {
    expect(resolveMarkdownTarget('', '/work/project/src/app.ts', '/work/project')).toEqual({ kind: 'file', path: 'src/app.ts', fragment: '' })
    expect(resolveMarkdownTarget('', '/work/project/src/../README.md#intro', '/work/project')).toEqual({ kind: 'file', path: 'README.md', fragment: 'intro' })
    for (const path of ['/work/project-other/secret', '/work/project/../secret', '//evil.example/file', '/etc/passwd']) {
      expect(resolveMarkdownTarget('', path, '/work/project')).toEqual({ kind: 'blocked' })
    }
    expect(resolveMarkdownTarget('', 'https://user:secret@example.com')).toEqual({ kind: 'blocked' })
  })
})
