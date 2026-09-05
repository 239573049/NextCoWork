import { useEffect, useId, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { useAppearance } from '../../theme/useAppearance'
import type { MarkdownCodeProps } from './MarkdownProvider'
import { CodeSource } from './CodeSource'
import { canRenderMermaid } from './mermaid-policy'

// Mermaid has process-wide configuration. Serialize renders from different messages.
let renderQueue: Promise<unknown> = Promise.resolve()

export function MermaidBlock({ code, language }: MarkdownCodeProps): ReactNode {
  const { t } = useI18n()
  const appearance = useAppearance()
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const [result, setResult] = useState<{ code: string; appearance: string; url?: string; failed?: boolean } | null>(null)
  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    const render = async (): Promise<void> => {
      if (!active) return
      try {
        if (!canRenderMermaid(code)) throw new Error('Unsupported diagram content')
        const { default: mermaid } = await import('mermaid')
        if (!active) return
        const styles = getComputedStyle(document.documentElement)
        const color = (name: string): string => styles.getPropertyValue(`--color-${name}`).trim()
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          theme: 'base',
          themeVariables: {
            darkMode: appearance === 'dark', primaryColor: color('tint'), primaryTextColor: color('fg'),
            primaryBorderColor: color('accent-soft'), lineColor: color('fg-muted'),
            secondaryColor: color('surface'), tertiaryColor: color('surface-raised'),
            edgeLabelBackground: color('canvas'), clusterBkg: color('surface'), clusterBorder: color('border'),
          },
          fontFamily: 'sans-serif', htmlLabels: false, flowchart: { htmlLabels: false },
          maxTextSize: 50_000, maxEdges: 500,
          // Source directives must not override security or enable HTML labels.
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'dompurifyConfig', 'themeCSS', 'themeVariables', 'fontFamily'],
        })
        const { svg } = await mermaid.render(id, code)
        if (!active) return
        // An image, not live SVG/HTML: no scripts, click handlers, or bound callbacks.
        objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        setResult({ code, appearance, url: objectUrl })
      } catch {
        if (active) setResult({ code, appearance, failed: true })
      }
    }
    renderQueue = renderQueue.then(render, render)
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [code, appearance, id])

  if (result?.code !== code || result.appearance !== appearance) {
    return <div className="markdown-render-status" role="status">{t('markdown.diagramLoading')}</div>
  }
  if (result.failed) return <>
    <div className="markdown-render-status" role="status">{t('markdown.diagramFailed')}</div>
    <CodeSource code={code} language={language} />
  </>
  return <div className="markdown-diagram scroll-thin"><img src={result.url} alt={t('markdown.diagramLabel')} /></div>
}
