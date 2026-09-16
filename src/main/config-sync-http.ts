import type { z } from 'zod'
import type { KernelHost } from './kernel/host'
import { ConfigSyncError, SYNC_ERRORS, type SyncErrorCode, type SyncVault } from '../shared/domain/config-sync'
import { SYNC_ORIGIN } from './config-sync-crypto'

export const SYNC_HTTP_MAX_BYTES = 16 * 1024 * 1024
const SYNC_ROTATION_MAX_BYTES = 72 * 1024 * 1024
export interface SyncRequestContext {
  host: KernelHost
  accountId: string
  signal: AbortSignal
  assertCurrent: () => void
  deviceId: string
  deviceToken: string
  vault: SyncVault | null
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SYNC_HTTP_MAX_BYTES)) throw new ConfigSyncError('invalidData')
  if (response.body === null) throw new ConfigSyncError('invalidData')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > SYNC_HTTP_MAX_BYTES) throw new ConfigSyncError('invalidData')
      parts.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown
  } catch { throw new ConfigSyncError('invalidData') }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** A context captures the account generation, never reads a later account's credentials. */
export async function syncRequest<T>(context: SyncRequestContext, path: string, schema: z.ZodType<T>, body?: unknown, deviceAuth = true): Promise<T> {
  if (!path.startsWith('/') || path.includes('://') || path.includes('..')) throw new ConfigSyncError('invalidData')
  context.assertCurrent()
  const token = await context.host.secrets.get('nextcowork:client-access-token')
  context.assertCurrent()
  if (!token) throw new ConfigSyncError('signedOut')
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'User-Agent': 'NextCoWork/desktop', Accept: 'application/json' }
  if (deviceAuth) {
    const vault = context.vault
    if (vault === null || vault.accountId !== context.accountId || !context.deviceToken) throw new ConfigSyncError('locked')
    Object.assign(headers, { 'x-sync-device-id': context.deviceId, 'x-sync-device-token': context.deviceToken, 'x-sync-vault-id': vault.vaultId, 'x-sync-key-version': String(vault.keyVersion) })
  }
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  if (serialized !== undefined) {
    const limit = path === '/vault/rotate' ? SYNC_ROTATION_MAX_BYTES : SYNC_HTTP_MAX_BYTES
    if (Buffer.byteLength(serialized) > limit) throw new ConfigSyncError('invalidData')
    headers['Content-Type'] = 'application/json'
  }
  try {
    const response = await context.host.fetch(`${SYNC_ORIGIN}/api/client/config-sync/v2${path}`, { method: serialized === undefined ? 'GET' : 'POST', headers, body: serialized, signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]), redirect: 'error' })
    context.assertCurrent()
    if (!response.ok) {
      let code: SyncErrorCode = response.status === 404 ? 'unsupported' : response.status === 401 ? 'signedOut' : response.status === 403 ? 'deviceRevoked' : response.status === 409 ? 'conflict' : response.status === 400 || response.status === 413 ? 'invalidData' : 'network'
      try {
        const value = await boundedJson(response)
        if (typeof value === 'object' && value !== null && 'error' in value && SYNC_ERRORS.includes(value.error as SyncErrorCode)) code = value.error as SyncErrorCode
      } catch { /* Raw server errors may contain sensitive details; never propagate them. */ }
      context.assertCurrent()
      throw new ConfigSyncError(code)
    }
    const result = schema.safeParse(await boundedJson(response))
    context.assertCurrent()
    if (!result.success) throw new ConfigSyncError('invalidData')
    return result.data
  } catch (error) {
    context.assertCurrent()
    if (error instanceof ConfigSyncError) throw error
    throw new ConfigSyncError('network')
  }
}
