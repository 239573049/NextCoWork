import type { ModelAlias, UpstreamProvider } from './provider'
import type { EncryptedCredentials } from './data'

/** Standalone provider configuration export. Secrets are only allowed in the encrypted block. */
export const PROVIDER_EXPORT_TYPE = 'nextcowork-provider-export' as const
export const PROVIDER_EXPORT_VERSION = 1

export interface ProviderExport {
  type: typeof PROVIDER_EXPORT_TYPE
  version: number
  exportedAt: string | number
  providers: UpstreamProvider[]
  aliases: ModelAlias[]
  /** Encrypted map of source credential ref -> serialized ProviderCredential. */
  encryptedCredentials?: EncryptedCredentials
}

export interface ProviderImportResult {
  providerCount: number
  aliasCount: number
  credentialCount: number
}

/** Validate the standalone format without attempting to decrypt its optional secrets. */
export function isProviderExport(value: unknown): value is ProviderExport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (
    v.type !== PROVIDER_EXPORT_TYPE ||
    typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1 ||
    !((typeof v.exportedAt === 'string' && Number.isFinite(Date.parse(v.exportedAt))) ||
      (typeof v.exportedAt === 'number' && Number.isFinite(v.exportedAt))) ||
    !Array.isArray(v.providers) || !Array.isArray(v.aliases) ||
    !v.providers.every((provider) => isProviderRecord(provider)) ||
    !v.aliases.every((alias) => isModelAliasRecord(alias)) ||
    !uniqueBy(v.providers, (provider) => String(provider.id)) ||
    !uniqueBy(v.providers, (provider) => String(provider.credentialRef)) ||
    !uniqueBy(v.aliases, (alias) => `${String(alias.providerId)}\u0000${String(alias.alias)}`)
  ) return false

  if (v.encryptedCredentials !== undefined && !isEncryptedCredentials(v.encryptedCredentials)) return false
  const providerIds = new Set(v.providers.map((provider) => String(provider.id)))
  return v.aliases.every((alias) => providerIds.has(String(alias.providerId)))
}

/** Keep the validator local to the standalone format; it intentionally accepts future fields. */
function isProviderRecord(value: unknown): value is UpstreamProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const validBaseUrl = (() => {
    if (typeof v.baseUrl !== 'string' || v.baseUrl.trim().length === 0) return false
    try { const url = new URL(v.baseUrl); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
  })()
  return (
    typeof v.id === 'string' && v.id.length > 0 && !v.id.includes('/') &&
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    (v.protocol === 'anthropic' || v.protocol === 'openai-chat' || v.protocol === 'openai-responses') &&
    validBaseUrl &&
    typeof v.credentialRef === 'string' && v.credentialRef.length > 0 &&
    typeof v.priority === 'number' && Number.isFinite(v.priority) && Number.isInteger(v.priority) && v.priority >= 0 &&
    typeof v.enabled === 'boolean'
  )
}

function isModelAliasRecord(value: unknown): value is ModelAlias {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const capabilities = v.capabilities
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) return false
  const c = capabilities as Record<string, unknown>
  return (
    typeof v.alias === 'string' && v.alias.length > 0 &&
    typeof v.providerId === 'string' && v.providerId.length > 0 &&
    typeof v.upstreamModel === 'string' && v.upstreamModel.length > 0 &&
    ['tools', 'vision', 'thinking', 'caching'].every((key) => typeof c[key] === 'boolean') &&
    typeof v.contextWindow === 'number' && Number.isInteger(v.contextWindow) && v.contextWindow >= 1 &&
    typeof v.maxOutputTokens === 'number' && Number.isInteger(v.maxOutputTokens) && v.maxOutputTokens >= 1
  )
}

function isEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return v.algorithm === 'scrypt-aes-256-gcm' &&
    typeof v.salt === 'string' && typeof v.nonce === 'string' &&
    typeof v.tag === 'string' && typeof v.ciphertext === 'string'
}

function uniqueBy(values: readonly unknown[], key: (value: Record<string, unknown>) => string): boolean {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const id = key(value as Record<string, unknown>)
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}
