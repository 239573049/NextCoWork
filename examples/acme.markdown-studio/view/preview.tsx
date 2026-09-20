/**
 * 预览渲染 —— react-markdown + GFM + KaTeX,代码高亮复用 CodeMirror 的
 * lezer 语法树(与宿主 `components/markdown/highlight.ts` 同一招),mermaid
 * 按需动态加载。
 *
 * ## 安全模型(为什么不用 DOMPurify)
 *
 * remark-rehype 默认**丢弃**原始 HTML 节点(不带 allowDangerousHtml),
 * 所以文档里内嵌的 `<script>`/`<img onerror>` 根本进不了 DOM —— 这比
 * 「放行后再消毒」少一整类绕过。代价是不渲染内嵌 HTML,这是有意选择。
 *
 * ## iframe 的两条先天限制(不藏着)
 *
 * - **链接不导航**:sandbox 没有 allow-popups / allow-top-navigation,
 *   点击外链是 no-op。行为:⌘/Ctrl+点击复制 URL(尽力而为),悬停可见地址。
 * - **工作区图片加载不出**:`![](./pic.png)` 的相对路径解析到
 *   `ncw-plugin://acme.markdown-studio/` 下,那里没有工作区文件;文档通道
 *   只送本文档一个文件。http(s) 图片走 CSP `img-src 'self' data: blob:`
 *   同样出不去。这类图片渲染为占位说明,而不是一排碎图标。
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { headingId } from './outline'
import { t } from './i18n'

/** 宿主视图垫片注入的主题当前值(同 image-studio 的声明)。 */
declare global {
  var __ncwTheme: { appearance: 'light' | 'dark'; motion: string; tokens: Record<string, string> } | undefined
}

/* ─────────────────── 代码高亮(lezer) ─────────────────── */

interface CodeSpan { from: number; to: number; className: string }

const languageCache = new Map<string, LanguageDescription | null>()

function describe(language: string): LanguageDescription | null {
  if (languageCache.has(language)) return languageCache.get(language) ?? null
  const found =
    LanguageDescription.matchLanguageName(languages, language, false) ??
    LanguageDescription.matchFilename(languages, `snippet.${language}`)
  languageCache.set(language, found ?? null)
  return found ?? null
}

async function highlightCode(code: string, language: string): Promise<CodeSpan[]> {
  if (code.length > 100_000 || language === '') return []
  const description = describe(language)
  if (description === null) return []
  try {
    const support = await description.load()
    const spans: CodeSpan[] = []
    highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, className) => {
      spans.push({ from, to, className })
    })
    return spans
  } catch {
    return []
  }
}

function CodeBody({ code, language }: { code: string; language: string }): ReactNode {
  const [spans, setSpans] = useState<CodeSpan[]>([])
  useEffect(() => {
    let alive = true
    void highlightCode(code, language).then((result) => { if (alive) setSpans(result) })
    return () => { alive = false }
  }, [code, language])
  if (spans.length === 0) return <code>{code}</code>
  const out: ReactNode[] = []
  let at = 0
  spans.forEach((span, index) => {
    if (span.from > at) out.push(code.slice(at, span.from))
    out.push(<span key={index} className={span.className}>{code.slice(span.from, span.to)}</span>)
    at = span.to
  })
  if (at < code.length) out.push(code.slice(at))
  return <code>{out}</code>
}

/* ─────────────────── mermaid ─────────────────── */

let mermaidReady: Promise<typeof import('mermaid').default> | null = null
let mermaidSequence = 0

function MermaidBlock({ code }: { code: string }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const dark = (globalThis.__ncwTheme?.appearance ?? 'light') === 'dark'

  useEffect(() => {
    let alive = true
    mermaidReady ??= import('mermaid').then((module) => {
      module.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' })
      return module.default
    })
    // 主题切换时重新初始化 —— mermaid 的主题只在 initialize/render 时生效
    void import('mermaid').then((module) => {
      module.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' })
    })
    mermaidSequence += 1
    void mermaidReady
      .then((mermaid) => mermaid.render(`mmd-${mermaidSequence}`, code))
      .then((result) => { if (alive) { setSvg(result.svg); setFailed(false) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [code, dark])

  if (failed) return <div className="mermaid-error">{t('mermaid.failed')}</div>
  if (svg === null) return <div className="mermaid-loading" />
  // mermaid 输出的 svg 已由它自己生成;不经过 innerHTML 的话无法整体注入。
  // 内容源是 mermaid 自身渲染器(非用户 HTML),与「丢弃原始 HTML」的立场不冲突。
  return <div className="mermaid-body" dangerouslySetInnerHTML={{ __html: svg }} />
}

/* ─────────────────── 渲染组件表 ─────────────────── */

function buildComponents(headingCounter: { current: number }): Components {
  return {
    h1: ({ children }) => <H level={1} counter={headingCounter}>{children}</H>,
    h2: ({ children }) => <H level={2} counter={headingCounter}>{children}</H>,
    h3: ({ children }) => <H level={3} counter={headingCounter}>{children}</H>,
    h4: ({ children }) => <H level={4} counter={headingCounter}>{children}</H>,
    h5: ({ children }) => <H level={5} counter={headingCounter}>{children}</H>,
    h6: ({ children }) => <H level={6} counter={headingCounter}>{children}</H>,
    a: ({ href, children }) => (
      <a
        href={href}
        title={href ?? undefined}
        onClick={(event) => {
          // iframe 出不去(见文件头);⌘/Ctrl 点击至少把地址留下
          event.preventDefault()
          if (event.metaKey || event.ctrlKey) void navigator.clipboard?.writeText(href ?? '').catch(() => undefined)
        }}
      >
        {children}
      </a>
    ),
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? src : ''
      // http(s)/data 之外一律出不了 iframe(见文件头),画占位而不是碎图标
      if (!/^(https?:|data:)/.test(url)) {
        return <span className="img-fallback" title={url}>{alt === '' || alt === undefined ? '🖼' : `🖼 ${alt}`}</span>
      }
      return <img src={src} alt={alt} loading="lazy" />
    },
    code: (props) => {
      const { node, className, children, ...rest } = props
      void node
      const text = String(children ?? '')
      const match = /^language-(\S+)/.exec(className ?? '')
      const language = match?.[1] ?? ''
      if (language === 'mermaid') {
        return <div className="mermaid-wrap"><MermaidBlock code={text.replace(/\n$/, '')} /></div>
      }
      // 行内代码(无语言标注且单行)不进 <pre>,react-markdown 已按上下文区分:
      // 代码块里的 code 带 language-xxx 或落在 pre 下;这里用父级判断兜底。
      if (match === null && !text.includes('\n')) {
        return <code className="inline" {...rest}>{children}</code>
      }
      return (
        <code className={className}>
          <CodeBody code={text.replace(/\n$/, '')} language={language} />
        </code>
      )
    }
  }
}

function H({ level, counter, children }: { level: number; counter: { current: number }; children?: ReactNode }): ReactNode {
  // id 是装饰性锚(见 outline.ts 的 headingId);跳转对齐靠「编辑器行号 + 文本匹配」
  const index = counter.current
  counter.current += 1
  const Tag = `h${level}` as 'h1'
  return <Tag id={headingId('', index)}>{children}</Tag>
}

/* ─────────────────── 入口 ─────────────────── */

export const MarkdownPreviewBody = memo(function MarkdownPreviewBody({ source }: { source: string }): ReactNode {
  /*
    headingCounter 每次 render 前“归零”,渲染过程中 H 组件按出现次序自增 ——
    这与 scanOutline 的行序一致(react-markdown 按文档顺序渲染),所以两边
    生成的 id 相同,大纲点击才能滚到对应标题。
    ★ memo 的比较只看 source;counter 是 ref 不是 state,重渲染由父级驱动。
  */
  const headingCounter = useRef(0)
  headingCounter.current = 0
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={buildComponents(headingCounter)}
    >
      {source}
    </ReactMarkdown>
  )
})
