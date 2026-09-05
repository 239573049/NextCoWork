import { ImageOff } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { useMarkdownEnvironment } from './MarkdownProvider'
import { resolveMarkdownTarget } from './links'

export function MarkdownImage({ src, alt, title }: { src: string; alt: string; title?: string }): ReactNode {
  const { t } = useI18n()
  const { resolveLink, loadImage, externalImages = 'prompt' } = useMarkdownEnvironment()
  const target = useMemo(() => resolveLink ? resolveLink(src) : resolveMarkdownTarget('', src), [src, resolveLink])
  const [state, setState] = useState<{ src: string; dataUrl?: string; failed?: boolean } | null>(null)
  const [requested, setRequested] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setState(null)
    if (target.kind === 'file' && loadImage) {
      void loadImage(target.path).then((dataUrl) => {
        if (active) setState({ src, dataUrl })
      }).catch(() => { if (active) setState({ src, failed: true }) })
    }
    return () => { active = false }
  }, [src, target, loadImage, retry])
  useEffect(() => { setRequested(false) }, [src])

  const failed = state?.src === src && state.failed
  const url = target.kind === 'external' && externalImages === 'prompt' && requested ? target.url
    : state?.src === src ? state.dataUrl : undefined
  if (url && !failed) return <img src={url} alt={alt} title={title} loading={target.kind === 'external' ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer"
    onError={() => setState({ src, failed: true })} />
  const external = target.kind === 'external' && externalImages === 'prompt'
  const message = failed ? 'markdown.imageFailed' : target.kind === 'external' ? 'markdown.imageExternal'
    : target.kind === 'file' && loadImage ? 'markdown.imageLoading' : 'markdown.imageBlocked'
  return <span className="markdown-image-placeholder">
    <ImageOff size={16} aria-hidden="true" />
    <span>{alt && <span className="markdown-image-alt">{alt}</span>}<span role="status">{t(message)}</span></span>
    {(external || failed && target.kind === 'file' && loadImage) && <button type="button" onClick={() => {
      setState(null)
      setRequested(true)
      setRetry((v) => v + 1)
    }}>{t(failed ? 'markdown.retryImage' : 'markdown.loadImage')}</button>}
  </span>
}
