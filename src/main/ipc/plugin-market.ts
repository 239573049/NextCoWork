/**
 * 插件市场的客户端一侧 —— 浏览与安装。
 *
 * ## 四步流程与 Skill **原样相同**,一步都不能省
 *
 * ```
 * ① POST /api/client/plugins/{slug}/install   ← 拿授权 + **权威** sha256 + version
 * ② 校验返回的 version 与请求一致、sha256 形如 64 位 hex
 * ③ GET  .../versions/{version}/download      ← 下载,20MB 上限
 * ④ installer 校验 sha256 → 解压 → 写入插件目录
 * ```
 *
 * ★ 第 ① 步不是「多一次往返」:它在服务端强制 `plugins:install` scope,
 * 并给出**权威摘要**。跳过它、直接下载再自己算哈希,等于「摘要对得上」这句话
 * 只证明了下载到的文件和它自己一致 —— 中间被换掉的包一样能装上。
 *
 * ★ 第 ② 步校验 version 一致是防一种具体的错位:请求 1.2.0、服务端给 1.3.0 的
 * 摘要,而客户端下载 1.2.0 —— 校验必然失败,但失败信息会指向「包损坏」,
 * 而真正的原因是两边说的不是同一个版本。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PluginCatalog } from '../../shared/plugin/state'
import type { PluginMarketItem } from '../../shared/plugin/market'
import { getHost } from '../runtime'
import { getClientAccessToken, getClientAuthState } from './client-auth'
import { listPlugins, pluginManager } from './plugins'
import { IpcError } from './errors'

const MARKET_ORIGIN = process.env.NEXTCOWORK_MARKET_ORIGIN ?? 'https://nextco.work'
const MARKET_API_BASE = `${MARKET_ORIGIN}/api/`
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024

async function marketRequest(path: string): Promise<unknown> {
  const response = await getHost().fetch(new URL(path.replace(/^\//, ''), MARKET_API_BASE).href)
  if (!response.ok) throw new IpcError('network', `plugins.marketFailed:${String(response.status)}`)
  const body = (await response.json()) as { data?: unknown }
  return body.data ?? body
}

export async function listMarketPlugins(req: { q?: string; category?: string }): Promise<PluginMarketItem[]> {
  const params = new URLSearchParams()
  if (req.q !== undefined && req.q !== '') params.set('q', req.q.slice(0, 100))
  if (req.category !== undefined && req.category !== '') params.set('category', req.category)
  /*
    ★ **带上本机版本**。市场按 `engines` 过滤之后,列表里就不会再出现
    这台机器根本装不上的插件 —— 否则用户会点安装、失败,而市场那一侧
    从没提过这件事(计划 §10.2 第 3 条)。
  */
  params.set('client', hostVersion())
  const payload = (await marketRequest(`/plugins?${params.toString()}`)) as { items?: PluginMarketItem[] }
  return (payload.items ?? []).map(normalizeItem)
}

export async function listMarketPluginCategories(): Promise<string[]> {
  const payload = (await marketRequest('/plugins/categories')) as { categories?: string[] }
  return payload.categories ?? []
}

export async function marketPluginDetail(req: { slug: string }): Promise<PluginMarketItem & { versions?: { version: string; changelog?: string; permissionEscalated?: boolean }[] }> {
  const payload = (await marketRequest(`/plugins/${encodeURIComponent(req.slug)}`)) as {
    plugin?: PluginMarketItem
    versions?: { version: string; changelog?: string; permissionEscalated?: boolean }[]
  }
  return { ...normalizeItem(payload.plugin ?? ({} as PluginMarketItem)), ...(payload.versions === undefined ? {} : { versions: payload.versions }) }
}

export async function installMarketPlugin(req: { slug: string; version?: string }): Promise<PluginCatalog> {
  const manager = pluginManager()
  if (manager === null) throw new IpcError('unknown', 'plugins.notRunning')
  if (getClientAuthState().mode !== 'authenticated') throw new IpcError('auth', 'plugins.authRequired')
  const access = await getClientAccessToken()
  if (access === null) throw new IpcError('auth', 'plugins.authRequired')

  const detail = await marketPluginDetail({ slug: req.slug })
  const version = req.version ?? detail.version ?? detail.versions?.[0]?.version
  if (version === undefined || version === null) throw new IpcError('unknown', 'plugins.versionUnavailable')

  // ① 授权 + 权威摘要
  const grant = await getHost().fetch(`${MARKET_API_BASE}client/plugins/${encodeURIComponent(req.slug)}/install`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version })
  })
  if (!grant.ok) {
    throw new IpcError(
      grant.status === 401 ? 'auth' : 'unknown',
      grant.status === 403 ? 'plugins.scopeRequired' : grant.status === 401 ? 'plugins.authRequired' : grant.status === 404 ? 'plugins.versionUnavailable' : 'plugins.marketFailed'
    )
  }
  const grantBody = (await grant.json()) as { data?: GrantBody } & GrantBody
  const granted = grantBody.data ?? grantBody

  // ② 两项一起校验:版本对得上,摘要形状合法
  if (granted.version !== version || typeof granted.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(granted.sha256)) {
    throw new IpcError('unknown', 'plugins.digestMismatch')
  }

  // ③ 下载
  const response = await getHost().fetch(`${MARKET_API_BASE}plugins/${encodeURIComponent(req.slug)}/versions/${encodeURIComponent(version)}/download`)
  if (!response.ok) throw new IpcError('unknown', response.status === 404 ? 'plugins.versionUnavailable' : 'plugins.marketFailed')
  const bytes = await readDownload(response)

  // ④ 落到临时文件再交给 installer —— 它会**再校验一次** sha256 并做解压防线
  const tempDir = await fs.mkdtemp(join(getHost().paths.temp(), 'nextcowork-plugin-'))
  const temp = join(tempDir, `plugin-v${version.replace(/[^0-9A-Za-z.+-]/g, '')}.zip`)
  try {
    await fs.writeFile(temp, bytes)
    await manager.install(temp, granted.sha256)
    return listPlugins()
  } catch (error) {
    throw new IpcError('unknown', (error as Error).message)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface GrantBody {
  version?: string
  sha256?: string
  permissionEscalated?: boolean
}

async function readDownload(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_PACKAGE_BYTES) throw new IpcError('unknown', 'plugins.packageTooLarge')
  if (response.body === null) throw new IpcError('network', 'plugins.marketFailed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      // ★ 边读边卡上限,不是读完再看:读完再看意味着一个声称 1MB、实际 2GB
      //   的响应已经把内存吃光了。
      if (size > MAX_PACKAGE_BYTES) throw new IpcError('unknown', 'plugins.packageTooLarge')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

function normalizeItem(item: PluginMarketItem & { author?: unknown }): PluginMarketItem {
  const author = item.author
  return {
    ...item,
    permissions: Array.isArray(item.permissions) ? item.permissions : [],
    iconUrl: resolveIconUrl(item.iconUrl),
    author: author !== null && typeof author === 'object' ? String((author as { name?: unknown }).name ?? '') : String(author ?? '')
  }
}

/** 服务端给的是路径,渲染层跑在本地 origin 上 —— 在这一侧解析成绝对 URL。 */
function resolveIconUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim(), MARKET_API_BASE)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function hostVersion(): string {
  return listPlugins().hostVersion
}
