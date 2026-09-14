import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import './file-editor.css'

interface HtmlPreviewProps {
  content: string
  path: string
}

/** 在隔离沙箱 iframe 中渲染 HTML;仅放开脚本以支持 SVG/CSS 动画,不授予同源权限。 */
export function HtmlPreview({ content, path }: HtmlPreviewProps): ReactNode {
  const { t } = useI18n()
  return (
    <iframe
      className="html-preview"
      title={t('editor.htmlLabel')}
      aria-label={path}
      srcDoc={content}
      sandbox="allow-scripts"
    />
  )
}
