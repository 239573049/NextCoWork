import { File, FolderOpen, RefreshCw, Save } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { IconButton } from '../../components/ui/IconButton'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { revealWorkspaceFile, workspaceFileErrorKey } from '../../services/workspace-files'
import { confirmDocumentChanges, documentKey, isDocumentDirty, useDocumentsStore } from '../../stores/documents'
import { useTabsStore } from '../../stores/tabs'
import { CodeEditor } from './CodeEditor'
import { MarkdownPreview } from './MarkdownPreview'

export function DocumentView({ workspaceId, path }: { workspaceId: string; path: string }): ReactNode {
  const { t } = useI18n()
  const entry = useDocumentsStore((s) => s.entries[documentKey(workspaceId, path)])
  const { load, edit, save, setMode } = useDocumentsStore.getState()
  const [imageFailed, setImageFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const markdown = /\.(?:md|markdown|mdown|mdx)$/i.test(path)

  useEffect(() => {
    if (path) void load(workspaceId, path)
    setImageFailed(false)
    setActionError(null)
  }, [load, workspaceId, path])

  if (!path) return <EmptyState icon={<File size={26} />} title={t('document.empty')} hint={t('document.emptyHint')} />
  const dirty = entry !== undefined && isDocumentDirty(entry)
  const file = entry?.file
  const saving = entry?.saving ?? false
  const reload = async (): Promise<void> => {
    if (await confirmDocumentChanges(workspaceId, path)) {
      setImageFailed(false)
      setActionError(null)
      await load(workspaceId, path, true)
    }
  }
  const reveal = (): void => {
    void revealWorkspaceFile(workspaceId, path).catch((error: unknown) => setActionError(workspaceFileErrorKey(error)))
  }

  return (
    <section data-testid="document-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas" aria-label={path} onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (file?.kind === 'text') void save(workspaceId, path)
      }
    }}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-2">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted" title={path}>{path}</div>
        {file?.kind === 'text' && markdown && (
          <div className="flex items-center gap-1 rounded-pill bg-tint p-0.5">
            {(['preview', 'source'] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={entry?.mode === mode} onClick={() => setMode(workspaceId, path, mode)} className={cn('rounded-pill px-2.5 py-1 text-[11px] transition-colors', entry?.mode === mode ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg')}>
                {t(`document.${mode}`)}
              </button>
            ))}
          </div>
        )}
        <IconButton label={t('document.reload')} size={26} onClick={() => { if (!saving) void reload() }}><RefreshCw size={14} className={entry?.loading ? 'animate-spin' : undefined} /></IconButton>
        <IconButton label={t('document.reveal')} size={26} onClick={reveal}><FolderOpen size={14} /></IconButton>
        {file?.kind === 'text' && <Button size="sm" variant="accent" disabled={!dirty || saving} onClick={() => { void save(workspaceId, path) }} icon={<Save size={12} />}>{t(saving ? 'document.saving' : 'document.save')}</Button>}
      </div>

      {(entry?.error || actionError) && <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-danger/20 bg-danger/5 px-4 py-2 text-[12px] text-danger"><span className="flex-1">{t(entry?.error ?? actionError!)}</span><Button size="sm" onClick={() => { void reload() }}>{t('document.reload')}</Button></div>}
      {!entry || entry.loading ? <div role="status" className="p-6 text-[13px] text-fg-muted">{t('common.loading')}</div> : file?.kind === 'text' ? (
        markdown && entry.mode === 'preview'
          ? <MarkdownPreview content={entry.draft} workspaceId={workspaceId} path={path} onOpenFile={(target) => useTabsStore.getState().openPath(workspaceId, 'doc', target, target.split('/').pop() ?? target)} />
          : <CodeEditor path={path} value={entry.draft} onChange={(value) => edit(workspaceId, path, value)} onSave={() => { void save(workspaceId, path) }} />
      ) : file?.kind === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          {imageFailed ? <EmptyState title={t('document.imageFailed')} /> : <img src={file.dataUrl} alt={path} onError={() => setImageFailed(true)} className="max-h-full max-w-full object-contain" />}
        </div>
      ) : file?.kind === 'binary' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6"><EmptyState icon={<File size={28} />} title={path.split('/').pop() ?? path} hint={t(`document.binary.${file.reason}`)} /><Button onClick={reveal}>{t('document.reveal')}</Button></div>
      ) : null}

      {file && <div className="flex shrink-0 items-center gap-3 border-t border-hairline px-4 py-1.5 text-[11px] text-fg-faint">
        <span>{file.size.toLocaleString()} B</span>
        {file.kind === 'text' && <><span>UTF-8{entry?.bom ? ' BOM' : ''}</span><span>{entry?.lineEnding === '\r\n' ? 'CRLF' : entry?.lineEnding === '\r' ? 'CR' : 'LF'}</span><span role="status" className={cn('ml-auto', dirty && 'text-accent')}>{t(saving ? 'document.saving' : dirty ? 'document.unsaved' : 'document.saved')}</span></>}
      </div>}
    </section>
  )
}
