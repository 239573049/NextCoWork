/**
 * 配置/会话导出、备份和清理共用的领域类型与纯校验函数。
 *
 * 这些类型刻意不包含 Electron、SQLite 或文件系统对象，方便主进程单测和
 * 渲染层预览共用。敏感凭证只允许出现在 encryptedCredentials 字段中，普通
 * JSON 的类型里没有明文凭证字段。
 */
import type { AgentMessage } from '../agent/message'
import type { ModelAlias, UpstreamProvider } from './provider'
import type { AppSettings } from './settings'
import type { SearchProviderConfig } from './search'
import type { Session } from './session'
import type { Workspace } from './workspace'
import type { McpServerConfig } from './mcp'

export const DATA_EXPORT_TYPE = 'nextcowork-data-export' as const
export const DATA_EXPORT_VERSION = 1
export const BACKUP_FORMAT_VERSION = 1

export interface ExportSession {
  session: Session
  messages: AgentMessage[]
}

export interface DataExport {
  type: typeof DATA_EXPORT_TYPE
  version: number
  exportedAt: string
  settings: AppSettings
  workspaces: Workspace[]
  sessions: ExportSession[]
  providers: UpstreamProvider[]
  aliases: ModelAlias[]
  mcpServers: McpServerConfig[]
  searchProviders: SearchProviderConfig[]
  /** IDs of globally disabled skills; skill files themselves are never exported. */
  disabledSkillIds: string[]
  /** Workspace-local skill selection is already part of each Workspace. */
  encryptedCredentials?: EncryptedCredentials
}

export interface EncryptedCredentials {
  algorithm: 'scrypt-aes-256-gcm'
  salt: string
  nonce: string
  tag: string
  /** base64-encoded encrypted JSON map */
  ciphertext: string
}

export interface BackupManifest {
  format: 'nextcowork-backup'
  formatVersion: number
  appVersion: string
  createdAt: number
  /** SQLite PRAGMA user_version，用于阻止把未来版本数据库直接替换进来。 */
  schemaVersion: number
  databaseSha256: string
  sessionCount: number
  messageCount: number
  encryptedCredentials: boolean
}

export interface BackupStatus {
  directory: string | null
  lastBackupAt: number | null
  lastBackupPath: string | null
  lastError: string | null
  running: boolean
}

export interface ImportPreview {
  path: string
  version: number
  workspaceCount: number
  sessionCount: number
  messageCount: number
  providerCount: number
  aliasCount: number
  mcpServerCount: number
  skippedCount: number
  overwriteCount: number
  newCount: number
  hasEncryptedCredentials: boolean
}

export interface ImportApplyResult {
  imported: number
  overwritten: number
  skipped: number
  settingsImported: boolean
  workspacesImported: number
  sessionsImported: number
  messagesImported: number
}

export interface RestorePreview {
  path: string
  manifest: BackupManifest
  sessionCount: number
  messageCount: number
  settingsIncluded: boolean
}

export interface RestoreResult {
  restored: boolean
  preview?: RestorePreview
  backupStatus?: BackupStatus
}

export interface CleanupPreview {
  kind: 'attachments' | 'age' | 'history' | 'local-data'
  sessionCount: number
  messageCount: number
  attachmentCount: number
  bytes: number
  undeletable: string[]
}

export interface CleanupResult extends CleanupPreview {
  deleted: number
}

export type CleanupAge = 3 | 6 | 12

/** 截止时间：当前时刻往前 N 个月，按日历月而不是固定 90 天。 */
export function cutoffForAge(now: number, months: CleanupAge): number {
  const date = new Date(now)
  date.setMonth(date.getMonth() - months)
  return date.getTime()
}

/** 对可导出的 JSON 进行最小但严格的 schema 检查。 */
export function isDataExport(value: unknown): value is DataExport {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.type === DATA_EXPORT_TYPE &&
    typeof v.version === 'number' &&
    v.version >= 1 &&
    typeof v.exportedAt === 'string' &&
    isRecord(v.settings) &&
    Array.isArray(v.workspaces) &&
    Array.isArray(v.sessions) &&
    Array.isArray(v.providers) &&
    Array.isArray(v.aliases) &&
    Array.isArray(v.mcpServers) &&
    Array.isArray(v.searchProviders) &&
    Array.isArray(v.disabledSkillIds) &&
    v.disabledSkillIds.every((id) => typeof id === 'string') &&
    (v.encryptedCredentials === undefined || isEncryptedCredentials(v.encryptedCredentials))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  if (!isRecord(value)) return false
  return (
    value.algorithm === 'scrypt-aes-256-gcm' &&
    typeof value.salt === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.ciphertext === 'string'
  )
}
