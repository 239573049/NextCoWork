import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigSyncError, syncVaultResponseSchema } from '../../shared/domain/config-sync'
import { nodeHost } from '../kernel/host'
import { SYNC_HTTP_MAX_BYTES, syncRequest, type SyncRequestContext } from '../config-sync-http'

async function context(fetch: typeof globalThis.fetch): Promise<SyncRequestContext> {
  const host = nodeHost({ fetch })
  await host.secrets.set('nextcowork:client-access-token', 'test-account-token')
  return { host, accountId: 'a', assertCurrent: () => {}, signal: new AbortController().signal, deviceId: 'device', deviceToken: '', vault: null }
}
describe('v2 synchronization transport', () => {
  it('uses only v2, validates responses, and does not silently downgrade', async () => {
    const ctx = await context(async (url, init) => {
      expect(url).toBe('https://nextco.work/api/client/config-sync/v2/vault')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-account-token')
      expect(init?.redirect).toBe('error')
      return Response.json({ vault: null, legacyExists: false, migrationRequired: false })
    })
    expect(await syncRequest(ctx, '/vault', syncVaultResponseSchema, undefined, false)).toEqual({ vault: null, legacyExists: false, migrationRequired: false })
    ctx.host.fetch = async () => new Response('missing', { status: 404 })
    await expect(syncRequest(ctx, '/vault', syncVaultResponseSchema, undefined, false)).rejects.toThrow('configSync.unsupported')
  })
  it('does not return server exception details or malformed success bodies', async () => {
    const ctx = await context(async () => Response.json({ error: 'secret database connection string' }, { status: 500 }))
    await expect(syncRequest(ctx, '/vault', syncVaultResponseSchema, undefined, false)).rejects.toThrow('configSync.network')
    ctx.host.fetch = async () => Response.json({ vault: null, legacyExists: false, migrationRequired: false, plaintext: 'unexpected' })
    await expect(syncRequest(ctx, '/vault', syncVaultResponseSchema, undefined, false)).rejects.toThrow('configSync.invalidData')
  })
  it('rejects an old account response before parsing or returning it', async () => {
    let current = true
    const ctx = await context(async () => { current = false; return Response.json({ ok: true }) })
    ctx.assertCurrent = () => { if (!current) throw new ConfigSyncError('accountChanged') }
    await expect(syncRequest(ctx, '/vault', z.unknown(), undefined, false)).rejects.toThrow('configSync.accountChanged')
  })
  it('rejects requests without a password-unlocked device credential', async () => {
    const ctx = await context(async () => { throw new Error('must not fetch') })
    await expect(syncRequest(ctx, '/push', z.unknown(), { mutations: [] })).rejects.toThrow('configSync.locked')
  })
  it('bounds announced and streamed response sizes', async () => {
    const ctx = await context(async () => new Response('{}', { headers: { 'content-length': String(SYNC_HTTP_MAX_BYTES + 1) } }))
    await expect(syncRequest(ctx, '/vault', z.unknown(), undefined, false)).rejects.toThrow('configSync.invalidData')
    ctx.host.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SYNC_HTTP_MAX_BYTES + 1)); controller.close() } }))
    await expect(syncRequest(ctx, '/vault', z.unknown(), undefined, false)).rejects.toThrow('configSync.invalidData')
  })
})
