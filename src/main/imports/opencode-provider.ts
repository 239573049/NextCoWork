import { createHash } from 'node:crypto'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { providerCredentialRef, type ModelAlias, type UpstreamProtocol, type UpstreamProvider } from '../../shared/domain/provider'

/**
 * 一个从 `opencode.jsonc` 的 `provider` 表归一化出来的供应商。
 *
 * ★ 和 Codex 的区别只有一处但很关键:协议不是靠 `wire_api` 声明的,而是靠
 * `npm` 字段(`@ai-sdk/anthropic` / `@ai-sdk/openai-compatible` / …)推出来的。
 * 推不出来的(gemini 之类本地没有对应协议的)标 `provider.needs-manual-setup`,
 * 不硬塞成 openai。
 *
 * `hasLocalKey` 只表示「auth.json 或 options.apiKey 里有键」—— **值不进这里**。
 */
export interface OpencodeProviderConfig {
  id: string
  sourcePath: string
  name: string
  protocol: UpstreamProtocol
  baseUrl: string
  models: string[]
  defaultModel?: string
  /** 本地已存在凭证(auth.json 命中 或 配置里内联了 apiKey)。只是提示,不搬值。 */
  hasLocalKey: boolean
  diagnostics: ImportDiagnostic[]
  fingerprint: string
}

/** `@ai-sdk/*` → 本地协议。推不出来返回 null(交由调用方记诊断)。 */
export function protocolFromNpm(npm: string | undefined): UpstreamProtocol | null {
  switch (npm) {
    case '@ai-sdk/anthropic':
      return 'anthropic'
    case '@ai-sdk/openai':
    case '@ai-sdk/azure':
      return 'openai-responses'
    case '@ai-sdk/openai-compatible':
      return 'openai-chat'
    default:
      return null
  }
}

export function opencodeProviderId(sourceId: string, providerId: string): string {
  const identity = createHash('sha256').update(JSON.stringify([sourceId, providerId])).digest('hex').slice(0, 16)
  const slug = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider'
  return `opencode-${identity}-${slug}`
}

export function mapOpencodeProvider(sourceId: string, source: OpencodeProviderConfig): { provider: UpstreamProvider; alias?: ModelAlias } {
  const id = opencodeProviderId(sourceId, source.id)
  const url = new URL(source.baseUrl)
  // URL 里内嵌的凭证/查询串一律不带进 provider。
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('provider.needs-manual-setup')
  const provider: UpstreamProvider = {
    id, name: source.name, baseUrl: url.href.replace(/\/$/, ''),
    protocol: source.protocol,
    credentialRef: providerCredentialRef(id), priority: 50, enabled: false
  }
  const alias: ModelAlias | undefined = source.defaultModel ? {
    alias: source.defaultModel, upstreamModel: source.defaultModel, providerId: id,
    enabled: false, capabilities: { tools: false, vision: false, thinking: false, caching: false },
    contextWindow: 32_768, maxOutputTokens: 4_096
  } : undefined
  return { provider, ...(alias ? { alias } : {}) }
}
