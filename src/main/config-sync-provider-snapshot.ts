/**
 * 加密配置同步 v2 的 `providers` 快照。
 *
 * 服务端只看到 `config-sync-crypto.ts` 产生的 AES-GCM 信封;本模块处理的明文
 * 只存在于主进程内存。快照把 provider / alias 与它们的凭证放在**同一个原子文档**里,
 * 避免 A 设备先收到配置、下一轮才收到 key 而进入一个暂时必失败的状态。
 *
 * ★ `credentialRef` 仍不上传。云端 map 的键是 provider id;落到另一台设备时
 *   始终用 `providerCredentialRef(id)` 重新派生本机引用,防止远端让 A 指向 B 的密钥。
 * ★ NextCoWork 内置 provider 不参与。它的 credentialRef 指向当前设备登录 JWT,
 *   同步出去既会复制登录身份,也会让另一台设备绕过自己的 OAuth 登录。
 */
import type { ModelAlias, UpstreamProvider } from '../shared/domain/provider'
import { normalizeUpstreamProvider, providerCredentialRef } from '../shared/domain/provider'
import { isModelAlias, isProvider } from '../shared/domain/data'
import { MODEL_SYNC_FIELDS } from '../shared/domain/config-sync-registry'
import { CLIENT_PROVIDER_ID } from '../shared/domain/presets'
import type { KernelHost } from './kernel/host'
import * as repo from './db/repo'
import { tx, txAsync } from './db'

export interface ProviderSyncDocumentData {
  providers: Array<Omit<UpstreamProvider, 'credentialRef'>>
  aliases: ModelAlias[]
  /** provider id → serializeCredential 后的明文字符串;整个 document 在出站前加密 */
  credentials: Record<string, string>
}

const MAX_SYNC_PROVIDERS = 500
const MAX_SYNC_ALIASES = 10_000
const MAX_CREDENTIAL_BYTES = 1024 * 1024
const PORTABLE_PROVIDER_FIELDS = new Set([
  'id', 'name', 'protocol', 'baseUrl', 'priority', 'enabled', 'protocolOptions'
])
const MODEL_FIELDS = new Set(Object.keys(MODEL_SYNC_FIELDS))

/**
 * v1 云文档 → providers 快照。v1 payload 是各历史版本的 provider/alias JSON,
 * 可能带着早已删除的字段 —— 这里**只挑白名单字段**,而不是像 v2 快照那样整对象
 * 拒绝:迁移的目标是保住用户配置,过时字段本来就该丢。
 * v1 云端从不存密钥,credentials 恒为空。
 */
export function legacyProviderDocumentData(
  documents: ReadonlyArray<{ kind: string; payload: unknown }>
): ProviderSyncDocumentData {
  const providers: ProviderSyncDocumentData['providers'] = []
  const aliases: ModelAlias[] = []
  for (const document of documents) {
    const payload = record(document.payload)
    if (payload === null) continue
    if (document.kind === 'provider') {
      const portable: Record<string, unknown> = {}
      for (const field of PORTABLE_PROVIDER_FIELDS) {
        if (Object.hasOwn(payload, field)) portable[field] = payload[field]
      }
      if (parseProvider(portable) !== null) providers.push(portable as ProviderSyncDocumentData['providers'][number])
    } else if (document.kind === 'modelAlias') {
      const portable: Record<string, unknown> = {}
      for (const field of MODEL_FIELDS) {
        if (Object.hasOwn(payload, field)) portable[field] = payload[field]
      }
      if (parseAlias(portable, new Set(providers.map((provider) => provider.id))) !== null) {
        aliases.push(portable as unknown as ModelAlias)
      }
    }
  }
  return { providers, aliases, credentials: Object.create(null) }
}

export interface ParsedProviderSyncData {
  providers: UpstreamProvider[]
  aliases: ModelAlias[]
  credentials: Record<string, string>
}

/**
 * 首次接入云端时做并集,本机同 id/别名优先。用户是在**当前设备**上确认同步,
 * 把他刚配好的 key 被云端旧快照静默覆盖掉比产生一轮新版本更危险。
 */
export function mergeProviderSyncData(
  remoteInput: unknown,
  localInput: unknown
): ProviderSyncDocumentData {
  const remote = parseProviderSyncData(remoteInput)
  const local = parseProviderSyncData(localInput)
  const providers = new Map(remote.providers.map((provider) => [provider.id, provider]))
  for (const provider of local.providers) providers.set(provider.id, provider)

  const aliases = new Map(
    remote.aliases.map((alias) => [`${alias.providerId}\u0000${alias.alias}`, alias])
  )
  for (const alias of local.aliases) aliases.set(`${alias.providerId}\u0000${alias.alias}`, alias)

  return {
    providers: [...providers.values()].map(({ credentialRef: _local, ...provider }) => provider),
    aliases: [...aliases.values()].filter((alias) => providers.has(alias.providerId)),
    credentials: { ...remote.credentials, ...local.credentials }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseProvider(value: unknown): UpstreamProvider | null {
  const item = record(value)
  if (
    item === null ||
    Object.keys(item).some((key) => !PORTABLE_PROVIDER_FIELDS.has(key)) ||
    typeof item['id'] !== 'string' || item['id'] === CLIENT_PROVIDER_ID || item['id'].length > 128 || item['id'].includes('/') ||
    typeof item['name'] !== 'string' || item['name'].trim() === '' || item['name'].length > 512 ||
    typeof item['baseUrl'] !== 'string' || item['baseUrl'].length > 4096
  ) return null
  const candidate = { ...item, credentialRef: providerCredentialRef(item['id']) }
  if (!isProvider(candidate)) return null
  try {
    const url = new URL(candidate.baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  } catch {
    return null
  }
  return normalizeUpstreamProvider(candidate)
}

function parseAlias(value: unknown, providerIds: ReadonlySet<string>): ModelAlias | null {
  if (
    !isModelAlias(value) ||
    Object.keys(value).some((key) => !MODEL_FIELDS.has(key)) ||
    !providerIds.has(value.providerId) ||
    value.alias.length > 512 ||
    value.upstreamModel.length > 1024
  ) return null
  return structuredClone(value)
}

/** 读取明文后立刻交给加密调用方;返回值不得落库、打日志或发送未加密 HTTP。 */
export async function captureProviderSyncData(host: KernelHost): Promise<ProviderSyncDocumentData> {
  const providers = repo.listProviders().filter((provider) => provider.id !== CLIENT_PROVIDER_ID)
  const providerIds = new Set(providers.map((provider) => provider.id))
  const aliases = repo.listAliases().filter((alias) => providerIds.has(alias.providerId))
  const credentials: Record<string, string> = Object.create(null)
  for (const provider of providers) {
    const value = await host.secrets.get(provider.credentialRef)
    if (value !== null) credentials[provider.id] = value
  }
  return {
    providers: providers.map(({ credentialRef: _local, ...provider }) => structuredClone(provider)),
    aliases: structuredClone(aliases),
    credentials
  }
}

/**
 * 用远端完整快照替换当前账户的 provider 配置。凭证删除与写入也在同一 SQLite
 * 事务内；`host.secrets` 的 Electron 实现只做同步 fs/crypto/SQLite 工作并返回
 * resolved Promise,所以 `txAsync` 能保证中途失败时配置与凭证一起回滚。
 */
export function parseProviderSyncData(input: unknown): ParsedProviderSyncData {
  const value = record(input)
  if (
    value === null ||
    Object.keys(value).some((key) => key !== 'providers' && key !== 'aliases' && key !== 'credentials') ||
    !Array.isArray(value['providers']) || value['providers'].length > MAX_SYNC_PROVIDERS ||
    !Array.isArray(value['aliases']) || value['aliases'].length > MAX_SYNC_ALIASES
  ) {
    throw new Error('同步的供应商快照结构无效')
  }
  const credentialValues = record(value['credentials'])
  if (credentialValues === null) throw new Error('同步的凭证快照结构无效')

  const providers = value['providers'].map(parseProvider)
  if (providers.some((provider) => provider === null)) throw new Error('同步的供应商记录无效')
  const parsedProviders = providers as UpstreamProvider[]
  if (new Set(parsedProviders.map((provider) => provider.id)).size !== parsedProviders.length) {
    throw new Error('同步的供应商记录重复')
  }
  const ids = new Set(parsedProviders.map((provider) => provider.id))
  const aliases = value['aliases'].map((alias) => parseAlias(alias, ids))
  if (aliases.some((alias) => alias === null)) throw new Error('同步的模型记录无效')
  const parsedAliases = aliases as ModelAlias[]
  const aliasKeys = parsedAliases.map((alias) => `${alias.providerId}\u0000${alias.alias}`)
  if (new Set(aliasKeys).size !== aliasKeys.length) throw new Error('同步的模型记录重复')

  const credentials: Record<string, string> = Object.create(null)
  for (const [id, credential] of Object.entries(credentialValues)) {
    if (
      !ids.has(id) ||
      typeof credential !== 'string' || credential === '' ||
      Buffer.byteLength(credential, 'utf8') > MAX_CREDENTIAL_BYTES
    ) {
      throw new Error('同步的凭证记录无效')
    }
    credentials[id] = credential
  }

  return { providers: parsedProviders, aliases: parsedAliases, credentials }
}

export async function applyProviderSyncData(host: KernelHost, input: unknown): Promise<void> {
  const parsed = parseProviderSyncData(input)
  const ids = new Set(parsed.providers.map((provider) => provider.id))
  const applyConfig = (): UpstreamProvider[] => {
    const localProviders = repo.listProviders().filter((provider) => provider.id !== CLIENT_PROVIDER_ID)
    for (const alias of repo.listAliases()) {
      if (alias.providerId !== CLIENT_PROVIDER_ID) repo.removeAlias(alias.providerId, alias.alias)
    }
    for (const provider of localProviders) repo.removeProvider(provider.id)
    for (const provider of parsed.providers) repo.putProvider(provider)
    for (const alias of parsed.aliases) repo.putAlias(alias)
    return localProviders
  }

  if (host.secrets.setSync !== undefined && host.secrets.removeSync !== undefined) {
    repo.withSyncApply(() => tx(() => {
      const localProviders = applyConfig()
      for (const provider of localProviders) host.secrets.removeSync?.(provider.credentialRef)
      for (const id of ids) {
        const credential = parsed.credentials[id]
        if (credential !== undefined) host.secrets.setSync?.(providerCredentialRef(id), credential)
      }
    }))
    return
  }

  await repo.withSyncApplyAsync(() => txAsync(async () => {
    const localProviders = applyConfig()
    for (const provider of localProviders) await host.secrets.remove?.(provider.credentialRef)
    for (const id of ids) {
      const credential = parsed.credentials[id]
      if (credential !== undefined) await host.secrets.set(providerCredentialRef(id), credential)
    }
  }))
}
