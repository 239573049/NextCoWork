import { Check, Copy, WrapText } from 'lucide-react'
import { memo, useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { useMarkdownEnvironment, type MarkdownCodeProps } from './MarkdownProvider'
import { MermaidBlock } from './MermaidBlock'
import { CodeSource } from './CodeSource'

export const CodeBlock = memo(function CodeBlock(props: MarkdownCodeProps): ReactNode {
  const { code, language, streaming } = props
  const { t } = useI18n()
  const { onCopyCode, codeRenderers } = useMarkdownEnvironment()
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [wrap, setWrap] = useState(false)
  const [source, setSource] = useState(false)
  const Renderer = codeRenderers?.[language] ?? (language === 'mermaid' ? MermaidBlock : undefined)
  const showSource = !Renderer || source || streaming

  useEffect(() => { setCopy('idle') }, [code])
  useEffect(() => {
    if (copy === 'idle') return
    const timer = setTimeout(() => setCopy('idle'), 2200)
    return () => clearTimeout(timer)
  }, [copy])

  return (
    <div className="markdown-code-block" data-language={language || undefined} data-streaming={streaming || undefined}>
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{language || t('markdown.code')}</span>
        {Renderer && <div className="markdown-code-views">
          <button type="button" aria-pressed={!showSource} disabled={streaming} onClick={() => setSource(false)}>{t(language === 'mermaid' ? 'markdown.diagram' : 'markdown.preview')}</button>
          <button type="button" aria-pressed={showSource} onClick={() => setSource(true)}>{t('markdown.source')}</button>
        </div>}
        <div className="markdown-code-actions">
          {showSource && <button type="button" title={t(wrap ? 'markdown.unwrap' : 'markdown.wrap')}
            aria-label={t(wrap ? 'markdown.unwrap' : 'markdown.wrap')} aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
            <WrapText size={14} aria-hidden="true" />
          </button>}
          <button type="button" className="markdown-copy" title={t(copy === 'failed' ? 'markdown.copyFailed' : 'markdown.copy')}
            onClick={() => {
              void Promise.resolve().then(() => onCopyCode ? onCopyCode(code) : navigator.clipboard.writeText(code))
                .then(() => setCopy('copied')).catch(() => setCopy('failed'))
            }}>
            {copy === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span aria-live="polite">{t(copy === 'copied' ? 'markdown.copied' : copy === 'failed' ? 'markdown.copyFailed' : 'markdown.copy')}</span>
          </button>
        </div>
      </div>
      {Renderer && streaming && <div className="markdown-render-status" role="status">{t('markdown.diagramStreaming')}</div>}
      {showSource ? <CodeSource code={code} language={language} wrap={wrap} /> : <Renderer {...props} />}
    </div>
  )
})
