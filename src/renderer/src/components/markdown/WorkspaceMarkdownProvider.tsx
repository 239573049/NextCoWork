import { useMemo, type ReactNode } from 'react'
import { copyText, openExternal } from '../../services/app'
import { readWorkspaceFile } from '../../services/workspace-files'
import { MarkdownProvider, type MarkdownEnvironment } from './MarkdownProvider'
import { resolveMarkdownTarget } from './links'

/** Host integration is separate from the reusable parser and presentation components. */
export function WorkspaceMarkdownProvider({ workspaceId, documentPath = '', workspaceRoot, onOpenFile, children }: {
  workspaceId: string
  documentPath?: string
  workspaceRoot?: string
  onOpenFile: NonNullable<MarkdownEnvironment['onOpenFile']>
  children: ReactNode
}): ReactNode {
  const value = useMemo<MarkdownEnvironment>(() => ({
    resolveLink: (reference) => resolveMarkdownTarget(documentPath, reference, workspaceRoot),
    onOpenFile,
    onOpenExternal: openExternal,
    onCopyCode: copyText,
    loadImage: async (path) => {
      const file = await readWorkspaceFile(workspaceId, path)
      if (file.kind !== 'image') throw new Error('Not an image')
      return file.dataUrl
    },
  }), [workspaceId, documentPath, workspaceRoot, onOpenFile])
  return <MarkdownProvider value={value}>{children}</MarkdownProvider>
}
