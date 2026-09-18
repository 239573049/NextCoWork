import { dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderExport } from '../../shared/domain/provider-export'
import { isProviderExport, PROVIDER_EXPORT_TYPE, PROVIDER_EXPORT_VERSION } from '../../shared/domain/provider-export'
import { CLIENT_PROVIDER_ID } from '../../shared/domain/presets'
import { providerCredentialRef } from '../../shared/domain/provider'
import { getHost } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { upsertProvider, listProviders, listModels } from './provider'
import { encryptCredentialMap, decryptCredentialMap } from '../provider-export-crypto'

const MAX_PROVIDER_EXPORT_BYTES = 16 * 1024 * 1024

export async function exportProviders(req: { includeCredentials?: boolean; password?: string }): Promise<{ path: string; encrypted: boolean; providerCount: number; aliasCount: number } | null> {
  const providers = listProviders().filter((provider) => provider.id !== CLIENT_PROVIDER_ID)
  const providerIds = new Set(providers.map((provider) => provider.id))
  const aliases = store.listAliases().filter((alias) => providerIds.has(alias.providerId))
  const data: ProviderExport = { type: PROVIDER_EXPORT_TYPE, version: PROVIDER_EXPORT_VERSION, exportedAt: new Date().toISOString(), providers, aliases }
  if (req.includeCredentials === true) {
    if (req.password === undefined || req.password.length < 8) throw new Error('加密导出密码至少需要 8 个字符')
    if (!getHost().secrets.available()) throw new Error('凭证加密存储不可用，无法导出凭证')
    const values: Record<string, string> = {}
    for (const provider of providers) {
      const value = await getHost().secrets.get(provider.credentialRef)
      if (value !== null && value !== '') values[provider.credentialRef] = value
    }
    data.encryptedCredentials = encryptCredentialMap(values, req.password)
  }
  const result = await dialog.showSaveDialog({
    title: '导出模型提供商配置',
    defaultPath: join(getHost().paths.userData(), `nextcowork-providers-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return null
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  writeFileSync(result.filePath, bytes)
  return { path: result.filePath, encrypted: data.encryptedCredentials !== undefined, providerCount: providers.length, aliasCount: aliases.length }
}

export async function importProviders(req: { password?: string }): Promise<{ path: string; providerCount: number; aliasCount: number; credentialCount: number } | null> {
  const result = await dialog.showOpenDialog({ title: '导入模型提供商配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const path = result.filePaths[0]
  if (!existsSync(path)) throw new Error('导入文件不存在')
  if (statSync(path).size > MAX_PROVIDER_EXPORT_BYTES) throw new Error('导入文件过大')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('导入文件不是有效 JSON') }
  if (!isProviderExport(value) || value.version > PROVIDER_EXPORT_VERSION) throw new Error('导入文件格式或版本不受支持')
  if (value.providers.some((provider) => provider.id === CLIENT_PROVIDER_ID)) throw new Error('不能导入 NextCoWork 内置提供商')

  let credentials: Record<string, string> = {}
  if (value.encryptedCredentials !== undefined) {
    if (req.password === undefined) throw new Error('该文件包含加密凭证，需要输入密码')
    credentials = decryptCredentialMap(value.encryptedCredentials, req.password)
    if (Object.keys(credentials).length > 0 && !getHost().secrets.available()) throw new Error('凭证加密存储不可用，无法导入凭证')
  }
  const sourceRefs = new Set(value.providers.map((provider) => provider.credentialRef))
  for (const source of Object.keys(credentials)) if (!sourceRefs.has(source)) throw new Error('导入文件包含未知凭证引用')

  const localProviders = listProviders()
  const destinationBySource = new Map<string, string>()
  const destinations = new Set<string>()
  for (const provider of value.providers) {
    const local = localProviders.find((item) => item.id === provider.id)
    const destination = local?.credentialRef ?? providerCredentialRef(provider.id)
    if (destinations.has(destination) && destinationBySource.get(provider.credentialRef) !== destination) throw new Error('导入文件中的多个凭证会写入同一本机配置')
    destinations.add(destination)
    destinationBySource.set(provider.credentialRef, destination)
  }

  for (const provider of value.providers) {
    upsertProvider({ ...provider, credentialRef: destinationBySource.get(provider.credentialRef) ?? providerCredentialRef(provider.id) })
    for (const alias of store.listAliases().filter((item) => item.providerId === provider.id)) store.removeAlias(alias.providerId, alias.alias)
  }
  for (const alias of value.aliases) store.putAlias(alias)
  for (const [source, serialized] of Object.entries(credentials)) {
    const destination = destinationBySource.get(source)
    if (destination !== undefined) await getHost().secrets.set(destination, serialized)
  }
  windows.emitToAll('provider:changed', { providers: listProviders(), models: listModels() })
  return { path, providerCount: value.providers.length, aliasCount: value.aliases.length, credentialCount: Object.keys(credentials).length }
}
