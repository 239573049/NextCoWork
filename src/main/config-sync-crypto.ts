import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto'
import type { KernelHost } from './kernel/host'
import { ConfigSyncError, SYNC_MAX_CIPHERTEXT_BYTES, SYNC_RESOURCE_CHUNK_BYTES, SYNC_PASSWORD_MIN_LENGTH, syncCipherSchema, syncDocumentSchema, syncEnvelopeSchema, syncVaultSchema, type SyncCategory, type SyncCipher, type SyncDocument, type SyncEnvelope, type SyncVault } from '../shared/domain/config-sync'

export const SYNC_ORIGIN = 'https://nextco.work'
const aad = (...parts: unknown[]): Buffer => Buffer.from(JSON.stringify(['nextcowork-config-sync', SYNC_ORIGIN, ...parts]))

function seal(key: Buffer, bytes: Buffer, associated: Buffer): SyncCipher {
  if (key.length !== 32 || bytes.length === 0 || bytes.length > SYNC_MAX_CIPHERTEXT_BYTES) throw new ConfigSyncError('invalidData')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associated)
  return { nonce: nonce.toString('base64'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}
function open(key: Buffer, value: SyncCipher, associated: Buffer): Buffer {
  if (key.length !== 32 || !syncCipherSchema.safeParse(value).success) throw new ConfigSyncError('invalidData')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'))
    decipher.setAAD(associated)
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()])
  } catch { throw new ConfigSyncError('invalidData') }
}
function derive(password: string, vault: SyncVault): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < SYNC_PASSWORD_MIN_LENGTH || Buffer.byteLength(password) > 1024) throw new ConfigSyncError('password')
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(vault.kdf.salt, 'base64'), 32, { N: vault.kdf.n, r: vault.kdf.r, p: vault.kdf.p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(new ConfigSyncError('password')); else resolve(key)
    })
  })
}
const wrapAad = (vault: SyncVault): Buffer => aad('key', vault.version, vault.accountId, vault.vaultId, vault.keyVersion, vault.wrappingVersion, vault.kdf.algorithm, vault.kdf.salt, vault.kdf.n, vault.kdf.r, vault.kdf.p)

export async function wrapSyncKey(accountId: string, password: string, key: Buffer, previous?: SyncVault, rotate = false): Promise<SyncVault> {
  if (previous !== undefined && previous.accountId !== accountId) throw new ConfigSyncError('accountChanged')
  const vault: SyncVault = {
    version: 2, accountId, vaultId: previous?.vaultId ?? randomUUID(), keyVersion: (previous?.keyVersion ?? 1) + (rotate ? 1 : 0),
    wrappingVersion: (previous?.wrappingVersion ?? 0) + 1,
    kdf: { algorithm: 'scrypt', salt: randomBytes(32).toString('base64'), n: 32768, r: 8, p: 1 },
    wrappedKey: { nonce: '', tag: '', ciphertext: '' }
  }
  const kek = await derive(password, vault)
  try { vault.wrappedKey = seal(kek, key, wrapAad(vault)); return syncVaultSchema.parse(vault) }
  finally { kek.fill(0) }
}
export async function unwrapSyncKey(accountId: string, password: string, input: unknown): Promise<Buffer> {
  const parsed = syncVaultSchema.safeParse(input)
  if (!parsed.success || parsed.data.accountId !== accountId) throw new ConfigSyncError('invalidData')
  const vault = parsed.data
  const kek = await derive(password, vault)
  try {
    const key = open(kek, vault.wrappedKey, wrapAad(vault))
    if (key.length !== 32) { key.fill(0); throw new ConfigSyncError('password') }
    return key
  } catch { throw new ConfigSyncError('password') }
  finally { kek.fill(0) }
}

/** Stable JSON is used only inside a keyed digest; never persist a plaintext secret hash. */
export function canonicalSyncJson(value: unknown): string {
  const normalize = (item: unknown, depth: number): unknown => {
    if (depth > 64) throw new ConfigSyncError('invalidData')
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, depth + 1))
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, normalize(v, depth + 1)]))
    return item
  }
  const result = JSON.stringify(normalize(value, 0))
  if (result === undefined || Buffer.byteLength(result) > SYNC_MAX_CIPHERTEXT_BYTES) throw new ConfigSyncError('invalidData')
  return result
}
export function syncDigest(key: Buffer, value: unknown): string { return createHmac('sha256', key).update(aad('digest')).update(canonicalSyncJson(value)).digest('hex') }
export function syncAuthKey(key: Buffer, vault: SyncVault): string { return createHmac('sha256', key).update(aad('device-enrollment', vault.accountId, vault.vaultId, vault.keyVersion)).digest('base64') }
export function syncEntityId(key: Buffer, vault: SyncVault, kind: SyncCategory): string { return createHmac('sha256', key).update(aad('identity', vault.accountId, vault.vaultId, kind)).digest('hex') }
const eventAad = (vault: SyncVault, event: Omit<SyncEnvelope, 'payload'>): Buffer => aad('document', vault.accountId, event.version, event.vaultId, event.keyVersion, event.kind, event.entityId, event.mutationId, event.operation, event.baseRevision)

export function encryptSyncDocument(key: Buffer, vault: SyncVault, document: SyncDocument, baseRevision: number): SyncEnvelope {
  const meta: Omit<SyncEnvelope, 'payload'> = { version: 2, vaultId: vault.vaultId, keyVersion: vault.keyVersion, kind: document.kind, entityId: syncEntityId(key, vault, document.kind), mutationId: randomUUID(), operation: 'upsert', baseRevision }
  const bytes = Buffer.from(canonicalSyncJson(syncDocumentSchema.parse(document)))
  try { return syncEnvelopeSchema.parse({ ...meta, payload: seal(key, bytes, eventAad(vault, meta)) }) }
  finally { bytes.fill(0) }
}
export function decryptSyncDocument(key: Buffer, vault: SyncVault, input: SyncEnvelope): SyncDocument {
  // Events also contain server metadata; authenticate only the immutable envelope fields.
  const { revision: _revision, cursor: _cursor, deviceId: _device, ...envelope } = input as SyncEnvelope & { revision?: number; cursor?: number; deviceId?: string }
  const parsed = syncEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) throw new ConfigSyncError('invalidData')
  const event = parsed.data
  if (event.vaultId !== vault.vaultId || event.keyVersion !== vault.keyVersion || event.entityId !== syncEntityId(key, vault, event.kind)) throw new ConfigSyncError('invalidData')
  const bytes = open(key, event.payload, eventAad(vault, event))
  try {
    const result = syncDocumentSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (!result.success || result.data.kind !== event.kind) throw new ConfigSyncError('invalidData')
    return result.data
  } catch { throw new ConfigSyncError('invalidData') }
  finally { bytes.fill(0) }
}
export function encryptSyncResource(key: Buffer, vault: SyncVault, bytes: Buffer): { id: string; payload: SyncCipher } {
  if (bytes.length > SYNC_RESOURCE_CHUNK_BYTES) throw new ConfigSyncError('invalidData')
  const id = createHmac('sha256', key).update(aad('resource-id', vault.accountId, vault.vaultId)).update(bytes).digest('hex')
  return { id, payload: seal(key, bytes, aad('resource', vault.accountId, vault.vaultId, vault.keyVersion, id)) }
}
export function decryptSyncResource(key: Buffer, vault: SyncVault, id: string, payload: SyncCipher): Buffer {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ConfigSyncError('invalidData')
  const bytes = open(key, payload, aad('resource', vault.accountId, vault.vaultId, vault.keyVersion, id))
  const expected = createHmac('sha256', key).update(aad('resource-id', vault.accountId, vault.vaultId)).update(bytes).digest('hex')
  if (expected !== id) { bytes.fill(0); throw new ConfigSyncError('invalidData') }
  return bytes
}

export class SyncKeyring {
  private key: Buffer | null = null
  private identity: string | null = null
  private generation = 0
  constructor(private readonly secrets: KernelHost['secrets']) {}
  private ref(account: string): string { return `config-sync:key:${Buffer.from(`${SYNC_ORIGIN}/${account}`).toString('base64url')}` }
  private id(vault: SyncVault): string { return `${vault.accountId}/${vault.vaultId}/${vault.keyVersion}/${vault.wrappingVersion}` }
  lock(): void { this.generation++; this.key?.fill(0); this.key = null; this.identity = null }
  get(vault: SyncVault): Buffer {
    if (this.key === null || this.identity !== this.id(vault)) throw new ConfigSyncError('locked')
    return Buffer.from(this.key)
  }
  async set(vault: SyncVault, key: Buffer, remember: boolean): Promise<void> {
    if (key.length !== 32) throw new ConfigSyncError('invalidData')
    const copy = Buffer.from(key)
    const generation = this.generation
    try {
      if (remember) {
        if (!this.secrets.available?.()) throw new ConfigSyncError('storage')
        await this.secrets.set(this.ref(vault.accountId), JSON.stringify({ identity: this.id(vault), key: copy.toString('base64') }))
      } else await this.secrets.remove?.(this.ref(vault.accountId))
      if (generation !== this.generation) throw new ConfigSyncError('accountChanged')
      this.lock(); this.key = Buffer.from(copy); this.identity = this.id(vault)
    } finally { copy.fill(0) }
  }
  async restore(vault: SyncVault): Promise<boolean> {
    const generation = this.generation
    try {
      const raw = await this.secrets.get(this.ref(vault.accountId))
      if (raw === null || generation !== this.generation) return false
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) return false
      const saved = value as Record<string, unknown>
      if (saved.identity !== this.id(vault) || typeof saved.key !== 'string') return false
      const key = Buffer.from(saved.key, 'base64')
      try { if (key.length !== 32) return false; this.lock(); this.key = Buffer.from(key); this.identity = this.id(vault); return true }
      finally { key.fill(0) }
    } catch { return false }
  }
  async forget(account: string): Promise<void> { this.lock(); await this.secrets.remove?.(this.ref(account)) }
}
