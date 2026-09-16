import { z } from 'zod'

export const CONFIG_SYNC_VERSION = 2 as const
export const SYNC_CATEGORIES = ['providers', 'preferences', 'connections', 'extensions', 'workspaces', 'automation'] as const
export type SyncCategory = typeof SYNC_CATEGORIES[number]
export type SyncSelection = Record<SyncCategory, boolean>
export const DEFAULT_SYNC_SELECTION: SyncSelection = {
  providers: false, preferences: false, connections: false,
  extensions: false, workspaces: false, automation: false
}
export const SYNC_MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024
export const SYNC_RESOURCE_CHUNK_BYTES = 256 * 1024
export const SYNC_PASSWORD_MIN_LENGTH = 12

export const SYNC_ERRORS = ['signedOut', 'locked', 'password', 'invalidData', 'unsupported', 'network', 'conflict', 'storage', 'accountChanged', 'deviceRevoked', 'migrationRequired', 'bindingRequired', 'busy'] as const
export type SyncErrorCode = typeof SYNC_ERRORS[number]
export class ConfigSyncError extends Error {
  constructor(readonly code: SyncErrorCode) { super(`configSync.${code}`); this.name = 'ConfigSyncError' }
}

const base64 = (min: number, max: number) => z.string().max(Math.ceil(max / 3) * 4).refine((value) => {
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const size = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  return size >= min && size <= max
})
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const syncCipherSchema = z.object({
  nonce: base64(12, 12), tag: base64(16, 16), ciphertext: base64(1, SYNC_MAX_CIPHERTEXT_BYTES)
}).strict()
export type SyncCipher = z.infer<typeof syncCipherSchema>
export const syncKdfSchema = z.object({
  algorithm: z.literal('scrypt'), salt: base64(32, 32), n: z.literal(32768), r: z.literal(8), p: z.literal(1)
}).strict()
export const syncVaultSchema = z.object({
  version: z.literal(CONFIG_SYNC_VERSION), accountId: z.string().min(1).max(128), vaultId: z.uuid(),
  keyVersion: counter.positive(), wrappingVersion: counter.positive(), kdf: syncKdfSchema, wrappedKey: syncCipherSchema
}).strict()
export type SyncVault = z.infer<typeof syncVaultSchema>
export const syncVaultResponseSchema = z.object({ vault: syncVaultSchema.nullable(), legacyExists: z.boolean(), migrationRequired: z.boolean() }).strict()
export const syncEnvelopeSchema = z.object({
  version: z.literal(CONFIG_SYNC_VERSION), vaultId: z.uuid(), keyVersion: counter.positive(),
  kind: z.enum(SYNC_CATEGORIES), entityId: z.string().regex(/^[a-f0-9]{64}$/), mutationId: z.uuid(),
  operation: z.enum(['upsert', 'delete']), payload: syncCipherSchema, baseRevision: counter
}).strict()
export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>
export const syncEventSchema = syncEnvelopeSchema.extend({
  revision: counter.positive(), cursor: counter.positive(), deviceId: z.string().min(1).max(128)
}).strict()
export type SyncEvent = z.infer<typeof syncEventSchema>
export const syncPullSchema = z.object({ cursor: counter, hasMore: z.boolean(), events: z.array(syncEventSchema).max(100) }).strict()
export const syncPushSchema = z.object({
  accepted: z.array(z.object({ mutationId: z.uuid(), revision: counter.positive() }).strict()).max(6),
  conflicts: z.array(z.object({ mutationId: z.uuid(), remote: syncEventSchema.nullable() }).strict()).max(6)
}).strict()
export type SyncPushResult = z.infer<typeof syncPushSchema>
export const syncSelectionSchema = z.object({
  providers: z.boolean(), preferences: z.boolean(), connections: z.boolean(), extensions: z.boolean(), workspaces: z.boolean(), automation: z.boolean()
}).strict()
export const syncDocumentSchema = z.object({
  version: z.literal(CONFIG_SYNC_VERSION), kind: z.enum(SYNC_CATEGORIES), data: z.unknown()
}).strict()
export type SyncDocument = z.infer<typeof syncDocumentSchema>
export const syncDevicesSchema = z.object({ items: z.array(z.object({ deviceId: z.string().min(1).max(128), current: z.boolean(), revoked: z.boolean(), lastSeenAt: z.string().max(64) }).strict()).max(100) }).strict()
export type SyncDevice = z.infer<typeof syncDevicesSchema>['items'][number]
export const syncResourceResponseSchema = z.object({ keyVersion: counter.positive(), payload: syncCipherSchema }).strict()
export const syncPreviewResponseSchema = z.object({ events: z.array(syncEventSchema).max(6) }).strict()
export const syncResourceFileSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), size: counter.max(16 * 1024 * 1024),
  chunks: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64)
}).strict()
export type SyncResourceFile = z.infer<typeof syncResourceFileSchema>
export interface SyncSetupRequest { password: string; remember: boolean }
export interface SyncConfigureRequest { selection: SyncSelection; importLocal: boolean; prefer: 'local' | 'remote' }
export interface SyncPasswordChange { password: string; revokeOtherDevices: boolean }
export interface SyncBinding { kind: 'workspace' | 'extension' | 'automation' | 'connection'; id: string; name: string }
export interface SyncControlState {
  phase: 'signedOut' | 'off' | 'passwordRequired' | 'locked' | 'review' | 'ready' | 'syncing' | 'error' | 'unsupported'
  selection: SyncSelection
  vaultConfigured: boolean
  remembered: boolean
  errorCode: SyncErrorCode | null
  bindings: SyncBinding[]
}

/** Legacy types remain readable only for explicit migration; v2 never sends their payloads. */
export type SyncConfigKind =
  | 'provider'
  | 'modelAlias'
  | 'mcpServer'
  | 'searchProvider'
  | 'appPersonalization'
  | 'appPreferences'
  | 'workspacePreferences'

export interface SyncMutation {
  mutationId: string
  accountId: string
  deviceId: string
  clientSeq: number
  kind: SyncConfigKind
  entityId: string
  operation: 'upsert' | 'delete' | 'resolve'
  payload: unknown
  baseRevision: number
  workspaceId?: string
}

export interface SyncConflict {
  id: string
  kind: SyncConfigKind
  entityId: string
  localRevision: number
  remoteRevision: number
  localPayload: unknown
  remotePayload: unknown
  status: 'pending' | 'resolved'
  createdAt: number
}

export interface SyncStatus {
  enabled: boolean
  accountId: string | null
  deviceId: string
  running: boolean
  pending: number
  conflicts: number
  lastSuccessAt: number | null
  lastError: string | null
  needsInitialReview: boolean
  control?: SyncControlState
}

export interface SyncPreview {
  items: Array<{ kind: SyncConfigKind; entityId: string; revision: number; updatedAt: string; updatedByDeviceId: string }>
  count: number
}
