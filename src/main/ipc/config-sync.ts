import type { AppSettings } from '../../shared/domain/settings'
import type { McpServerConfig } from '../../shared/domain/mcp'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import type { SearchProviderConfig } from '../../shared/domain/search'
import type { Workspace } from '../../shared/domain/workspace'
import type { SyncPreview, SyncStatus } from '../../shared/domain/config-sync'
import * as repo from '../db/repo'
import { getHost } from '../runtime'
import { windows } from '../window/registry'

const API_ROOT = 'https://nextco.work/api/client/config-sync/v1'
let accountId: string | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let inFlight: Promise<void> | null = null

function status(): SyncStatus {
  const state = accountId === null ? undefined : repo.syncAccountState(accountId)
  return {
    enabled: state?.enabled === 1,
    accountId,
    deviceId: String(state?.device_id ?? repo.ensureSyncDeviceId()),
    running,
    pending: accountId === null ? 0 : repo.listPendingSyncMutations(accountId, 1000).length,
    conflicts: accountId === null ? 0 : repo.listSyncConflicts(accountId).length,
    lastSuccessAt: state?.last_success_at == null ? null : Number(state.last_success_at),
    lastError: state?.last_error == null ? null : String(state.last_error),
    needsInitialReview: state?.initial_sync_completed !== 1
  }
}

async function accessToken(): Promise<string | null> {
  return getHost().secrets.get('nextcowork:client-access-token')
}

async function request(path: string, init: RequestInit = {}): Promise<Response | null> {
  const token = await accessToken()
  if (!token) return null
  return getHost().fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
  }).catch(() => null)
}

async function push(): Promise<void> {
  if (accountId === null) return
  const pending = repo.listPendingSyncMutations(accountId, 50)
  if (pending.length === 0) return
  const response = await request('/push', { method: 'POST', body: JSON.stringify({ deviceId: pending[0]!.deviceId, mutations: pending }) })
  if (!response?.ok) { repo.failSyncMutations(accountId, pending.map((x) => x.mutationId), `HTTP ${response?.status ?? 0}`); return }
  const body = await response.json() as { accepted?: Array<{ mutationId: string }>; conflicts?: Array<Record<string, unknown>>; nextCursor?: number }
  for (const item of body.accepted ?? []) {
    repo.ackSyncMutation(accountId, item.mutationId)
    const source = pending.find((x) => x.mutationId === item.mutationId)
    const revision = Number((item as { serverRevision?: number }).serverRevision ?? 0)
    if (source && revision > 0) {
      repo.setSyncRevision(accountId, source.kind, source.entityId, revision)
      repo.rebasePendingSyncMutations(accountId, source.kind, source.entityId, revision, source.clientSeq)
    }
  }
  for (const c of body.conflicts ?? []) {
    repo.saveSyncConflict({ id: String(c.mutationId), kind: String(c.kind) as never, entityId: String(c.entityId), localRevision: Number(c.localRevision ?? 0), remoteRevision: Number(c.remoteRevision ?? 0), localPayload: c.localPayload, remotePayload: c.remotePayload, createdAt: Date.now() })
  }
  // Push's cursor is only a server watermark. Advancing the pull cursor here
  // could skip events created by another device between pull and push.
  if (typeof body.nextCursor === 'number') repo.updateSyncServerCursor(accountId, body.nextCursor)
}

function applyEvent(event: { kind: string; entityId: string; operation: string; payload: unknown; revision?: number }): void {
  const payload = event.payload as Record<string, unknown>
  if (event.kind === 'mcpServer' && (payload.workspaceId !== undefined || repo.getMcpServer(event.entityId)?.workspaceId !== undefined)) return
  repo.withSyncApply(() => {
    if (event.operation === 'delete' || payload.deleted === true) {
      if (event.kind === 'provider') repo.removeProvider(event.entityId)
      else if (event.kind === 'mcpServer') repo.removeMcpServer(event.entityId)
      else if (event.kind === 'searchProvider') {
        repo.removeSearchProvider(event.entityId as SearchProviderConfig['id'])
      }
      else if (event.kind === 'modelAlias') { const [provider, ...rest] = event.entityId.split('/'); repo.removeAlias(provider ?? '', rest.join('/')) }
      else if (event.kind === 'workspacePreferences') repo.removeWorkspace(event.entityId)
      return
    }
    if (event.kind === 'provider') {
      const existing = repo.listProviders().find((p) => p.id === event.entityId)
      // credentialRef is device-local and is deliberately absent from cloud payloads.
      repo.putProvider({ ...payload, credentialRef: existing?.credentialRef ?? `provider:${event.entityId}` } as unknown as UpstreamProvider)
    }
    else if (event.kind === 'modelAlias') repo.putAlias(payload as unknown as ModelAlias)
    else if (event.kind === 'mcpServer') repo.putMcpServer(payload as unknown as McpServerConfig)
    else if (event.kind === 'searchProvider') repo.putSearchProvider(payload as unknown as SearchProviderConfig)
    else if (event.kind === 'appPreferences' || event.kind === 'appPersonalization') {
      const patch = { ...payload }
      if (patch.data && typeof patch.data === 'object') {
        // backupDirectory is explicitly device-local; a cloud null must not erase it.
        const { backupDirectory: _ignored, ...data } = patch.data as Record<string, unknown>
        patch.data = data
      }
      if (event.kind === 'appPersonalization') repo.updateSettings({ personalization: patch } as unknown as Partial<AppSettings>)
      else repo.updateSettings(patch as Partial<AppSettings>)
    }
    else if (event.kind === 'workspacePreferences') {
      const existing = repo.getWorkspace(event.entityId)
      // A workspace without a local root cannot be materialized safely.
      if (existing && payload.settings && typeof payload.settings === 'object') {
        repo.putWorkspace({ ...existing, name: String(payload.name ?? existing.name), settings: payload.settings as Workspace['settings'] })
      }
    }
  })
  if (accountId !== null && event.revision) repo.setSyncRevision(accountId, event.kind, event.entityId, event.revision)
}

async function pull(): Promise<void> {
  if (accountId === null) return
  const state = repo.syncAccountState(accountId)
  const response = await request(`/pull?cursor=${encodeURIComponent(String(state?.last_pull_cursor ?? 0))}&limit=200`)
  if (!response) throw new Error('network unavailable')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as { cursor?: number; events?: Array<{ kind: string; entityId: string; operation: string; payload: unknown; revision?: number; deviceId?: string }> }
  const deviceId = String(repo.syncAccountState(accountId)?.device_id ?? '')
  for (const event of body.events ?? []) {
    const hasLocalPending = repo.listPendingSyncMutations(accountId, 100).some((m) => m.kind === event.kind && m.entityId === event.entityId)
    if (hasLocalPending) {
      // Leave the local value and outbox mutation intact. Push will either
      // accept it against the current revision or create an explicit conflict.
      continue
    }
    if (event.deviceId !== deviceId) applyEvent(event)
  }
  if (typeof body.cursor === 'number') repo.updateSyncCursor(accountId, body.cursor)
  windows.emitToAll('settings:changed', repo.getSettings())
  windows.emitToAll('provider:changed', { providers: repo.listProviders(), models: repo.listAliases() })
}

async function tick(): Promise<void> {
  if (inFlight !== null) return inFlight
  if (accountId !== null && repo.syncAccountState(accountId)?.initial_sync_completed !== 1) return
  inFlight = (async () => { await pull(); await push(); })().catch((error) => {
    if (accountId !== null) repo.updateSyncCursor(accountId, repo.syncAccountState(accountId)?.last_pull_cursor as number ?? 0, String(error))
  }).finally(() => {
    inFlight = null
    windows.emitToAll('configSync:changed', status())
  })
  return inFlight
}

export function startConfigSync(nextAccountId: string): void {
  stopConfigSync()
  accountId = nextAccountId
  repo.configureSyncAccount(nextAccountId, true)
  running = true
  timer = setInterval(() => { void tick().catch(() => undefined) }, 5000)
  timer.unref?.()
  void initializeInitialSync(nextAccountId)
  void tick()
  windows.emitToAll('configSync:changed', status())
}

async function initializeInitialSync(id: string): Promise<void> {
  const state = repo.syncAccountState(id)
  if (state?.initial_sync_completed === 1) return
  const response = await request('/preview')
  // A server that has not enabled the capability keeps the desktop in local
  // configuration mode and must not block normal use behind a review dialog.
  if (response?.status === 404) {
    repo.setInitialSyncCompleted(id, true)
    windows.emitToAll('configSync:changed', status())
  }
}

export function stopConfigSync(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  running = false
  accountId = null
  windows.emitToAll('configSync:changed', status())
}

/**
 * 退出专用。区别于 `stopConfigSync()`:那个要读库算出 `status()` 再推给窗口,
 * 而退出时库马上就要封、窗口也正在销毁 —— 这里只把表停掉,一步都不碰它们。
 */
export function shutdownConfigSync(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  running = false
}

export function getConfigSyncStatus(): SyncStatus { return status() }
export function getConfigSyncConflicts() { return accountId === null ? [] : repo.listSyncConflicts(accountId) }

export async function resolveConfigSyncConflict(id: string, useRemote: boolean): Promise<void> {
  if (accountId === null) return
  const conflict = repo.listSyncConflicts(accountId).find((item) => item.id === id)
  if (!conflict) throw new Error('conflict not found')
  const response = await request('/resolve', { method: 'POST', body: JSON.stringify({
    mutationId: crypto.randomUUID(), deviceId: repo.syncAccountState(accountId)?.device_id,
    clientSeq: Date.now(), kind: conflict.kind, entityId: conflict.entityId,
    baseRevision: conflict.remoteRevision, payload: useRemote ? conflict.remotePayload : conflict.localPayload
  })})
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 0}`)
  repo.markSyncConflictResolved(accountId, id)
  void tick()
}

export async function getConfigSyncPreview(): Promise<SyncPreview> {
  const response = await request('/preview')
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 0}`)
  return await response.json() as SyncPreview
}

export function confirmInitialConfigSync(): void {
  if (accountId === null) return
  repo.enqueueInitialSyncSnapshot(accountId)
  repo.setInitialSyncCompleted(accountId, true)
  void tick()
  windows.emitToAll('configSync:changed', status())
}
