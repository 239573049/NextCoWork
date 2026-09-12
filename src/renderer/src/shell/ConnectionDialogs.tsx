import { LoaderCircle, RotateCw, Server, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionStatus, SshAuthRequest, SshAuthResponse } from '../../../shared/domain/environment'
import { normalizeEnvironmentRef } from '../../../shared/domain/environment'
import type { Workspace } from '../../../shared/domain/workspace'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { IconButton } from '../components/ui/IconButton'
import { useI18n } from '../i18n'
import { connectionErrorKey, listConnections, onConnectionStatus, onSshAuthentication, respondSshAuthentication } from '../services/connections'
import { useWindowStore } from '../stores/window'

export function ConnectionDialogs({ workspace }: { workspace?: Workspace }): ReactNode {
  const { t } = useI18n()
  const win = useWindowStore()
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [requests, setRequests] = useState<SshAuthRequest[]>([])
  useEffect(() => {
    let alive = true
    void listConnections().then((items) => {
      if (alive) setStatuses(Object.fromEntries(items.map(({ status }) => [status.connectionId, status])))
    }).catch(() => {})
    const offStatus = onConnectionStatus((status) => {
      setStatuses((current) => ({ ...current, [status.connectionId]: status }))
      if (status.phase === 'disconnected' || status.phase === 'error') setRequests((current) => current.filter((request) => request.connectionId !== status.connectionId))
    })
    const offAuth = onSshAuthentication((request) => setRequests((current) => current.some((item) => item.id === request.id) ? current : [...current, request]))
    return () => { alive = false; offStatus(); offAuth() }
  }, [])
  const ref = normalizeEnvironmentRef(workspace?.environment)
  const status = ref.kind === 'connection' ? statuses[ref.connectionId] : undefined
  const pending = win.pendingActivation
  const pendingWorkspace = pending ? win.workspaceTargets[pending.workspaceId] : undefined
  const auth = requests[0]
  return <>
    {(pending || win.activationError || ref.kind === 'connection') && (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]" role="status">
        {pending ? <LoaderCircle size={13} className="shrink-0 animate-spin" /> : <Server size={13} className="shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate" title={workspace?.rootPath}>
          {pending ? t('ssh.activating', { name: pendingWorkspace?.name ?? pending.workspaceId }) : win.activationError ? t(win.activationError)
            : `${workspace?.name ?? ''} · ${t(status?.phase === 'ready' ? 'ssh.phase.ready' : 'ssh.offline')} · ${workspace?.rootPath ?? ''}`}
        </span>
        {pending ? <IconButton label={t('common.cancel')} onClick={win.cancelActivation}><X size={14} /></IconButton>
          : workspace && ref.kind === 'connection' && status?.phase !== 'ready'
            ? <Button size="sm" icon={<RotateCw size={13} />} onClick={() => { void win.openWorkspace(workspace.id) }}>{t('ssh.reconnect')}</Button>
            : null}
        {win.activationError && !pending && <IconButton label={t('common.close')} onClick={win.clearActivationError}><X size={14} /></IconButton>}
      </div>
    )}
    <Dialog open={win.activationApproval} title={t('ssh.native.title')} onClose={() => win.confirmActivation(false)} footer={<>
      <Button size="sm" onClick={() => win.confirmActivation(false)}>{t('common.cancel')}</Button>
      <Button size="sm" variant="accent" icon={<ShieldCheck size={13} />} onClick={() => win.confirmActivation(true)}>{t('ssh.native.allow')}</Button>
    </>}>
      <p className="mb-3 break-all text-[13px] text-fg">{pendingWorkspace?.name}<br />{pendingWorkspace?.rootPath}</p>
      <p className="text-[12px] leading-relaxed text-fg-muted">{t('ssh.native.risk')}</p>
    </Dialog>
    {auth && <AuthenticationDialog key={auth.id} request={auth} onDone={() => setRequests((current) => current.filter((request) => request.id !== auth.id))} />}
  </>
}

function AuthenticationDialog({ request, onDone }: { request: SshAuthRequest; onDone(): void }): ReactNode {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const answer = async (response: Omit<SshAuthResponse, 'id'>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await respondSshAuthentication({ id: request.id, ...response }); setValue(''); onDone() }
    catch (error) { setFailure(connectionErrorKey(error)); setBusy(false) }
  }
  const submit = (): void => { void answer(request.kind === 'host-key' ? { value: 'yes' } : { value, remember }) }
  return <Dialog open title={t('ssh.auth.title', { name: request.connectionName })} onClose={() => { void answer({ cancelled: true }) }} footer={<>
    <Button size="sm" disabled={busy} onClick={() => { void answer({ cancelled: true }) }}>{t('common.cancel')}</Button>
    {request.hasSaved && <Button size="sm" disabled={busy} onClick={() => { void answer({ useSaved: true }) }}>{t('ssh.auth.useSaved')}</Button>}
    <Button size="sm" variant="accent" disabled={busy || (request.kind !== 'host-key' && value === '')} onClick={submit}>{t(request.kind === 'host-key' ? 'ssh.auth.trust' : 'ssh.auth.confirm')}</Button>
  </>}>
    {request.savedRejected && <p role="alert" className="mb-3 text-[12px] text-danger">{t('ssh.auth.savedRejected')}</p>}
    <pre className="selectable mb-4 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[12px] text-fg-muted">{request.prompt}</pre>
    {request.kind !== 'host-key' && <label className="flex flex-col gap-2 text-[12px] text-fg">
      {t(`ssh.auth.${request.kind}`)}
      <input type="password" autoComplete="off" value={value} autoFocus aria-label={t(`ssh.auth.${request.kind}`)}
        onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit() }}
        className="h-8 w-full rounded-[6px] border border-border bg-canvas px-2 font-mono outline-none focus:border-accent" />
    </label>}
    {request.canRemember && <label className="mt-3 flex items-center gap-2 text-[12px] text-fg-muted">
      <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{t('ssh.auth.remember')}
    </label>}
    {failure && <p role="alert" className="mt-3 text-[12px] text-danger">{t(failure)}</p>}
  </Dialog>
}