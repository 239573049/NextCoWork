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
  permissionReviewerModelProviderId: 'providers', goalEvaluatorModel: 'providers',
  goalEvaluatorModelProviderId: 'providers', modelProposedGoals: 'providers',
  defaultModel: 'providers', defaultModelProviderId: 'providers',
  contextManagement: 'preferences', subagent: 'split', gateway: 'device', notifications: 'preferences',
  proxy: 'device', data: 'split', personalization: 'preferences', shortcuts: 'preferences', themeStudio: 'preferences',
  shell: 'device',
  // 自建 SearxNG 实例多半是 `http://localhost:8080` —— 同步到另一台机器上就是个死地址,
  // 和 `shell` 同类:它描述的是**这台机器**上跑着什么。
  builtinSearch: 'device',
  upstreamIdleTimeoutSeconds: 'device',
  // 输出额度描述的是「我要多长的回答」,不是这台机器的事实 —— 和 contextManagement 同类。
  maxOutputTokens: 'preferences'
}
export const SYNC_REGISTRY: Record<SyncCategory, { order: number; confirmation: boolean; deviceFields: readonly string[] }> = {
  // 普通 provider 的 API Key/OAuth token 在 providers 密文文档中同步；只有引用名和
  // NextCoWork 自身登录 token 留在设备上。
  providers: { order: 0, confirmation: false, deviceFields: ['credentialRef', 'platformTokens'] },
  preferences: { order: 2, confirmation: false, deviceFields: ['backupDirectory', 'gateway', 'proxy', 'shell', 'builtinSearch'] },
  connections: { order: 3, confirmation: true, deviceFields: ['cwd', 'identityFile', 'knownHostsFile', 'cookies'] },
  extensions: { order: 1, confirmation: true, deviceFields: ['absolutePath', 'executionApproval'] },
  workspaces: { order: 4, confirmation: true, deviceFields: ['rootPath', 'environment', 'lastOpenedAt'] },
  automation: { order: 5, confirmation: true, deviceFields: ['nextRunAt', 'lastRunAt', 'approvalHistory'] }
}

export function portableProvider(provider: UpstreamProvider): Omit<UpstreamProvider, 'credentialRef'> {
  const { credentialRef: _local, ...portable } = provider
  return structuredClone(portable)
}
