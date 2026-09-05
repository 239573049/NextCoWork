import { createContext, memo, useContext, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { CodeBlock } from './CodeBlock'
import { MarkdownImage } from './MarkdownImage'
import { useMarkdownEnvironment } from './MarkdownProvider'
import { isCodeStreaming, rehypeMarkdownIds, textOf } from './ast'
import { resolveMarkdownTarget } from './links'
import 'katex/dist/katex.min.css'
import './markdown.css'

export interface AgentMarkdownProps {
  content: string
  streaming?: boolean
  variant?: 'response' | 'compact' | 'document'
  className?: string
}

interface RenderState {
  source: string
  streaming: boolean
  prefix: string
  container: RefObject<HTMLDivElement | null>
}
const RenderContext = createContext<RenderState | null>(null)
const remarkPlugins = [remarkGfm, remarkMath]

/** One renderer for committed replies, token streams, reasoning, plans and documents. */
export const AgentMarkdown = memo(function AgentMarkdown({ content, streaming = false, variant = 'response', className }: AgentMarkdownProps): ReactNode {
  const { t } = useI18n()
  const prefix = `markdown-${useId().replace(/[^a-zA-Z0-9-]/g, '')}-`
  const container = useRef<HTMLDivElement>(null)
  const state = useMemo(() => ({ source: content, streaming, prefix, container }), [content, streaming, prefix])
  const rehypePlugins = useMemo(() => [
    [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
    [rehypeMarkdownIds, { prefix, mathErrorLabel: t('markdown.mathFailed') }],
  ] as NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']>, [prefix, t])
  const remarkRehypeOptions = useMemo(() => ({
    clobberPrefix: prefix,
    footnoteLabel: t('markdown.footnotes'),
    footnoteBackLabel: (reference: number, index: number) => t('markdown.footnoteBack', { reference: `${reference + 1}${index > 1 ? `-${index}` : ''}` }),
  }), [prefix, t])

  return <div ref={container} className={cn('agent-markdown selectable', className)} data-variant={variant}
    data-streaming={streaming || undefined} aria-busy={streaming}>
    <RenderContext.Provider value={state}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} remarkRehypeOptions={remarkRehypeOptions}
        skipHtml components={components} urlTransform={(url) => url}>
        {content}
      </ReactMarkdown>
    </RenderContext.Provider>
    {streaming && <span className="markdown-stream-cursor" aria-hidden="true" />}
  </div>
})

function MarkdownPre({ node }: ExtraProps): ReactNode {
  const state = useContext(RenderContext)!
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code || code.type !== 'element') return <pre>{textOf(node)}</pre>
  const classes = Array.isArray(code.properties.className) ? code.properties.className.join(' ') : ''
  const language = /(?:^|\s)language-(\S+)/.exec(classes)?.[1]?.toLowerCase() ?? ''
  const meta = typeof code.data?.meta === 'string' ? code.data.meta : undefined
  return <CodeBlock code={textOf(code).replace(/\n$/, '')} language={language} meta={meta}
    streaming={isCodeStreaming(node, state.source, state.streaming)} />
}

function MarkdownLink({ href, title, children, node: _node, ...props }: React.ComponentProps<'a'> & ExtraProps): ReactNode {
  const { t } = useI18n()
  const state = useContext(RenderContext)!
  const { resolveLink, onOpenFile, onOpenExternal } = useMarkdownEnvironment()
  const [failed, setFailed] = useState(false)
  const target = resolveLink ? resolveLink(href ?? '') : resolveMarkdownTarget('', href ?? '')
  if (target.kind === 'blocked' || target.kind === 'file' && !onOpenFile) {
    return <span className="markdown-blocked-link" title={t('markdown.linkBlocked')}>{children}</span>
  }
  const destination = target.kind === 'external' ? target.url : target.kind === 'anchor'
    ? `#${target.fragment.startsWith(state.prefix) ? target.fragment : `${state.prefix}${target.fragment}`}` : '#'
  return <>
    <a {...props} href={destination} title={title} rel="noreferrer noopener" target={target.kind === 'external' ? '_blank' : undefined}
      onClick={(event) => {
        setFailed(false)
        if (target.kind === 'external') {
          if (onOpenExternal) {
            event.preventDefault()
            void Promise.resolve().then(() => onOpenExternal(target.url)).catch(() => setFailed(true))
          }
          return
        }
        event.preventDefault()
        if (target.kind === 'file') {
          void Promise.resolve().then(() => onOpenFile?.(target.path, target.fragment)).catch(() => setFailed(true))
        } else {
          const fragment = target.fragment
          const element = !fragment ? state.container.current : Array.from(state.container.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
            .find((element) => element.id === `${state.prefix}${fragment}` || element.id === fragment)
          element?.scrollIntoView({ block: 'start' })
        }
      }}>{children}</a>
    {failed && <span className="markdown-link-error" role="alert">{t('markdown.linkFailed')}</span>}
  </>
}

function MarkdownTable({ children }: { children?: ReactNode }): ReactNode {
  const { t } = useI18n()
  return <div className="markdown-table-scroll scroll-thin" role="region" tabIndex={0} aria-label={t('markdown.tableRegion')}><table>{children}</table></div>
}

// Stable component identities preserve code controls and image state as tokens arrive.
const components: Components = {
  pre: MarkdownPre,
  a: MarkdownLink,
  img: ({ src, alt, title }) => <MarkdownImage key={typeof src === 'string' ? src : ''} src={typeof src === 'string' ? src : ''} alt={alt ?? ''} title={title} />,
  table: MarkdownTable,
}
