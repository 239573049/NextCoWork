import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import type { CodeSpan } from './highlight'

/** Static code DOM shared by ordinary fences and rich-preview source fallbacks. */
export function CodeSource({ code, language, wrap = false }: { code: string; language: string; wrap?: boolean }): ReactNode {
  const { t } = useI18n()
  const [highlight, setHighlight] = useState<{ code: string; language: string; spans: CodeSpan[] } | null>(null)
  useEffect(() => {
    let active = true
    // Grammar/code failures fall back to escaped plain text without affecting the reply.
    if (code.length <= 100_000 && language) {
      void import('./highlight').then((module) => module.highlightCode(code, language))
        .then((spans) => { if (active) setHighlight({ code, language, spans }) }).catch(() => {})
    }
    return () => { active = false }
  }, [code, language])
  const children: ReactNode[] = []
  let cursor = 0
  if (highlight?.code === code && highlight.language === language) {
    for (const span of highlight.spans) {
      if (span.from > cursor) children.push(code.slice(cursor, span.from))
      children.push(<span key={span.from} className={span.className}>{code.slice(span.from, span.to)}</span>)
      cursor = span.to
    }
  }
  children.push(code.slice(cursor))
  return <pre className="markdown-code-source scroll-thin" data-wrap={wrap || undefined} tabIndex={0}
    aria-label={t('markdown.codeRegion', { language: language || t('markdown.code') })}><code>{children}</code></pre>
}
