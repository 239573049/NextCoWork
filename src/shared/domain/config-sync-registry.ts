import type { AppSettings } from './settings'
import type { ModelAlias, UpstreamProvider } from './provider'
import type { SyncCategory } from './config-sync'

/** Exhaustive compile-time inventory: new domain fields require an explicit sync decision. */
export const PROVIDER_SYNC_FIELDS: Record<keyof UpstreamProvider, 'copy' | 'local'> = {
  id: 'copy', name: 'copy', protocol: 'copy', baseUrl: 'copy', credentialRef: 'local',
  priority: 'copy', enabled: 'copy', protocolOptions: 'copy'
}
export const MODEL_SYNC_FIELDS: Record<keyof ModelAlias, 'copy'> = {
  alias: 'copy', providerId: 'copy', upstreamModel: 'copy', protocolOverride: 'copy', priority: 'copy',
  capabilities: 'copy', contextWindow: 'copy', maxOutputTokens: 'copy', displayName: 'copy', modality: 'copy',
  enabled: 'copy', thinkingConfig: 'copy', reasoningEfforts: 'copy', requestAdapter: 'copy', source: 'copy', catalogOverrides: 'copy'
}
export const SETTINGS_SYNC_FIELDS: Record<keyof AppSettings, SyncCategory | 'device' | 'split'> = {
  theme: 'preferences', activeThemeProfileId: 'preferences', locale: 'preferences', colorTheme: 'preferences',
  imageTheme: 'preferences', defaultPermissionMode: 'automation', permissionReviewerModel: 'providers',
  permissionReviewerModelProviderId: 'providers', defaultModel: 'providers', defaultModelProviderId: 'providers',
  contextManagement: 'preferences', subagent: 'split', gateway: 'device', notifications: 'preferences',
  proxy: 'device', data: 'split', personalization: 'preferences', shortcuts: 'preferences', themeStudio: 'preferences'
}
export const SYNC_REGISTRY: Record<SyncCategory, { order: number; confirmation: boolean; deviceFields: readonly string[] }> = {
  providers: { order: 0, confirmation: false, deviceFields: ['credentialRef', 'oauthTokens', 'platformTokens'] },
  preferences: { order: 2, confirmation: false, deviceFields: ['backupDirectory', 'gateway', 'proxy'] },
  connections: { order: 3, confirmation: true, deviceFields: ['cwd', 'identityFile', 'knownHostsFile', 'cookies'] },
  extensions: { order: 1, confirmation: true, deviceFields: ['absolutePath', 'executionApproval'] },
  workspaces: { order: 4, confirmation: true, deviceFields: ['rootPath', 'environment', 'lastOpenedAt'] },
  automation: { order: 5, confirmation: true, deviceFields: ['nextRunAt', 'lastRunAt', 'approvalHistory'] }
}

export function portableProvider(provider: UpstreamProvider): Omit<UpstreamProvider, 'credentialRef'> {
  const { credentialRef: _local, ...portable } = provider
  return structuredClone(portable)
}
