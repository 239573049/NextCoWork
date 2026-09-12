import { createHash } from 'node:crypto'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { providerCredentialRef, type ModelAlias, type UpstreamProvider } from '../../shared/domain/provider'

export interface CodexProviderConfig {
  id: string
  profile: string
  sourcePath: string
  name: string
  baseUrl: string
  wireApi: 'responses' | 'chat'
  defaultModel?: string
  envKey?: string
  requiresOpenaiAuth?: boolean
  unsupportedOptions: string[]
  diagnostics: ImportDiagnostic[]
  fingerprint: string
}

export function codexProviderId(sourceId: string, provider: Pick<CodexProviderConfig, 'id' | 'profile'>): string {
  const identity = createHash('sha256').update(JSON.stringify([sourceId, provider.profile, provider.id])).digest('hex').slice(0, 16)
  const slug = provider.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'provider'
  return `codex-${identity}-${slug}`
}

export function mapCodexProvider(sourceId: string, source: CodexProviderConfig): { provider: UpstreamProvider; alias?: ModelAlias } {
  const id = codexProviderId(sourceId, source)
  const url = new URL(source.baseUrl)
  // URL credentials and query strings are never carried into a provider.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('provider.needs-manual-setup')
  const provider: UpstreamProvider = {
    id, name: source.name, baseUrl: url.href.replace(/\/$/, ''),
    protocol: source.wireApi === 'chat' ? 'openai-chat' : 'openai-responses',
    credentialRef: providerCredentialRef(id), priority: 50, enabled: false
  }
  const alias: ModelAlias | undefined = source.defaultModel ? {
    alias: source.defaultModel, upstreamModel: source.defaultModel, providerId: id,
    enabled: false, capabilities: { tools: false, vision: false, thinking: false, caching: false },
    contextWindow: 32_768, maxOutputTokens: 4_096
  } : undefined
  return { provider, ...(alias ? { alias } : {}) }
}

/** Credentials and activation belong to the user; they do not participate in source ownership. */
export function providerSurface(provider: UpstreamProvider): string {
  const { credentialRef: _credentialRef, enabled: _enabled, ...surface } = provider
  return createHash('sha256').update(JSON.stringify(surface)).digest('hex')
}

export function aliasSurface(alias: ModelAlias): string {
  const { enabled: _enabled, ...surface } = alias
  return createHash('sha256').update(JSON.stringify(surface)).digest('hex')
}
