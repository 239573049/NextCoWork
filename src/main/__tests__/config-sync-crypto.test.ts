import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nodeHost } from '../kernel/host'
import { SyncKeyring, decryptSyncDocument, decryptSyncResource, encryptSyncDocument, encryptSyncResource, syncDigest, unwrapSyncKey, wrapSyncKey } from '../config-sync-crypto'

const password = 'long sync password 2026'
describe('account-bound configuration encryption', () => {
  it('wraps a random key, authenticates the password and account', async () => {
    const key = randomBytes(32)
    const vault = await wrapSyncKey('account-a', password, key)
    expect(await unwrapSyncKey('account-a', password, vault)).toEqual(key)
    await expect(unwrapSyncKey('account-a', 'wrong long password', vault)).rejects.toThrow('configSync.password')
    await expect(unwrapSyncKey('account-b', password, vault)).rejects.toThrow('configSync.invalidData')
    await expect(unwrapSyncKey('account-a', password, { ...vault, kdf: { ...vault.kdf, n: 2 ** 30 } })).rejects.toThrow('configSync.invalidData')
  })
  it('changes salt and wrapping without changing the data key', async () => {
    const key = randomBytes(32)
    const first = await wrapSyncKey('a', password, key)
    const next = await wrapSyncKey('a', 'a new long password', key, first)
    expect(next.vaultId).toBe(first.vaultId)
    expect(next.keyVersion).toBe(first.keyVersion)
    expect(next.wrappingVersion).toBe(first.wrappingVersion + 1)
    expect(next.kdf.salt).not.toBe(first.kdf.salt)
    expect(await unwrapSyncKey('a', 'a new long password', next)).toEqual(key)
  })
  it('authenticates record identity, operation, revision and ciphertext', async () => {
    const key = randomBytes(32)
    const vault = await wrapSyncKey('a', password, key)
    const doc = { version: 2 as const, kind: 'providers' as const, data: { secret: 'never plaintext on wire', models: ['m'] } }
    const envelope = encryptSyncDocument(key, vault, doc, 3)
    expect(JSON.stringify(envelope)).not.toContain('never plaintext')
    expect(decryptSyncDocument(key, vault, envelope)).toEqual(doc)
    expect(encryptSyncDocument(key, vault, doc, 3).payload.nonce).not.toBe(envelope.payload.nonce)
    for (const bad of [{ ...envelope, baseRevision: 4 }, { ...envelope, operation: 'delete' as const }, { ...envelope, kind: 'preferences' as const }, { ...envelope, payload: { ...envelope.payload, tag: Buffer.alloc(16).toString('base64') } }]) {
      expect(() => decryptSyncDocument(key, vault, bad)).toThrow('configSync.invalidData')
    }
    expect(() => decryptSyncDocument(key, { ...vault, accountId: 'b' }, envelope)).toThrow()
  })
  it('round-trips resource chunks and uses keyed fingerprints', async () => {
    const key = randomBytes(32)
    const vault = await wrapSyncKey('a', password, key)
    const bytes = Buffer.from('resource bytes')
    const chunk = encryptSyncResource(key, vault, bytes)
    expect(decryptSyncResource(key, vault, chunk.id, chunk.payload)).toEqual(bytes)
    expect(() => decryptSyncResource(key, vault, '0'.repeat(64), chunk.payload)).toThrow()
    expect(syncDigest(key, { b: 2, a: 1 })).toBe(syncDigest(key, { a: 1, b: 2 }))
    expect(syncDigest(randomBytes(32), { a: 1 })).not.toBe(syncDigest(key, { a: 1 }))
  })
  it('locks and restores only the exact remembered account/key version', async () => {
    const secrets = nodeHost().secrets
    const ring = new SyncKeyring(secrets)
    const key = randomBytes(32)
    const vault = await wrapSyncKey('a', password, key)
    await ring.set(vault, key, true)
    expect(ring.get(vault)).toEqual(key)
    const borrowed = ring.get(vault)
    await ring.set(vault, borrowed, true)
    borrowed.fill(0)
    expect(ring.get(vault)).toEqual(key)
    ring.lock()
    expect(() => ring.get(vault)).toThrow('configSync.locked')
    expect(await ring.restore({ ...vault, accountId: 'b' })).toBe(false)
    expect(await ring.restore({ ...vault, wrappingVersion: 2 })).toBe(false)
    expect(await ring.restore(vault)).toBe(true)
    const broken = new SyncKeyring({ ...secrets, get: async () => { throw new Error('keychain unavailable') } })
    expect(await broken.restore(vault)).toBe(false)
    await ring.forget('a')
    expect(await ring.restore(vault)).toBe(false)
    const unavailable = new SyncKeyring({ ...secrets, available: () => false })
    await expect(unavailable.set(vault, key, true)).rejects.toThrow('configSync.storage')
    await unavailable.set(vault, key, false)
    expect(unavailable.get(vault)).toEqual(key)
  })
})
