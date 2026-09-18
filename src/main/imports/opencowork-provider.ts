import { createHash } from 'node:crypto'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { providerCredentialRef, type ModelAlias, type UpstreamProtocol, type UpstreamProvider } from '../../shared/domain/provider'

/**
 * 一个从 `~/.open-cowork/ai-provider/provider-<id>.json` 归一化出来的供应商。
 *
 * ★ OpenCoWork 是姊妹项目,`type` 字段(`anthropic`/`openai-chat`/
 * `openai-responses`)和本项目的 `UpstreamProtocol` **同名同值** —— 不需要
 * 像 OpenCode 那样从 npm 包名反推协议。命中不了的(`openai-images` 等媒体
 * 生成类型)标 `provider.needs-manual-setup`,不硬塞成 openai-chat。
 *
 * `hasLocalKey` 只表示源文件里 `apiKey` 非空。★ 值不进这里,也不进任何
 * 上层类型 —— 和 `opencode-provider.ts` 同一条规矩。
 */
export interface OpencoworkProviderConfig {
  id: string
  sourcePath: string
  name: string
  protocol: UpstreamProtocol
  baseUrl: string
  models: string[]
  defaultModel?: string
  hasLocalKey: boolean
  diagnostics: ImportDiagnostic[]
  fingerprint: string
}

/** OpenCoWork `ProviderType` → 本地协议。媒体生成类等推不出来的返回 null。 */
export function protocolFromProviderType(type: string | undefined): UpstreamProtocol | null {
  return type === 'anthropic' || type === 'openai-chat' || type === 'openai-responses' ? type : null
}

export function opencoworkProviderId(sourceId: string, providerId: string): string {
  const identity = createHash('sha256').update(JSON.stringify([sourceId, providerId])).digest('hex').slice(0, 16)
  const slug = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider'
  return `opencowork-${identity}-${slug}`
}

export function mapOpencoworkProvider(sourceId: string, source: OpencoworkProviderConfig): { provider: UpstreamProvider; alias?: ModelAlias } {
  const id = opencoworkProviderId(sourceId, source.id)
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
