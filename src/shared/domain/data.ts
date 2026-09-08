/**
 * 配置/会话导出、备份和清理共用的领域类型与纯校验函数。
 *
 * 这些类型刻意不包含 Electron、SQLite 或文件系统对象，方便主进程单测和
 * 渲染层预览共用。敏感凭证只允许出现在 encryptedCredentials 字段中，普通
 * JSON 的类型里没有明文凭证字段。
 */
import type { AgentMessage } from '../agent/message'
import type { ContextCheckpoint } from '../agent/context-management'
import type { ModelAlias, UpstreamProvider } from './provider'
import { isModelCatalogOverride } from './provider'
import type { AppSettings } from './settings'
import type { SearchProviderConfig } from './search'
import type { Session } from './session'
import type { Workspace } from './workspace'
import type { McpServerConfig } from './mcp'
import { PERMISSION_MODES } from '../agent/permission'
import { SESSION_MODES, THINKING_LEVELS } from '../agent/run-request'
import { PROXY_SCHEMES } from './proxy'

export const DATA_EXPORT_TYPE = 'nextcowork-data-export' as const
export const DATA_EXPORT_VERSION = 1
export const BACKUP_FORMAT_VERSION = 1

export interface ExportSession {
  session: Session
  messages: AgentMessage[]
  /** Optional for exports produced before context management was added. */
  contextCheckpoints?: ContextCheckpoint[]
}

export interface DataExport {
  type: typeof DATA_EXPORT_TYPE
  version: number
  /** ISO string in current exports; numeric timestamps are accepted from legacy exports. */
  exportedAt: string | number
  /** Legacy database schema marker, retained for import compatibility. */
  schemaVersion?: number
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
  encryptedCredentials?: EncryptedCredentials | boolean
  /** Legacy user supplied model catalogue, ignored by current import code. */
  userModelCatalog?: unknown
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

/**
 * Decide how one imported record should be merged with the local record.
 *
 * The export format intentionally keeps `updatedAt` optional for records that
 * predate the timestamp field.  When either side cannot provide a finite
 * timestamp, the safe rule is to keep the local value.  Keeping this decision
 * in the shared domain layer makes the preview counts and the SQLite merge
 * use exactly the same conflict semantics.
 */
export type DataMergeDecision = 'new' | 'overwrite' | 'skip'

export function dataMergeDecision(local: unknown, incoming: unknown): DataMergeDecision {
  if (local === undefined) return 'new'
  const localAt = typeof local === 'object' && local !== null
    ? (local as Record<string, unknown>)['updatedAt']
    : undefined
  const incomingAt = typeof incoming === 'object' && incoming !== null
    ? (incoming as Record<string, unknown>)['updatedAt']
    : undefined
  if (
    typeof localAt === 'number' && Number.isFinite(localAt) &&
    typeof incomingAt === 'number' && Number.isFinite(incomingAt) &&
    incomingAt > localAt
  ) return 'overwrite'
  return 'skip'
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
  const day = date.getDate()
  // Move through day 1 first. Native Date#setMonth overflows at month ends
  // (May 31 - 3 months becomes March 3), which would delete several extra
  // days. Clamp back to the last real day of the target calendar month.
  date.setDate(1)
  date.setMonth(date.getMonth() - months)
  const lastDay = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  ).getDate()
  date.setDate(Math.min(day, lastDay))
  return date.getTime()
}

/** 对可导出的 JSON 进行结构化 schema 检查。 */
export function isDataExport(value: unknown): value is DataExport {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (
    v.type !== DATA_EXPORT_TYPE ||
    !isIntegerAtLeast(v.version, 1) ||
    !((typeof v.exportedAt === 'string' && Number.isFinite(Date.parse(v.exportedAt))) ||
      (typeof v.exportedAt === 'number' && Number.isFinite(v.exportedAt))) ||
    !isAppSettings(v.settings) ||
    !Array.isArray(v.workspaces) ||
    !Array.isArray(v.sessions) ||
    !Array.isArray(v.providers) ||
    !Array.isArray(v.aliases) ||
    !Array.isArray(v.mcpServers) ||
    !Array.isArray(v.searchProviders) ||
    !Array.isArray(v.disabledSkillIds) ||
    !v.disabledSkillIds.every(isNonEmptyString) ||
    (v.encryptedCredentials !== undefined &&
      typeof v.encryptedCredentials !== 'boolean' && !isEncryptedCredentials(v.encryptedCredentials))
  ) return false

  // Duplicate primary keys make a merge order-dependent. Reject them before
  // anything reaches SQLite, while still allowing unknown future fields on
  // each record.
  const workspaces = v.workspaces as unknown[]
  const sessions = v.sessions as unknown[]
  const providers = v.providers as unknown[]
  const aliases = v.aliases as unknown[]
  const mcpServers = v.mcpServers as unknown[]
  const searchProviders = v.searchProviders as unknown[]
  if (!workspaces.every(isWorkspace) || !uniqueBy(workspaces, (x) => (x as Workspace).id)) return false
  if (!sessions.every(isExportSession) || !uniqueBy(sessions, (x) => (x as { session: Session }).session.id)) return false
  if (!providers.every(isProvider) || !uniqueBy(providers, (x) => (x as UpstreamProvider).id)) return false
  if (!aliases.every(isModelAlias) || !uniqueBy(aliases, (x) => `${(x as ModelAlias).providerId}\u0000${(x as ModelAlias).alias}`)) return false
  if (!mcpServers.every(isMcpServer) || !uniqueBy(mcpServers, (x) => (x as McpServerConfig).id)) return false
  if (!searchProviders.every(isSearchProvider) || !uniqueBy(searchProviders, (x) => (x as SearchProviderConfig).id)) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return !has(value, key) || typeof value[key] === 'string'
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return !has(value, key) || isBoolean(value[key])
}

function optionalIntegerAtLeast(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
): boolean {
  return !has(value, key) || isIntegerAtLeast(value[key], minimum)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function isAppSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  const v = value
  // `data` was added after the first settings format. It is deliberately
  // optional here so old exports can still be imported and merged with the
  // current defaults.
  if (
    !enumValue(v.theme, ['system', 'light', 'dark']) ||
    !enumValue(v.locale, ['zh-CN', 'en-US']) ||
    !isColorThemeChoice(v.colorTheme) ||
    !isImageThemeChoice(v.imageTheme) ||
    !enumValue(v.defaultPermissionMode, PERMISSION_MODES) ||
    (has(v, 'permissionReviewerModel') && typeof v.permissionReviewerModel !== 'string') ||
    !optionalString(v, 'permissionReviewerModelProviderId') ||
    typeof v.defaultModel !== 'string' ||
    !optionalString(v, 'defaultModelProviderId') ||
    (has(v, 'contextManagement') && !isContextManagementSettings(v.contextManagement)) ||
    !isSubagentSettings(v.subagent) ||
    !isGatewaySettings(v.gateway) ||
    !isNotificationSettings(v.notifications) ||
    !isProxySettings(v.proxy)
  ) return false
  if (has(v, 'data') && !isDataSettings(v.data)) return false
  return true
}

function isContextManagementSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isBoolean(value.experimentalMode) && isBoolean(value.autoCompact)
}

function isColorThemeChoice(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id) && isFiniteNumber(value.seed) && typeof value.custom === 'string'
}

function isImageThemeChoice(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (value.id === null || typeof value.id === 'string') && enumValue(value.render, ['blur', 'overlay'])
}

function isSubagentSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.model === 'string' &&
    optionalString(value, 'modelProviderId') &&
    isIntegerAtLeast(value.perSessionLimit, 1) &&
    isIntegerAtLeast(value.globalLimit, 0)
  )
}

function isGatewaySettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isBoolean(value.enabled) && isIntegerAtLeast(value.preferredPort, 0) && value.preferredPort <= 65535 && isBoolean(value.failover)
}

function isNotificationSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isBoolean(value.taskComplete) && isBoolean(value.permissionApproval) && isBoolean(value.planApproval)
}

function isDataSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (value.backupDirectory === null || typeof value.backupDirectory === 'string') && enumValue(value.backupFrequency, ['manual', 'daily', 'weekly'])
}

function isProxySettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  // Accept the pre-split `{ enabled, url }` representation. The settings
  // merger migrates it to the current shape on import/read.
  if (has(value, 'url')) {
    return typeof value.url === 'string' && optionalBoolean(value, 'enabled')
  }
  return (
    isBoolean(value.enabled) &&
    enumValue(value.mode, ['system', 'manual']) &&
    enumValue(value.scheme, PROXY_SCHEMES) &&
    typeof value.host === 'string' &&
    isIntegerAtLeast(value.port, 0) && value.port <= 65535 &&
    isBoolean(value.authEnabled) &&
    typeof value.authUser === 'string' &&
    typeof value.bypass === 'string'
  )
}

function isWorkspace(value: unknown): value is Workspace {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    typeof value.name === 'string' &&
    typeof value.rootPath === 'string' &&
    optionalBoolean(value, 'unavailable') &&
    isWorkspaceSettings(value.settings) &&
    isIntegerAtLeast(value.createdAt, 0) &&
    isIntegerAtLeast(value.lastOpenedAt, 0) &&
    optionalTimestamp(value, 'updatedAt')
  )
}

function isWorkspaceSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    enumValue(value.permissionMode, PERMISSION_MODES) &&
    typeof value.defaultModel === 'string' &&
    optionalString(value, 'defaultModelProviderId') &&
    enumValue(value.defaultMode, SESSION_MODES) &&
    enumValue(value.defaultThinking, THINKING_LEVELS) &&
    isBoolean(value.webSearch) &&
    stringArray(value.activeSkillIds)
  )
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    typeof value.workspaceId === 'string' &&
    typeof value.title === 'string' &&
    (value.titleSource === undefined || enumValue(value.titleSource, ['default', 'generated', 'manual'])) &&
    typeof value.model === 'string' &&
    optionalString(value, 'modelProviderId') &&
    enumValue(value.mode, SESSION_MODES) &&
    enumValue(value.thinking, THINKING_LEVELS) &&
    typeof value.rootPathAtCreation === 'string' &&
    enumValue(value.status, ['idle', 'running']) &&
    isBoolean(value.archived) &&
    isBoolean(value.favorited) &&
    isIntegerAtLeast(value.createdAt, 0) &&
    isIntegerAtLeast(value.updatedAt, 0)
  )
}

function isExportSession(value: unknown): value is ExportSession {
  if (!isRecord(value) || !isSession(value.session) || !Array.isArray(value.messages)) return false
  const messages = value.messages as unknown[]
  if (!messages.every(isAgentMessage) || !uniqueBy(messages, (message) => (message as AgentMessage).id)) return false
  if (value.contextCheckpoints === undefined) return true
  return Array.isArray(value.contextCheckpoints) && value.contextCheckpoints.every(isContextCheckpoint)
}

function isContextCheckpoint(value: unknown): value is ContextCheckpoint {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id) && isNonEmptyString(value.sessionId) &&
    isIntegerAtLeast(value.windowIndex, 0) && typeof value.note === 'string' &&
    enumValue(value.source, ['model', 'mechanical', 'manual', 'auto']) &&
    optionalString(value, 'coveredFromMessageId') && optionalString(value, 'coveredThroughMessageId') &&
    optionalIntegerAtLeast(value, 'inputTokensBefore', 0) && optionalIntegerAtLeast(value, 'inputTokensAfter', 0) &&
    (value.searchHits === undefined || Array.isArray(value.searchHits)) &&
    isIntegerAtLeast(value.createdAt, 0) && isIntegerAtLeast(value.updatedAt, 0) &&
    isIntegerAtLeast(value.revision, 1)
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    enumValue(value.role, ['user', 'assistant']) &&
    Array.isArray(value.parts) &&
    value.parts.every(isContentPart) &&
    isIntegerAtLeast(value.createdAt, 0) &&
    value.schemaVersion === 1
  )
}

function isContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'text':
    case 'thinking':
      return typeof value.text === 'string' && (!has(value, 'opaque') || isJsonValue(value.opaque))
    case 'tool_call':
      return isNonEmptyString(value.callId) && isNonEmptyString(value.name) && isJsonValue(value.input)
    case 'tool_result':
      return isNonEmptyString(value.callId) && isToolOutput(value.output) && isBoolean(value.isError)
    case 'subagent':
      return isNonEmptyString(value.callId) && isNonEmptyString(value.childRunId) && optionalString(value, 'summary')
    case 'image':
      return isNonEmptyString(value.mime) && isNonEmptyString(value.dataRef)
    case 'error':
      return isAgentError(value.error)
    default:
      return false
  }
}

function isToolOutput(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.content === 'string' && optionalBoolean(value, 'truncated') && (!has(value, 'originalBytes') || isIntegerAtLeast(value.originalBytes, 0))
}

function isAgentError(value: unknown): boolean {
  if (!isRecord(value)) return false
  const codes = ['auth', 'rate_limit', 'context_length', 'network', 'aborted', 'tool_failed', 'provider', 'cache_unsupported', 'no_healthy_provider', 'unknown'] as const
  return (
    enumValue(value.code, codes) &&
    typeof value.message === 'string' &&
    isBoolean(value.retryable) &&
    (!has(value, 'status') || isIntegerAtLeast(value.status, 0)) &&
    (!has(value, 'retryAfterMs') || isIntegerAtLeast(value.retryAfterMs, 0))
  )
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return typeof value !== 'number' || Number.isFinite(value)
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isProvider(value: unknown): value is UpstreamProvider {
  if (!isRecord(value)) return false
  if (
    !isNonEmptyString(value.id) ||
    typeof value.name !== 'string' ||
    !enumValue(value.protocol, ['anthropic', 'openai-chat', 'openai-responses']) ||
    typeof value.baseUrl !== 'string' ||
    !isNonEmptyString(value.credentialRef) ||
    !isIntegerAtLeast(value.priority, 0) ||
    !isBoolean(value.enabled) ||
    !optionalTimestamp(value, 'updatedAt')
  ) return false
  if (!has(value, 'protocolOptions')) return true
  if (!isRecord(value.protocolOptions)) return false
  if (!has(value.protocolOptions, 'anthropic')) return true
  const anthropic = value.protocolOptions.anthropic
  // Provider JSON predates protocol-specific options, and future versions may
  // add new TTL values.  Import/read paths deliberately accept a missing or
  // unknown cacheTtl and let the persistence normalizer map it to `off` so an
  // old export remains importable without ever enabling caching accidentally.
  // Keep rejecting a malformed `anthropic` container itself: that is a shape
  // error, not a forward-compatible value.
  return isRecord(anthropic)
}

function isModelAlias(value: unknown): value is ModelAlias {
  if (!isRecord(value)) return false
  if (
    !isNonEmptyString(value.alias) ||
    !isNonEmptyString(value.providerId) ||
    !isNonEmptyString(value.upstreamModel) ||
    !isCapabilities(value.capabilities) ||
    !isIntegerAtLeast(value.contextWindow, 1) ||
    !isIntegerAtLeast(value.maxOutputTokens, 1) ||
    !optionalIntegerAtLeast(value, 'priority', 0) ||
    !optionalString(value, 'displayName') ||
    !optionalTimestamp(value, 'updatedAt')
  ) return false
  if (has(value, 'modality') && !enumValue(value.modality, ['text', 'image', 'video', 'speech', 'transcription'])) return false
  if (has(value, 'enabled') && !isBoolean(value.enabled)) return false
  if (has(value, 'thinkingConfig') && !isThinkingConfig(value.thinkingConfig)) return false
  if (has(value, 'reasoningEfforts') && (!Array.isArray(value.reasoningEfforts) || !value.reasoningEfforts.every((effort) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort))))) return false
  if (has(value, 'catalogOverrides') && (!Array.isArray(value.catalogOverrides) || !value.catalogOverrides.every(isModelCatalogOverride))) return false
  if (has(value, 'requestAdapter') && !isRequestAdapter(value.requestAdapter)) return false
  if (has(value, 'source') && !isRecord(value.source)) return false
  if (isRecord(value.source) && (!isNonEmptyString(value.source.url) || typeof value.source.fetchedAt !== 'string' || !optionalString(value.source, 'verifiedAt'))) return false
  return true
}

function isCapabilities(value: unknown): boolean {
  if (!isRecord(value)) return false
  const required = ['tools', 'vision', 'thinking', 'caching']
  return required.every((key) => isBoolean(value[key])) &&
    ['textInput', 'visionInput', 'fileInput', 'videoInput', 'audioInput', 'textOutput', 'imageOutput', 'videoOutput', 'audioOutput', 'webSearch', 'structuredOutput', 'streaming', 'batch'].every((key) => optionalBoolean(value, key))
}

function isThinkingConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!enumValue(value.mode, ['unsupported', 'always', 'toggle', 'effort', 'budget']) || !isBoolean(value.defaultEnabled) || (has(value, 'defaultEffort') && !enumValue(value.defaultEffort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])) || (has(value, 'defaultBudgetTokens') && !isIntegerAtLeast(value.defaultBudgetTokens, 0)) || !optionalString(value, 'parameterPath')) return false
  if ((has(value, 'enabledValue') && !isJsonValue(value.enabledValue)) || (has(value, 'disabledValue') && !isJsonValue(value.disabledValue))) return false
  const parameterPath = typeof value.parameterPath === 'string' ? value.parameterPath.trim() : ''
  const leaf = parameterPath.split('.').at(-1)
  if (value.mode === 'budget' && (leaf === 'enable_thinking' || leaf === 'thinking_mode' || parameterPath === 'thinking.enabled' || parameterPath === 'reasoning_split')) return false
  if (value.mode === 'toggle' && (parameterPath === 'thinking_budget' || parameterPath.endsWith('.budget_tokens'))) return false
  if (has(value, 'effortMap')) {
    if (!isRecord(value.effortMap)) return false
    for (const [effort, mapped] of Object.entries(value.effortMap)) {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) || !isJsonValue(mapped)) return false
    }
  }
  return true
}

function isRequestAdapter(value: unknown): boolean {
  if (!isRecord(value) || !enumValue(value.preset, ['auto', 'anthropic', 'openai-chat', 'openai-responses', 'custom']) || !Array.isArray(value.patches)) return false
  return value.patches.every((patch) => {
    if (!isRecord(patch) || !enumValue(patch.op, ['add', 'replace', 'remove']) || typeof patch.path !== 'string') return false
    return !has(patch, 'value') || isJsonValue(patch.value)
  })
}

function isMcpServer(value: unknown): value is McpServerConfig {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.name !== 'string' || !isBoolean(value.enabled) || !optionalString(value, 'description') || !optionalTimestamp(value, 'updatedAt')) return false
  if (value.transport === 'stdio') return typeof value.command === 'string' && stringArray(value.args) && stringArray(value.envNames) && optionalString(value, 'cwd')
  if (value.transport === 'sse' || value.transport === 'streamable-http') return typeof value.url === 'string' && stringArray(value.headerNames)
  return false
}

function isSearchProvider(value: unknown): value is SearchProviderConfig {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id) && isBoolean(value.enabled) && isIntegerAtLeast(value.priority, 0) && optionalTimestamp(value, 'updatedAt')
}

function optionalTimestamp(value: Record<string, unknown>, key: string): boolean {
  return !has(value, key) || (isIntegerAtLeast(value[key], 0) && value[key] <= 9_999_999_999_999)
}

function uniqueBy(values: readonly unknown[], keyOf: (value: unknown) => string): boolean {
  const seen = new Set<string>()
  for (const value of values) {
    const key = keyOf(value)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

function isEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  if (!isRecord(value)) return false
  return value.algorithm === 'scrypt-aes-256-gcm' &&
    isBase64(value.salt, 16, 64) &&
    isBase64(value.nonce, 12, 12) &&
    isBase64(value.tag, 16, 16) &&
    isBase64(value.ciphertext, 1, 128 * 1024 * 1024)
}

/** Base64 validation without importing Node-only Buffer into the renderer. */
function isBase64(value: unknown, minBytes: number, maxBytes: number): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = (value.length / 4) * 3 - padding
  return bytes >= minBytes && bytes <= maxBytes
}
