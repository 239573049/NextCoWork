/**
 * Skill 的 handler —— 「磁盘上那些目录」和「界面上那份清单」之间的接线员。
 *
 * 分工和 `ipc/mcp.ts` 一样:扫描与校验在内核(`kernel/skill/load.ts`,
 * 那一侧完全不认识 electron),开关状态在 `store`,这里只做三件事 ——
 * 触发扫描、把两份状态合成一份下发、写完之后广播。
 *
 * ## 两个开关是两件不同的事
 *
 * - `globalEnabled`:用户在设置页整个关掉了这条 Skill。存在 kv 里,
 *   而且存的是**被关掉的那些**(理由在 `store.getDisabledSkillIds`)。
 * - `activeInWorkspace`:这个工作区选装了哪几条。存在
 *   `WorkspaceSettings.activeSkillIds` 里,**空清单 = 全都要**
 *   (理由在 `SkillRegistry.resolve`)。
 *
 * 合起来才是「这一轮下发哪几条」,而那个合并只在 `runtime.ts` 的
 * `activeSkills()` 里做一次 —— 这里只负责把两份状态如实显示给用户。
 */
import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import type { SkillListItem, SkillMarketItem, SkillInstallScope } from '../../shared/domain/skill'
import { refreshSkills } from '../runtime'
import { getEnvironments, getHost, getWorkspaceEnvironment } from '../runtime'
import { EnvironmentError } from '../environment/errors'
import { EnvironmentFiles } from '../environment/files'
import { publishLocalDirectory } from '../environment/artifacts'
import { installSkillZip } from '../kernel/skill/install'
import { currentPluginSkillRoots, scanSkills } from '../kernel/skill/load'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { getClientAccessToken, getClientAuthState } from './client-auth'

const MARKET_ORIGIN = 'https://nextco.work'
const MARKET_API_BASE = `${MARKET_ORIGIN}/api/`

function broadcast(): void {
  windows.emitToAll('skills:changed', undefined)
}

/**
 * 装一条 Skill 走到哪一步了。市场安装与本地 ZIP 共用。
 *
 * ★ 全局广播,不是定向推:装 Skill 是全局副作用,别的窗口的市场页也该看到
 * 那颗按钮在跑。形状照抄 `plugins.ts` 的 `emitInstallProgress` —— 可选字段
 * 一律展开进去,不给 `undefined`(它穿过结构化克隆会变成「有这个键但没有值」)。
 */
function emitInstallProgress(
  key: string,
  phase: 'preparing' | 'downloading' | 'installing' | 'done' | 'failed',
  extra: { received?: number; total?: number; messageKey?: string } = {}
): void {
  windows.emitToAll('skills:installProgress', {
    key,
    phase,
    ...(extra.received === undefined ? {} : { received: extra.received }),
    ...(extra.total === undefined ? {} : { total: extra.total }),
    ...(extra.messageKey === undefined ? {} : { messageKey: extra.messageKey })
  })
}

/**
 * 主进程抛的是 key 不是句子 —— 认不出来的退回一句通用的。
 *
 * ★ 不能把 `error.message` 原样推出去:这条路上的错误有一半是
 * 「ZIP 包含非法路径」这种**给开发者看的**诊断,推到别的窗口就直接画在卡片上了。
 */
function installMessageKey(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message.startsWith('skills.') ? message : 'skills.operationFailed'
}

/**
 * 列出当前装了哪些。
 *
 * ★ **每次都重扫**,不返回上一次的缓存。用户刚往 `skills/` 里拖了一个目录
 * 就来看这个列表,而「关掉设置页再打开」并不会重扫 —— 那样他会以为装失败了。
 * 扫描是两次 readDir,开一次设置页的成本可以忽略。
 */
export async function listSkills(req: { workspaceId?: string }): Promise<SkillListItem[]> {
  const scanned = await refreshSkills(req.workspaceId ?? '')
  const environment = req.workspaceId ? getWorkspaceEnvironment(req.workspaceId) : undefined

  const disabled = new Set(store.getDisabledSkillIds())
  const active = activeIdsOf(req.workspaceId)
  const stats = store.getSkillStats(req.workspaceId)

  return scanned
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      sourceKind: s.source.kind,
      ...(s.scope !== undefined ? { scope: s.scope } : {}),
      ...(s.source.pluginId !== undefined ? { pluginId: s.source.pluginId } : {}),
      globalEnabled: !disabled.has(s.id),
      ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
      // 空清单 = 全都要,所以此时每一条显示的都是「已启用」
      activeInWorkspace: !s.unavailableReason && (active === null || (wsSelectionMode(req.workspaceId) !== 'explicit' && active.length === 0) || active.includes(s.id)),
      sourcePath: s.scope === 'project' && environment ? environment.path.dirname(s.source.path) : dirname(s.source.path),
      ...(s.source.version ? { version: s.source.version } : {}),
      ...(s.source.sha256 ? { sha256: s.source.sha256 } : {}),
      usageCount: stats[s.id]?.count ?? 0,
      lastUsedAt: stats[s.id]?.lastTriggeredAt || undefined
    }))
}

export async function skillDiagnostics(req: { workspaceId?: string }): Promise<Array<{ path: string; message: string }>> {
  const host = getHost()
  const environment = req.workspaceId ? getWorkspaceEnvironment(req.workspaceId) : undefined
  const result = await scanSkills({
    fs: host.fs,
    ...(environment?.remote ? { projectFs: environment.fs, projectPath: environment.path } : {}),
    globalRoot: join(host.paths.userData(), 'skills'),
    /*
      ★ 插件那一层也要扫,否则它的诊断永远到不了界面。

      插件 skill 最常见的坏法恰恰是**只有诊断能说清**的那几种:`SKILL.md` 缺
      `description`(整条作废)、两个插件撞了同一个名字(后来的被跳过)。
      漏掉这一行的症状是「插件页上写着提供了 3 条,Skill 列表里只有 2 条,
      而没有任何地方说第三条去哪了」。
    */
    pluginRoots: currentPluginSkillRoots(),
    projectRoot: environment?.rootPath ? await environment.path.resolveWithin(environment.rootPath, '.next-cowork/skills') : ''
  })
  return result.diagnostics.map((item) => ({ path: item.path, message: item.message }))
}

async function installRoot(scope: SkillInstallScope, workspaceId?: string): Promise<string> {
  if (scope === 'project') {
    if (!workspaceId) throw new EnvironmentError('unbound')
    const environment = getWorkspaceEnvironment(workspaceId)
    return environment.path.resolveWithin(environment.rootPath, '.next-cowork/skills')
  }
  return join(getHost().paths.userData(), 'skills')
}

async function installPackage(path: string, scope: SkillInstallScope, workspaceId?: string, checksum?: string): Promise<Awaited<ReturnType<typeof installSkillZip>>> {
  const lease = scope === 'project' && workspaceId ? getEnvironments().acquire(workspaceId) : undefined
  try {
    const root = await installRoot(scope, workspaceId)
    if (!lease?.environment.remote) return await installSkillZip(path, root, scope, checksum)
    const temporary = await fs.mkdtemp(join(getHost().paths.temp(), 'ncw-skill-upload-'))
    try {
      const installed = await installSkillZip(path, temporary, scope, checksum)
      const target = await publishLocalDirectory(lease.environment, installed.target, lease.environment.path.join(root, installed.name))
      return { ...installed, target }
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  } finally { lease?.release() }
}

export async function pickSkillZip(): Promise<{ path: string; name: string } | null> {
  const result = await dialog.showOpenDialog({ title: '选择 Skill ZIP', properties: ['openFile'], filters: [{ name: 'Skill ZIP', extensions: ['zip'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const path = result.filePaths[0]
  return { path, name: path.split(/[\\/]/).pop() ?? 'skill.zip' }
}

export async function installZip(req: { path: string; workspaceId?: string; scope?: SkillInstallScope }): Promise<SkillListItem> {
  const scope = req.scope ?? 'global'
  /*
    ★ key 里带上路径,不是一个固定的 `'local'`:多窗口、或者接连装两个本地包时,
    两条进度会挤在同一个 key 上互相覆盖 —— 表现是先装的那条被后装的接管,
    看起来像「卡住之后忽然跳完了」。同 `plugins.ts:installPlugin`。
  */
  const key = `local:${req.path}`
  // 本地包没有下载阶段。校验 + 解压通常是毫秒级,大包也就几秒 —— 但在那几秒里
  // 那颗按钮以前完全没有反馈。
  emitInstallProgress(key, 'installing')
  try {
    const installed = await installPackage(req.path, scope, req.workspaceId)
    const items = await listSkills(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId })
    const found = items.find((item) => item.name === installed.name)
    if (!found) throw new Error('Skill 安装后未能加载')
    broadcast()
    emitInstallProgress(key, 'done')
    return found
  } catch (error) {
    emitInstallProgress(key, 'failed', { messageKey: installMessageKey(error) })
    throw error
  }
}

async function marketRequest(path: string): Promise<unknown> {
  const response = await getHost().fetch(new URL(path.replace(/^\//, ''), MARKET_API_BASE).href)
  if (!response.ok) throw new Error(`市场请求失败: ${response.status}`)
  const body = await response.json() as { data?: unknown }
  return body.data ?? body
}

export async function listMarketSkills(req: { q?: string; category?: string }): Promise<SkillMarketItem[]> {
  const params = new URLSearchParams()
  if (req.q) params.set('q', req.q.slice(0, 100))
  if (req.category) params.set('category', req.category)
  const payload = await marketRequest(`/skills?${params}`) as { items?: SkillMarketItem[] }
  return (payload.items ?? []).map(normalizeMarketItem)
}

export async function listMarketCategories(): Promise<string[]> {
  const payload = await marketRequest('/skills/categories') as { categories?: string[] }
  return payload.categories ?? []
}

export async function marketSkillDetail(req: { slug: string }): Promise<SkillMarketItem & { versions?: Array<{ version: string; changelog?: string; sha256?: string; fileSize?: number }> }> {
  const payload = await marketRequest(`/skills/${encodeURIComponent(req.slug)}`) as { skill?: SkillMarketItem; versions?: Array<{ version: string; changelog?: string; sha256?: string; fileSize?: number }> }
  return { ...normalizeMarketItem(payload.skill ?? payload as unknown as SkillMarketItem), versions: payload.versions }
}

function normalizeMarketItem(item: SkillMarketItem & { author?: unknown }): SkillMarketItem {
  const author = item.author
  return { ...item, iconUrl: resolveMarketIconUrl(item.iconUrl), ...(author && typeof author === 'object' ? { author: String((author as { name?: unknown }).name ?? '') } : {}) }
}

function resolveMarketIconUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    // Resolve server paths before IPC: the renderer runs on a local origin.
    // URL preserves absolute CDN URLs and avoids duplicating /api for root paths.
    const url = new URL(value.trim(), MARKET_API_BASE)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export async function installMarketSkill(req: { slug: string; version?: string; workspaceId?: string; scope?: SkillInstallScope }): Promise<SkillListItem> {
  const key = `market:${req.slug}`
  try {
    return await runMarketInstall(key, req)
  } catch (error) {
    /*
      ★ 终态一定要推出去,成功失败都是。只 catch 不推的话,发起安装的那个窗口
      能从 invoke 的 rejection 里知道结果,而**别的窗口**手上只有事件 ——
      它们那颗按钮会一直转下去,直到 3 分钟的兜底把它扫掉。
    */
    emitInstallProgress(key, 'failed', { messageKey: installMessageKey(error) })
    throw error
  }
}

async function runMarketInstall(key: string, req: { slug: string; version?: string; workspaceId?: string; scope?: SkillInstallScope }): Promise<SkillListItem> {
  // 授权、问详情、要摘要都在这一档里:它们加起来常常比下载还久,而且一个
  // 百分比都报不出来 —— 渲染层据此画滚动斜纹,不是一条停在 0% 的条子。
  emitInstallProgress(key, 'preparing')
  if (getClientAuthState().mode !== 'authenticated') throw new Error('skills.authRequired')
  const access = await getClientAccessToken()
  if (!access) throw new Error('skills.authRequired')
  const detail = await marketSkillDetail({ slug: req.slug })
  const version = req.version ?? detail.version ?? detail.versions?.[0]?.version
  if (!version) throw new Error('市场没有可安装版本')
  // Ask the scoped desktop endpoint first. This enforces `skills:install` on
  // the server and gives us the authoritative version digest before download.
  const grant = await getHost().fetch(`${MARKET_API_BASE}client/skills/${encodeURIComponent(req.slug)}/install`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ version })
  })
  if (!grant.ok) throw new Error(grant.status === 403 ? 'skills.scopeRequired' : grant.status === 401 ? 'skills.authRequired' : grant.status === 404 ? 'skills.versionUnavailable' : 'skills.networkFailed')
  const grantBody = await grant.json() as { data?: { sha256?: string; version?: string }; sha256?: string; version?: string }
  const granted = grantBody.data ?? grantBody
  const expectedSha256 = granted.sha256
  if (granted.version !== version || !expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('skills.digestMismatch')
  const response = await getHost().fetch(`${MARKET_API_BASE}skills/${encodeURIComponent(req.slug)}/versions/${encodeURIComponent(version)}/download`)
  if (!response.ok) throw new Error(response.status === 404 ? 'skills.versionUnavailable' : 'skills.networkFailed')
  /*
    content-length 拿不到时退回详情页报的 fileSize —— 两个都没有的话 `total`
    就是 undefined,渲染层据此画一条没有百分比的条子。**不要在这里编一个估计值**:
    一条走到 80% 就停下不动的进度条,比一条明说「不知道还有多久」的更像卡死。
  */
  const declared = detail.versions?.find((item) => item.version === version)?.fileSize
  const header = Number(response.headers.get('content-length'))
  const total = Number.isFinite(header) && header > 0 ? header : declared
  emitInstallProgress(key, 'downloading', { received: 0, ...(total === undefined ? {} : { total }) })
  const bytes = await readDownload(response, (received) => {
    emitInstallProgress(key, 'downloading', { received, ...(total === undefined ? {} : { total }) })
  })
  // 解压 + 校验 + 重扫目录。没有百分比,但它不是瞬间 —— 尤其 project scope 还要
  // 把整个目录推到远端机器上。
  emitInstallProgress(key, 'installing')
  const tempDir = await fs.mkdtemp(join(getHost().paths.temp(), 'nextcowork-skill-'))
  const temp = join(tempDir, `skill-v${version.replace(/[^0-9A-Za-z.+-]/g, '')}.zip`)
  try {
    await fs.writeFile(temp, bytes)
    const installed = await installPackage(temp, req.scope ?? 'global', req.workspaceId, expectedSha256)
    const items = await listSkills(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId })
    const found = items.find((item) => item.name === installed.name)
    if (!found) throw new Error('Skill 安装后未能加载')
    broadcast()
    emitInstallProgress(key, 'done')
    return found
  } finally { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined) }
}

/** 进度推送的节流:至少隔这么久,或者又收了这么多字节,才推下一帧 */
const PROGRESS_MIN_INTERVAL_MS = 120
const PROGRESS_MIN_BYTES = 256 * 1024

async function readDownload(response: Response, onProgress?: (received: number) => void): Promise<Buffer> {
  const maxBytes = 20 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('skills.packageTooLarge')
  if (!response.body) throw new Error('skills.networkFailed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let reportedAt = 0
  let reportedBytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('skills.packageTooLarge') }
      chunks.push(chunk.value)
      /*
        ★ 节流是必需的,不是优化:一个 chunk 一帧的话,20MB 的包会推出上千条
        IPC 事件,而每一条都要在**每个窗口**里触发一次 zustand 更新和重渲染。
        进度条本身只有 100 个可见状态,多出来的那些帧一像素都改不动。
      */
      const now = Date.now()
      if (reportedAt === 0 || now - reportedAt >= PROGRESS_MIN_INTERVAL_MS || size - reportedBytes >= PROGRESS_MIN_BYTES) {
        reportedAt = now
        reportedBytes = size
        onProgress?.(size)
      }
    }
  } finally { reader.releaseLock() }
  // 节流会把最后一帧吞掉,于是条子停在 97% 而包其实已经下完了 —— 补一帧
  if (reportedBytes !== size) onProgress?.(size)
  return Buffer.concat(chunks, size)
}

export async function uninstallSkill(req: { skillId: string; workspaceId?: string; scope?: SkillInstallScope }): Promise<void> {
  const items = await listSkills(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId })
  const target = items.find((item) => item.id === req.skillId)
  if (!target?.sourcePath) throw new Error('找不到 Skill 安装位置')
  const scope = req.scope ?? (target.scope === 'project' ? 'project' : 'global')
  const expectedRoot = await installRoot(scope, req.workspaceId)
  if (scope === 'project' && req.workspaceId) {
    const lease = getEnvironments().acquire(req.workspaceId)
    try {
      if (lease.environment.remote) {
        const resolved = await lease.environment.path.resolveWithin(expectedRoot, target.sourcePath)
        if (resolved === expectedRoot) throw new EnvironmentError('invalid-path')
        await new EnvironmentFiles(lease.environment).mutate({ workspaceId: req.workspaceId, path: resolved, operation: 'delete' })
        broadcast()
        return
      }
    } finally { lease.release() }
  }
  const resolved = await fs.realpath(target.sourcePath).catch(() => target.sourcePath as string)
  const root = await fs.realpath(expectedRoot).catch(() => expectedRoot)
  if (!(resolved === root || resolved.startsWith(root + '/'))) throw new Error('Skill 安装位置无效')
  await fs.rm(resolved, { recursive: true, force: true })
  broadcast()
}

export function setSkillGlobalEnabled(req: { skillId: string; enabled: boolean }): void {
  store.setSkillGlobalEnabled(req.skillId, req.enabled)
  broadcast()
}

/**
 * 在某个工作区里选装 / 取消选装一条。
 *
 * ★ 这里有一处**必须显式处理**的不对称,来自「空清单 = 全都要」这个语义:
 *
 * 空清单时把某一条关掉,不能只是「从空清单里删掉它」(那是个空操作,
 * 用户点了开关却什么都没发生)。得先把**当前所有 Skill 的 id 铺开**,
 * 再从里面去掉这一条 —— 也就是把隐式的「全都要」物化成一份显式清单。
 *
 * 代价是这之后新装的 Skill 在这个工作区默认不生效了。这是对的:用户
 * 一旦手动选装过,「我选的就是我要的」比「悄悄给你加一条」更符合预期。
 */
export async function setSkillWorkspaceActive(req: {
  skillId: string
  workspaceId: string
  active: boolean
}): Promise<void> {
  const scanned = await refreshSkills(req.workspaceId)
  const ws = store.getWorkspace(req.workspaceId)
  if (ws === undefined) throw new Error(`没有 id 为 "${req.workspaceId}" 的工作区。`)

  /**
   * ★ 权威闸门在这里，不在渲染层。
   *
   * 依赖本机资源的技能在 SSH 工作区里跑不了:`runtime.ts` 的 `activeSkills()` 会按
   * `unavailableReason` 把它过滤掉,`tool/builtin/skill.ts` 也会拒绝执行。但在此之前
   * **没有任何一处拦住"打开这个开关"** —— 于是 `activeSkillIds` 里留下一条永远不会
   * 生效的 id,界面显示「已启用」,模型那边却被静默排除。界面在撒谎比功能缺失更糟。
   *
   * 渲染层有三个入口(列表行 Toggle、卡片网格 Toggle、详情弹窗「使用」),历史上只有
   * 第一个做了判断。把闸门放在主进程,三个入口就不可能各自漏掉。
   */
  if (req.active && scanned.find((skill) => skill.id === req.skillId)?.unavailableReason) {
    throw new Error('skills.clientAssetsUnavailable')
  }

  const current = ws.settings.activeSkillIds
  const all = scanned.map((s) => s.id)
  // 隐式的「全都要」在这里物化,否则关掉一条会是个空操作
  const base = current.length === 0 && ws.settings.skillSelectionMode !== 'explicit' ? all : current

  const next = req.active
    ? [...new Set([...base, req.skillId])]
    : base.filter((id) => id !== req.skillId)

  store.putWorkspace({ ...ws, settings: { ...ws.settings, activeSkillIds: next, skillSelectionMode: 'explicit' } })
  broadcast()
}

/** `null` = 没指定工作区(全局设置页),此时不谈「在这个工作区激活」。 */
function activeIdsOf(workspaceId: string | undefined): string[] | null {
  if (workspaceId === undefined) return null
  return store.getWorkspace(workspaceId)?.settings.activeSkillIds ?? null
}

function wsSelectionMode(workspaceId: string | undefined): 'all' | 'explicit' | undefined {
  if (workspaceId === undefined) return undefined
  return store.getWorkspace(workspaceId)?.settings.skillSelectionMode
}
