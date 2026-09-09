/**
 * 图片主题的文件仓库 —— 设置 › 偏好 › 图片主题里那颗「上传图片」。
 *
 * ★ **渲染层永不指定任意路径**(方案 §9)。选文件走主进程 dialog;之后每一次
 * 读写都是 **id → 查表 → 路径**:渲染层递进来的 id 只用来在表里查一条记录,
 * 拿到的是主进程当初自己写下的那个文件名。**id 本身从不参与 `join`** ——
 * 那正是 `../../` 能穿出去的地方,而这里根本没有那条缝。
 *
 * ★ **导入分两相**(理由写在契约的 `ImportedImage` 上):主进程没有 canvas,
 * 算不出种子色。第一相收文件、回字节;第二相收渲染层算好的 seed/palette 落表。
 *
 * 索引是一个 JSON 文件,不是 SQLite —— 这坨数据五个字段、几十条上限、
 * 只在设置页读写。为它加一张表加一条迁移,换来的还是同样一次 `readFileSync`。
 */
import { app, dialog, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { resolveImageTheme, type ImageTheme, type ThemeProfile } from '../../shared/domain/theme'
import { builtinProfiles, DEFAULT_PROFILE_ID, isThemeProfile, legacyStudioOf, migrateThemeProfile, wallpaperFor } from '../../shared/domain/theme-profile'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { buildNcwUrl } from '../../shared/domain/attachment'
import type { ImportedImage, ThemeImageMetadata } from '../../shared/ipc/contract'
import { prefixedId } from '../../shared/util/id'
import { attachmentRoot } from '../net/attachment-protocol'
import { getHost } from '../runtime'
import { IpcError } from './errors'

/**
 * 收哪些格式。**这张表同时是扩展名白名单和 mime 白名单** ——
 * 文件名里的扩展名只用来查它,查不到就拒;落盘时的扩展名反过来由 mime 推,
 * 所以磁盘上的文件名两端都是我们自己给的常量,没有一个字符来自外部。
 *
 * 口径跟着 Chromium 的 `createImageBitmap` 走(解码在渲染层做),
 * 多收一个格式的代价是用户选了、上传了、然后卡在解码失败上。
 */
const MIME_OF: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const EXT_OF: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

/**
 * 单张上限 16MB。这不是「够不够用」的数字,是「字节要过一次 IPC 结构化克隆」——
 * 一张 200MB 的 raw 位图会让主线程停在那儿,而用户只是点错了一个文件。
 */
const MAX_BYTES = 16 * 1024 * 1024
/** 表长上限。userData 是我们替用户占的地方,不设上限就是不设上限。 */
const MAX_ITEMS = 40
/** 名字裁到这个长度 —— 它只是卡片上那行字 */
const MAX_NAME = 48

/**
 * ★ 只有 `prefixedId('img')` 生成的形状才认。索引是磁盘上的 JSON,
 * 手改得动;这一条挡的是「有人把 id 改成 `../../../../etc/passwd`」。
 * Crockford base32 全是 `[0-9A-Z]`,连点都出不来。
 */
const ID_RE = /^img_[0-9A-Z]{26}$/
const HEX_RE = /^#[0-9a-f]{6}$/i

interface StoredItem {
  id: string
  name: string
  mime: string
  seed: string
  palette: string[]
  width?: number
  height?: number
  bytes?: number
  animated?: boolean
  thumbnail?: boolean
  fileName?: string
  createdAt?: number
  lastUsedAt?: number
}

// ═══════════════════════════════════════════════════════════════
// 目录与索引
// ═══════════════════════════════════════════════════════════════

/**
 * 主题图的目录。
 *
 * ★ **从 `userData/themes/` 迁到了 `userData/attachments/themes/`** ——
 * 与会话附件同根,这样 `ncw://attachments/themes/…` 能直接寻址到它们。
 * 迁移由 `migrateLegacyThemesDir()` 在启动时做一次。
 *
 * ★ 根取自 `attachmentRoot()` 而不是自己拼:协议 handler 与清理扫描
 * 读的必须是**同一个**目录,两处各拼一次早晚会分岔(dev 下 userData 还带 `-dev` 后缀)。
 */
function themesDir(): string {
  const dir = join(attachmentRoot(), 'themes')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 迁移前的位置。只在启动搬运时用到 */
function legacyThemesDir(): string {
  // 旧版本把主题放在 Electron userData/themes;保留一次性迁移入口。
  return join(app.getPath('userData'), 'themes')
}

/** 磁盘文件名。两个部件都已经过白名单,没有一个字符来自外部 */
function fileNameOf(item: StoredItem): string {
  return `${item.id}${EXT_OF[item.mime] ?? '.png'}`
}

/** ★ 唯一一处由 id 拼出文件名的地方,两个部件都已经过白名单 */
function fileOf(item: StoredItem): string {
  return join(themesDir(), fileNameOf(item))
}

function indexFile(): string {
  return join(themesDir(), 'index.json')
}

function profilesFile(): string { return join(themesDir(), 'profiles.json') }
function readProfiles(): ThemeProfile[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(profilesFile(), 'utf8'))
    return Array.isArray(raw) ? raw.filter(isThemeProfile) : []
  } catch { return [] }
}
function writeProfiles(items: readonly ThemeProfile[]): void {
  const tmp = `${profilesFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8')
  renameSync(tmp, profilesFile())
}

export function listProfiles(): ThemeProfile[] { return readProfiles() }
export function initializeThemeLibrary(): void {
  let profiles = readProfiles()
  const settings = store.getSettings()
  if (!profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) {
    profiles = [...builtinProfiles(), ...profiles.filter((p) => !p.id.startsWith('builtin-'))]
    if (settings.activeThemeProfileId === null && !profiles.some((p) => p.id === 'migrated-theme')) {
      profiles.push(migrateThemeProfile(settings, listImages()))
      store.updateSettings({ activeThemeProfileId: 'migrated-theme' })
    }
    writeProfiles(profiles)
  }
  const active = store.getSettings().activeThemeProfileId
  if (!profiles.some((p) => p.id === active)) store.updateSettings({ activeThemeProfileId: DEFAULT_PROFILE_ID })
}
export function profileSettings(id: string | null): { activeThemeProfileId: string; themeStudio: ReturnType<typeof legacyStudioOf>; imageTheme: { id: string | null; render: 'blur' | 'overlay' } } {
  initializeThemeLibrary()
  const profile = readProfiles().find((p) => p.id === id) ?? readProfiles().find((p) => p.id === DEFAULT_PROFILE_ID)!
  const themeStudio = legacyStudioOf(profile)
  return { activeThemeProfileId: profile.id, themeStudio, imageTheme: { id: themeStudio.wallpaperAssetId, render: themeStudio.render } }
}
function broadcastLibrary(): void {
  windows.emitToAll('theme:libraryChanged', { profiles: readProfiles(), images: listImages() })
}
/** Keep legacy settings callers (including older windows and integrations) reflected in the active profile. */
export function syncLegacyProfile(settings: ReturnType<typeof store.getSettings>, patch: { colorTheme?: unknown; imageTheme?: unknown }): void {
  if (patch.colorTheme === undefined && patch.imageTheme === undefined) return
  const items = readProfiles(); const active = items.find((p) => p.id === settings.activeThemeProfileId)
  if (!active || active.builtin === true) return
  if (patch.colorTheme !== undefined) {
    active.palette.base = { ...settings.colorTheme }
    if (active.wallpaper === null) active.palette.seed = settings.colorTheme.custom
  }
  if (patch.imageTheme !== undefined) {
    const image = resolveImageTheme(settings.imageTheme.id, listImages())
    active.wallpaper = image ? { ...wallpaperFor(image.id), render: settings.imageTheme.render } : null
    if (image) active.palette.seed = image.seed
  }
  active.updatedAt = Date.now(); writeProfiles(items); broadcastLibrary()
}
export function saveProfile(profile: ThemeProfile): ThemeProfile[] {
  if (!isThemeProfile(profile)) throw new IpcError('unknown', '主题配置无效')
  const items = readProfiles()
  if (profile.builtin || profile.id.startsWith('builtin-') || items.find((p) => p.id === profile.id)?.builtin) throw new IpcError('unknown', '内置主题不能修改')
  if (!items.some((p) => p.id === profile.id) && items.length >= 100) throw new IpcError('unknown', '主题库已满')
  if (profile.wallpaper && !listImages().some((i) => i.id === profile.wallpaper?.assetId) && !builtinProfiles().some((p) => p.wallpaper?.assetId === profile.wallpaper?.assetId)) throw new IpcError('unknown', '图片资产不存在')
  const now = Date.now()
  const next = { ...profile, updatedAt: now, createdAt: profile.createdAt || now }
  const index = items.findIndex((item) => item.id === profile.id)
  if (index >= 0) items[index] = next
  else items.unshift(next)
  writeProfiles(items)
  broadcastLibrary()
  if (store.getSettings().activeThemeProfileId === profile.id) {
    const selected = profileSettings(profile.id)
    windows.emitToAll('settings:changed', store.updateSettings(selected))
  }
  return readProfiles()
}
export function deleteProfile(id: string): ThemeProfile[] {
  const item = readProfiles().find((profile) => profile.id === id)
  if (item?.builtin === true) throw new IpcError('unknown', '内置主题不能删除')
  const rest = readProfiles().filter((profile) => profile.id !== id)
  writeProfiles(rest)
  if (store.getSettings().activeThemeProfileId === id) {
    const selected = profileSettings(DEFAULT_PROFILE_ID)
    windows.emitToAll('settings:changed', store.updateSettings(selected))
  }
  broadcastLibrary()
  return rest
}
export function renameProfile(req: { id: string; name: string }): ThemeProfile[] {
  const items = readProfiles(); const item = items.find((profile) => profile.id === req.id)
  if (item === undefined) throw new IpcError('unknown', '找不到主题')
  if (item.builtin === true) throw new IpcError('unknown', '内置主题不能重命名')
  item.name = cleanName(req.name); item.updatedAt = Date.now(); writeProfiles(items); broadcastLibrary(); return items
}

/**
 * 逐条校验后再收下。**磁盘上的东西是不可信输入** —— 它可能被手改过、
 * 被半截写坏过、也可能是上一个版本写的。一条坏记录不该带走整张表,
 * 所以这里是「筛掉」而不是「抛」。
 */
function readIndex(): StoredItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(indexFile(), 'utf8'))
  } catch {
    // 没有这个文件是最常见的情况(还没传过图),不值一条日志
    return []
  }
  if (!Array.isArray(raw)) return []

  const out: StoredItem[] = []
  for (const row of raw as unknown[]) {
    const item = row as Partial<StoredItem>
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) continue
    if (typeof item.mime !== 'string' || EXT_OF[item.mime] === undefined) continue
    if (typeof item.seed !== 'string' || !HEX_RE.test(item.seed)) continue
    if (typeof item.name !== 'string') continue
    const palette = Array.isArray(item.palette)
      ? item.palette.filter((c): c is string => typeof c === 'string' && HEX_RE.test(c))
      : []
    out.push({ id: item.id, name: cleanName(item.name), mime: item.mime, seed: item.seed, palette,
      width: typeof item.width === 'number' && item.width > 0 ? item.width : undefined,
      height: typeof item.height === 'number' && item.height > 0 ? item.height : undefined,
      bytes: typeof item.bytes === 'number' && item.bytes >= 0 ? item.bytes : undefined,
      animated: item.animated === true, thumbnail: item.thumbnail === true,
      fileName: typeof item.fileName === 'string' ? basename(item.fileName) : undefined,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : undefined,
      lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : undefined })
  }
  return out
}

/**
 * 先写临时文件再 rename。**rename 在同一个文件系统内是原子的** ——
 * 直接覆盖写的话,一次断电就能把整张表变成半个 JSON,而那意味着
 * 用户传过的每一张图**同时**消失(文件还在,索引没了就都读不出来)。
 */
function writeIndex(items: readonly StoredItem[]): void {
  const tmp = `${indexFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8')
  renameSync(tmp, indexFile())
}

function toTheme(item: StoredItem): ImageTheme {
  const url = buildNcwUrl({ scope: 'theme', fileName: fileNameOf(item) })
  return {
    id: item.id,
    name: item.name,
    // ★ url 由主进程给,渲染层不拼 —— 目录结构不该变成跨进程契约
    source: { kind: 'uploaded', assetId: item.id, url: url ?? '' },
    seed: item.seed,
    palette: item.palette,
    width: item.width, height: item.height, bytes: item.bytes, animated: item.animated,
    mime: item.mime, fileName: item.fileName, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt,
    thumbnailUrl: item.thumbnail && existsSync(join(themesDir(), `${item.id}-thumb.png`)) ? buildNcwUrl({ scope: 'theme', fileName: `${item.id}-thumb.png` }) ?? undefined : undefined,
    unavailable: !existsSync(fileOf(item))
  }
}

/** 控制字符会把卡片上那行字弄成一片空白,顺手裁长度 */
function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  return (flat.slice(0, MAX_NAME) || '未命名').trim()
}

/**
 * `Buffer` → 一块**明确由 `ArrayBuffer` 撑着**的 `Uint8Array`。
 *
 * 理由写在契约的 `ImportedImage.bytes` 上:渲染层拿这些字节唯一要做的事是建 Blob,
 * 而 `BlobPart` 不收 `ArrayBufferLike`(那里面含着 `SharedArrayBuffer`)。
 * `readFileSync` 给的 `Buffer` 恰好就推成 `ArrayBufferLike`。
 *
 * `set` 是一次 memcpy。换成 `Uint8Array.from` 类型也对,但那是逐元素迭代 ——
 * 16MB 的图上差得出来。
 */
function toBytes(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}

// ═══════════════════════════════════════════════════════════════
// 导入 —— 第一相
// ═══════════════════════════════════════════════════════════════

/**
 * 已收进目录、但还没登记的那些。`saveImage` **只认这张表里的 id** ——
 * 于是「渲染层递一个 id 进来要求登记」这条路,天然只能落在
 * 主进程刚刚自己发出去的那个 id 上。
 */
const pending = new Map<string, { path: string; mime: string; fileName: string }>()
/** 同时挂着的导入不该超过这么多 —— 它只由用户一次次点开对话框推进 */
const MAX_PENDING = 8

export async function importImage(): Promise<ImportedImage | null> {
  const r = await dialog.showOpenDialog({
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  })
  const picked = r.canceled ? undefined : r.filePaths[0]
  if (!picked) return null

  // ★ 对话框的 filters 是**建议**,不是约束:某些平台上文件名可以手打。
  //   真正拦住格式的是这一句。
  const mime = MIME_OF[extname(picked).toLowerCase()]
  if (mime === undefined) throw new IpcError('unknown', '只支持 PNG / JPEG / WebP / GIF / BMP')

  if (statSync(picked).size > MAX_BYTES) {
    throw new IpcError('unknown', `图片超过 ${MAX_BYTES / 1024 / 1024}MB`)
  }
  if (readIndex().length >= MAX_ITEMS) {
    throw new IpcError('unknown', `最多只能保留 ${MAX_ITEMS} 张背景图,先删掉几张`)
  }

  // 读一次、写一次,而不是 copyFile 之后再读 —— 中间隔着的那一下,
  // 源文件可能已经被别的进程换掉了,于是回给渲染层的字节和落盘的不是同一张图
  const bytes = readFileSync(picked)
  if (bytes.length > MAX_BYTES) throw new IpcError('unknown', '图片过大')
  const signature = bytes.subarray(0, 12)
  const valid = mime === 'image/png' ? signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    mime === 'image/jpeg' ? signature[0] === 255 && signature[1] === 216 :
    mime === 'image/gif' ? /^GIF8[79]a/.test(signature.toString('ascii')) :
    mime === 'image/webp' ? signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP' : signature.toString('ascii', 0, 2) === 'BM'
  if (!valid) throw new IpcError('unknown', '图片格式与文件内容不一致')
  const id = prefixedId('img')
  const path = join(themesDir(), `${id}${EXT_OF[mime] ?? '.png'}`)
  writeFileSync(path, bytes)

  evictPending()
  pending.set(id, { path, mime, fileName: basename(picked) })

  return {
    id,
    name: cleanName(basename(picked, extname(picked))),
    mime,
    bytes: toBytes(bytes)
  }
}

/** 挂太久的导入连文件一起清掉 —— 提前把 `sweepOrphans` 该做的事做了 */
function evictPending(): void {
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next()
    if (oldest.done) return
    const entry = pending.get(oldest.value)
    pending.delete(oldest.value)
    if (entry) rmSync(entry.path, { force: true })
  }
}

// ═══════════════════════════════════════════════════════════════
// 导入 —— 第二相,以及其余读写
// ═══════════════════════════════════════════════════════════════

export function saveImage(req: {
  id: string
  name: string
  seed: string
  palette: string[]
  metadata?: ThemeImageMetadata
}): ImageTheme[] {
  // ★ 只认刚刚由 importImage 发出去的 id。渲染层编不出一个能通过这一句的 id ——
  //   它不知道我们生成了什么,而这张表在进程内存里
  const entry = pending.get(req.id)
  if (entry === undefined) throw new IpcError('unknown', '这次导入已经失效,请重新选择图片')

  // 颜色是要写进 `style` 和 CSS 变量的,必须是我们认识的形状
  if (!HEX_RE.test(req.seed)) throw new IpcError('unknown', '种子色不是合法的 #rrggbb')
  const palette = req.palette.filter((c) => HEX_RE.test(c)).slice(0, 8)

  const items = readIndex()
  if (items.length >= MAX_ITEMS) throw new IpcError('unknown', '图片资产库已满')
  const meta = req.metadata
  if (meta) {
    if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width * meta.height > 200_000_000 ||
        !(meta.thumbnail instanceof Uint8Array) || meta.thumbnail.length > 2 * 1024 * 1024) throw new IpcError('unknown', '图片元数据无效')
    const image = nativeImage.createFromBuffer(Buffer.from(meta.thumbnail))
    if (image.isEmpty() || image.getSize().width > 512 || image.getSize().height > 512) throw new IpcError('unknown', '缩略图无效')
    writeFileSync(join(themesDir(), `${req.id}-thumb.png`), image.toPNG())
  }
  items.unshift({
    id: req.id,
    name: cleanName(req.name),
    mime: entry.mime,
    seed: req.seed.toLowerCase(),
    palette,
    width: meta?.width, height: meta?.height, animated: meta?.animated ?? false, thumbnail: !!meta,
    bytes: statSync(entry.path).size, fileName: entry.fileName, createdAt: Date.now(), lastUsedAt: Date.now()
  })
  writeIndex(items)
  pending.delete(req.id)
  broadcastLibrary()
  return items.map(toTheme)
}

export function listImages(): ImageTheme[] {
  return readIndex().map(toTheme)
}

export function readImage(req: { id: string }): { mime: string; bytes: Uint8Array<ArrayBuffer> } {
  // ★ id → 查表 → 路径。`fileOf` 拿到的是**表里那条记录**,不是渲染层给的字符串
  const item = readIndex().find((t) => t.id === req.id)
  if (item === undefined) throw new IpcError('unknown', '找不到这张背景图')
  try {
    return { mime: item.mime, bytes: toBytes(readFileSync(fileOf(item))) }
  } catch {
    // 文件被人从 userData 里删了。表还在,但这条已经没有内容了 —— 顺手清掉,
    // 否则这张卡会一直挂在设置页上,点一次报一次错
    throw new IpcError('unknown', '这张背景图的文件已经不在了')
  }
}

export function deleteImage(req: { id: string }): ImageTheme[] {
  const items = readIndex()
  const item = items.find((t) => t.id === req.id)
  if (item === undefined) return items.map(toTheme)

  const rest = items.filter((t) => t.id !== req.id)
  // 先写表再删文件:反过来的话,删完文件、写表前崩溃,留下的是一条
  // 读不出内容的记录 —— 而现在留下的是一个没人引用的文件,下次启动扫掉
  writeIndex(rest)
  rmSync(fileOf(item), { force: true })
  rmSync(join(themesDir(), `${item.id}-thumb.png`), { force: true })
  const profiles = readProfiles()
  const active = profiles.find((p) => p.id === store.getSettings().activeThemeProfileId)
  const activeDeleted = active?.wallpaper?.assetId === req.id
  for (const p of profiles) if (p.wallpaper?.assetId === req.id) { p.wallpaper = null; p.updatedAt = Date.now() }
  writeProfiles(profiles)
  if (activeDeleted || store.getSettings().imageTheme.id === req.id) windows.emitToAll('settings:changed', store.updateSettings(profileSettings(DEFAULT_PROFILE_ID)))
  broadcastLibrary()
  return rest.map(toTheme)
}

/**
 * 扫掉没进表的文件 —— 两相导入中途放弃留下的那种(见契约的 `ImportedImage`)。
 * 启动时跑一次:这时候 `pending` 必然是空的,所以「不在表里」就等于「没人要」。
 */
/**
 * 把 `userData/themes/` 搬到 `userData/attachments/themes/`。**启动时一次,幂等。**
 *
 * ★ 用 `renameSync` 而不是拷贝+删:同一文件系统内 rename 是原子的,
 * 中途断电要么在旧位置要么在新位置,不会出现半个文件。
 *
 * ★ **目标已存在就跳过而不是覆盖**:那意味着上一次搬运已经处理过这个文件,
 * 而旧位置残留的是它的副本。覆盖会用一个可能更旧的文件盖掉现役的那个。
 *
 * 搬完删掉旧目录 —— 留着的话下次启动还会再扫一遍,而且用户会在 userData 里
 * 看到两个 themes 目录不知道哪个是真的。
 */
export function migrateLegacyThemesDir(): void {
  const from = legacyThemesDir()
  if (!existsSync(from)) return

  const to = themesDir()
  let moved = 0
  try {
    for (const name of readdirSync(from)) {
      const src = join(from, name)
      const dst = join(to, name)
      if (existsSync(dst)) {
        rmSync(src, { force: true })
        continue
      }
      try {
        renameSync(src, dst)
        moved++
      } catch {
        // 跨设备(用户把 userData 做成了软链)时 rename 会失败,退回拷贝
        try {
          writeFileSync(dst, readFileSync(src))
          rmSync(src, { force: true })
          moved++
        } catch {
          // 这一张搬不动就留在原地,下次启动再试。不因为一张图中断整批
        }
      }
    }
    // 空了才删目录:还有搬不动的文件时留着,否则那些文件就永久失联了
    if (readdirSync(from).length === 0) rmSync(from, { recursive: true, force: true })
  } catch (err) {
    console.warn('[theme] 主题目录迁移未完成,下次启动会重试:', err)
  }
  if (moved > 0) console.log(`[theme] 已迁移 ${String(moved)} 个主题文件到 attachments/themes/`)
}

export function sweepOrphans(): void {  try {
    const keep = new Set(readIndex().flatMap((t) => [basename(fileOf(t)), `${t.id}-thumb.png`]))
    for (const name of readdirSync(themesDir())) {
      if (name === 'index.json' || name === 'profiles.json' || keep.has(name)) continue
      rmSync(join(themesDir(), name), { force: true })
    }
  } catch (err) {
    // 扫地失败不该拦住启动 —— 最坏的结果只是 userData 里多几个文件
    getHost().logger.warn(`[theme] 清理孤儿图片失败:${String(err)}`)
  }
}
