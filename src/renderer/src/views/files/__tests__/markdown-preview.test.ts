import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../i18n'
import { MarkdownPreview } from '../MarkdownPreview'

function render(content: string): string {
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(MarkdownPreview, { content, workspaceId: 'workspace-1', path: 'docs/readme.md', onOpenFile: vi.fn() })))
}

describe('built-in Markdown preview', () => {
  it('renders headings, task lists, tables, links, and fenced code', () => {
    const html = render([
      '# Workspace guide', '', '- [x] Complete', '- [ ] Pending', '',
      '| Name | Value |', '| --- | --- |', '| alpha | 42 |', '',
      '[Documentation](https://example.com/docs)', '',
      '```typescript', 'const value = 42', '```'
    ].join('\n'))
    expect(html).toMatch(/<h1 id="markdown-[^"]+-workspace-guide">Workspace guide<\/h1>/)
    expect(html).toContain('data-variant="document"')
    expect(html).toContain('class="task-list-item"')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>alpha</td>')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('data-language="typescript"')
    expect(html).toContain('markdown-copy')
    expect(html).toContain('const value = 42')
  })

  it('preserves inline code, plain code fences, and duplicate heading anchors', () => {
    const html = render('# Heading\n\n# Heading\n\nUse `raw <value>`.\n\n```\nliteral <script>\n```')
    expect(html).toMatch(/id="markdown-[^"]+-heading"/)
    expect(html).toMatch(/id="markdown-[^"]+-heading-1"/)
    expect(html).toContain('<code>raw &lt;value&gt;</code>')
    expect(html).toContain('<code>literal &lt;script&gt;</code>')
  })

  it('removes raw HTML and prevents dangerous links from becoming navigable', () => {
    const html = render([
      '<script>window.evil = true</script>', '',
      '<iframe src="https://evil.example"></iframe>', '',
      '[attack](javascript:alert%281%29)', '',
      '[encoded](javascript%3Aalert%281%29)', '',
      '[local escape](../../secret.txt)', '',
      '![remote](https://evil.example/pixel.png)', '',
      '![file](file:///etc/passwd)'
    ].join('\n'))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('javascript%3A')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src="https://evil.example')
    expect(html).toContain('markdown-image-placeholder')
    expect(html).toContain('markdown-blocked-link')
  })
})
