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
}

export interface SyncPreview {
  items: Array<{ kind: SyncConfigKind; entityId: string; revision: number; updatedAt: string; updatedByDeviceId: string }>
  count: number
}
