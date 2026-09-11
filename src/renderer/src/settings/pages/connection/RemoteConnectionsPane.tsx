import { Cable, FolderOpen, LoaderCircle, Pencil, Plus, Server, Trash2, Unplug } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionProfile, ConnectionProfileInput } from '../../../../../shared/domain/environment'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { IconButton } from '../../../components/ui/IconButton'
import { Segmented } from '../../../components/ui/Segmented'
import { TextInput } from '../../../components/ui/TextInput'
import { useI18n } from '../../../i18n'
import { cancelConnectionRequest, closeBrowse, connectForBrowse, connectionErrorKey, disconnectConnection, listConnections,
  onConnectionsChanged, onConnectionStatus, pickSshFile, removeConnection, saveConnection } from '../../../services/connections'

export function RemoteConnectionsPane(): ReactNode {
  const { t } = useI18n()
  const [items, setItems] = useState<Awaited<ReturnType<typeof listConnections>>>([])
  const [editing, setEditing] = useState<ConnectionProfile | null | undefined>(undefined)
  const [confirmTest, setConfirmTest] = useState<ConnectionProfile | null>(null)
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const requestRef = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => { void listConnections().then((next) => { if (alive) setItems(next) }).catch((error: unknown) => { if (alive) setFailure(connectionErrorKey(error)) }) }
    load()
    const off = onConnectionsChanged(load)
    const offStatus = onConnectionStatus((status) => setItems((current) => current.map((item) => item.profile.id === status.connectionId ? { ...item, status } : item)))
    return () => { alive = false; off(); offStatus(); if (requestRef.current) void cancelConnectionRequest(requestRef.current).catch(() => {}) }
  }, [])
  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(id); setFailure(null)
    try { await action() } catch (error) { setFailure(connectionErrorKey(error)) } finally { setBusy(null) }
  }
  const test = (): void => {
    if (!confirmTest) return
    const profile = confirmTest
    setConfirmTest(null)
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    void run(profile.id, async () => {
      const directory = await connectForBrowse(profile.id, requestId, true)
      await closeBrowse(directory.browseId)
      requestRef.current = null
    })
  }
  return <section className="flex flex-col gap-4">
    <header className="flex items-center justify-between gap-3">
      <h3 className="text-[14px] font-medium text-fg">{t('ssh.title')}</h3>
      <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing(null)}>{t('ssh.add')}</Button>
    </header>
    {failure && <p role="alert" className="text-[12px] text-danger">{t(failure)}</p>}
    <div className="divide-y divide-border">
      {items.length === 0 && <p className="py-8 text-center text-[13px] text-fg-faint">{t('ssh.empty')}</p>}
      {items.map(({ profile, status }) => <div key={profile.id} className="flex items-center gap-3 py-3">
        <Server size={17} className="shrink-0 text-icon" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-fg">{profile.name}</div>
          <div className="truncate font-mono text-[11px] text-fg-faint">{profile.target.kind === 'manual' && profile.target.username ? `${profile.target.username}@` : ''}{profile.target.host}</div>
          <div className="text-[11px] text-fg-muted">{t(`ssh.phase.${status.phase}`)}</div>
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <input type="checkbox" checked={profile.enabled} disabled={busy !== null} onChange={(event) => { void run(profile.id, () => saveConnection({ ...profile, enabled: event.target.checked })) }} />{t('ssh.enabled')}
        </label>
        <IconButton label={t(status.phase === 'ready' ? 'ssh.disconnect' : 'ssh.test')} disabled={busy !== null || !profile.enabled}
          onClick={() => { if (status.phase === 'ready') void run(profile.id, () => disconnectConnection(profile.id)); else setConfirmTest(profile) }}>
          {busy === profile.id ? <LoaderCircle size={14} className="animate-spin" /> : status.phase === 'ready' ? <Unplug size={14} /> : <Cable size={14} />}
        </IconButton>
        <IconButton label={t('ssh.edit')} disabled={busy !== null} onClick={() => setEditing(profile)}><Pencil size={14} /></IconButton>
        <IconButton label={t('ssh.remove')} disabled={busy !== null} onClick={() => setDeleting(profile)}><Trash2 size={14} /></IconButton>
      </div>)}
    </div>
    {busy && requestRef.current && <Button size="sm" onClick={() => { if (requestRef.current) void cancelConnectionRequest(requestRef.current) }}>{t('common.cancel')}</Button>}
    {editing !== undefined && <ServerEditor key={editing?.id ?? 'new'} editing={editing} onClose={() => setEditing(undefined)} />}
    <Dialog open={confirmTest !== null} title={t('ssh.native.title')} onClose={() => setConfirmTest(null)} footer={<>
      <Button size="sm" onClick={() => setConfirmTest(null)}>{t('common.cancel')}</Button><Button size="sm" variant="accent" onClick={test}>{t('ssh.native.allow')}</Button>
    </>}><p className="mb-3 break-all text-[13px] text-fg">{confirmTest?.name} · {confirmTest?.target.host}</p><p className="text-[12px] leading-relaxed text-fg-muted">{t('ssh.native.risk')}</p></Dialog>
    <Dialog open={deleting !== null} title={t('ssh.remove')} onClose={() => setDeleting(null)} footer={<>
      <Button size="sm" onClick={() => setDeleting(null)}>{t('common.cancel')}</Button><Button size="sm" variant="danger" onClick={() => {
        if (deleting) { const id = deleting.id; setDeleting(null); void run(id, () => removeConnection(id)) }
      }}>{t('common.delete')}</Button>
    </>}><p className="text-[13px] text-fg-muted">{t('ssh.removeConfirm', { name: deleting?.name ?? '' })}</p></Dialog>
  </section>
}

function ServerEditor({ editing, onClose }: { editing: ConnectionProfile | null; onClose(): void }): ReactNode {
  const { t } = useI18n()
  const target = editing?.target
  const [mode, setMode] = useState<'manual' | 'config'>(target?.kind ?? 'manual')
  const [name, setName] = useState(editing?.name ?? '')
  const [host, setHost] = useState(target?.host ?? '')
  const [username, setUsername] = useState(target?.kind === 'manual' ? target.username ?? '' : '')
  const [port, setPort] = useState(target?.kind === 'manual' ? String(target.port ?? 22) : '22')
  const [identity, setIdentity] = useState(target?.kind === 'manual' ? target.identityFile ?? '' : '')
  const [proxyJump, setProxyJump] = useState(target?.kind === 'manual' ? target.proxyJump ?? '' : '')
  const [configFile, setConfigFile] = useState(target?.kind === 'config' ? target.configFile ?? '' : '')
  const [platform, setPlatform] = useState<ConnectionProfile['platform']>(editing?.platform ?? 'auto')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [targetChange, setTargetChange] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setFailure(null)
    const profile: ConnectionProfileInput = { kind: 'ssh', name, platform, enabled: editing?.enabled ?? true,
      ...(editing ? { id: editing.id, revision: editing.revision } : {}), confirmTargetChange: confirmed,
      target: mode === 'config' ? { kind: 'config', host, ...(configFile.trim() ? { configFile: configFile.trim() } : {}) }
        : { kind: 'manual', host, port: Number(port), username: username.trim(), ...(identity ? { identityFile: identity } : {}), ...(proxyJump ? { proxyJump } : {}) } }
    try { await saveConnection(profile); onClose() }
    catch (error) { const key = connectionErrorKey(error); setFailure(key); if (key === 'environment.error.approval-required') setTargetChange(true) }
    finally { setBusy(false) }
  }
  const filePicker = (value: string, update: (value: string) => void, label: string): ReactNode => <div className="flex min-w-0 items-center gap-2">
    <div className="min-w-0 flex-1"><TextInput value={value} onChange={update} ariaLabel={label} placeholder={t('ssh.optional')} /></div>
    <IconButton label={t('ssh.pickFile')} onClick={() => { void pickSshFile().then((path) => { if (path) update(path) }).catch((error: unknown) => setFailure(connectionErrorKey(error))) }}><FolderOpen size={14} /></IconButton>
  </div>
  const field = (label: string, child: ReactNode): ReactNode => <div className="flex min-w-0 flex-col gap-1.5"><div className="text-[12px] text-fg-muted">{label}</div>{child}</div>
  return <Dialog open title={t(editing ? 'ssh.edit' : 'ssh.add')} onClose={() => { if (!busy) onClose() }} footer={<>
    <Button size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
    <Button size="sm" variant="accent" disabled={busy || !name.trim() || !host.trim() || (mode === 'manual' && !username.trim()) || (targetChange && !confirmed)} onClick={() => { void save() }} icon={busy ? <LoaderCircle size={13} className="animate-spin" /> : undefined}>{t('common.save')}</Button>
  </>}>
    <div className="flex flex-col gap-3">
      {field(t('ssh.name'), <TextInput value={name} onChange={setName} ariaLabel={t('ssh.name')} />)}
      {field(t('ssh.mode'), <Segmented label={t('ssh.mode')} size="sm" value={mode} options={[{ value: 'manual', label: t('ssh.manual') }, { value: 'config', label: t('ssh.nativeConfig') }]} onChange={setMode} />)}
      {field(t(mode === 'config' ? 'ssh.alias' : 'ssh.host'), <TextInput value={host} onChange={setHost} ariaLabel={t(mode === 'config' ? 'ssh.alias' : 'ssh.host')} />)}
      {mode === 'manual' ? <>
        <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3">
          {field(t('ssh.username'), <TextInput value={username} onChange={setUsername} ariaLabel={t('ssh.username')} />)}
          {field(t('ssh.port'), <input type="number" min={1} max={65535} value={port} aria-label={t('ssh.port')} onChange={(event) => setPort(event.target.value)} className="h-8 min-w-0 rounded-[6px] border border-border bg-canvas px-2 text-[12px] text-fg" />)}
        </div>
        {field(t('ssh.identityFile'), filePicker(identity, setIdentity, t('ssh.identityFile')))}
        {field(t('ssh.proxyJump'), <TextInput value={proxyJump} onChange={setProxyJump} ariaLabel={t('ssh.proxyJump')} placeholder={t('ssh.optional')} />)}
      </> : field(t('ssh.configFile'), filePicker(configFile, setConfigFile, t('ssh.configFile')))}
      {field(t('ssh.platform'), <select value={platform} aria-label={t('ssh.platform')} onChange={(event) => setPlatform(event.target.value as ConnectionProfile['platform'])} className="h-8 min-w-0 rounded-[6px] border border-border bg-canvas px-2 text-[12px] text-fg">
        <option value="auto">{t('ssh.autoPlatform')}</option><option value="linux">Linux</option><option value="darwin">macOS</option><option value="win32">Windows</option>
      </select>)}
      {targetChange && <><p className="text-[12px] text-danger">{t('ssh.targetChange')}</p><label className="flex items-center gap-2 text-[12px] text-fg"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t('ssh.confirmTargetChange')}</label></>}
      {failure && <p role="alert" className="text-[12px] text-danger">{t(failure)}</p>}
    </div>
  </Dialog>
}