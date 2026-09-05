import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceFileMutationRequest } from '../../../../shared/domain/workspace-file'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { TextInput } from '../../components/ui/TextInput'
import { useI18n, type TranslationKey } from '../../i18n'
import { operationRequest, type FileOperationTarget } from './file-operations'

export function FileOperationDialog({
  workspaceId,
  target,
  busy,
  hidden,
  failure,
  onSubmit,
  onClose,
}: {
  workspaceId: string
  target: FileOperationTarget
  busy: boolean
  hidden: boolean
  failure: TranslationKey | null
  onSubmit: (request: WorkspaceFileMutationRequest) => void
  onClose: () => void
}): ReactNode {
  const { t } = useI18n()
  const [value, setValue] = useState(
    target.operation === 'rename'
      ? target.name
      : target.operation === 'copy' || target.operation === 'move'
        ? target.path
        : '',
  )
  const [validation, setValidation] = useState<TranslationKey | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (hidden) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [hidden])
  const isDelete = target.operation === 'delete'
  const isDestination = target.operation === 'copy' || target.operation === 'move'
  const isCreate = target.operation === 'create-file' || target.operation === 'create-directory'
  const titleKeys: Record<FileOperationTarget['operation'], TranslationKey> = {
    'create-file': 'files.manage.newFile',
    'create-directory': 'files.manage.newDirectory',
    rename: 'files.manage.rename',
    copy: 'files.manage.copy',
    move: 'files.manage.move',
    delete: 'files.manage.deleteTitle',
  }
  const actionKeys: Record<FileOperationTarget['operation'], TranslationKey> = {
    'create-file': 'files.manage.create',
    'create-directory': 'files.manage.create',
    rename: 'files.manage.rename',
    copy: 'files.manage.copyAction',
    move: 'files.manage.moveAction',
    delete: 'files.manage.delete',
  }
  const submit = (): void => {
    if (busy) return
    const result = operationRequest(workspaceId, target, value)
    if (result.error !== undefined) {
      setValidation(result.error)
      return
    }
    setValidation(null)
    onSubmit(result.request)
  }
  const error = validation ?? failure

  return (
    <Dialog
      open={!hidden}
      onClose={() => !busy && onClose()}
      title={t(titleKeys[target.operation])}
      width={460}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant={isDelete ? 'danger' : 'accent'}
            onClick={submit}
            disabled={busy || (!isDelete && value.trim() === '')}
            icon={busy ? <Loader2 size={13} className="animate-spin" /> : undefined}
          >
            {t(busy ? 'files.manage.working' : actionKeys[target.operation])}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" aria-busy={busy} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          submit()
        }
      }}>
        <p className="selectable break-all text-[12px] text-fg-muted">
          {t(isCreate ? 'files.manage.parent' : 'files.manage.source', {
            path: target.path || t('files.manage.root'),
          })}
        </p>
        {isDelete ? (
          <p className="flex items-start gap-2 text-[13px] text-fg">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
            <span className="break-words">{t('files.manage.deleteHint', { name: target.name })}</span>
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="text-[12px] text-fg-muted">
                {t(isDestination ? 'files.manage.destination' : 'files.manage.name')}
              </div>
              <TextInput
                value={value}
                inputRef={inputRef}
                onChange={(next) => {
                  setValue(next)
                  setValidation(null)
                }}
                ariaLabel={t(isDestination ? 'files.manage.destination' : 'files.manage.name')}
                placeholder={t(isDestination ? 'files.manage.destinationPlaceholder' : 'files.manage.namePlaceholder')}
                disabled={busy}
                invalid={error !== null}
              />
            </div>
            {isDestination && (
              <p className="text-[12px] leading-relaxed text-fg-faint">
                {t('files.manage.destinationHint')}
              </p>
            )}
          </>
        )}
        {error !== null && <p role="alert" className="text-[12px] text-danger">{t(error)}</p>}
      </div>
    </Dialog>
  )
}
