import type { ReactNode } from 'react'
import { AgentMarkdown, WorkspaceMarkdownProvider } from '../../components/markdown'
import { useI18n } from '../../i18n'
import './file-editor.css'

interface MarkdownPreviewProps {
  content: string
  workspaceId: string
  path: string
  onOpenFile: (path: string) => void
}

/** File preview supplies workspace navigation; parsing and blocks are shared with the Agent. */
export function MarkdownPreview({ content, workspaceId, path, onOpenFile }: MarkdownPreviewProps): ReactNode {
  const { t } = useI18n()
  return (
    <article className="markdown-preview selectable" aria-label={t('editor.markdownLabel')}>
      <WorkspaceMarkdownProvider workspaceId={workspaceId} documentPath={path} onOpenFile={onOpenFile}>
        <AgentMarkdown key={`${workspaceId}:${path}`} content={content} variant="document" />
      </WorkspaceMarkdownProvider>
    </article>
  )
}
