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
import { dialog } from 'electron'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ImageTheme } from '../../shared/domain/theme'
import type { ImportedImage } from '../../shared/ipc/contract'
import { prefixedId } from '../../shared/util/id'
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
}

// ═══════════════════════════════════════════════════════════════
// 目录与索引
// ═══════════════════════════════════════════════════════════════

function themesDir(): string {
  const dir = join(getHost().paths.userData(), 'themes')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ★ 唯一一处由 id 拼出文件名的地方,两个部件都已经过白名单 */
function fileOf(item: StoredItem): string {
  return join(themesDir(), `${item.id}${EXT_OF[item.mime] ?? '.png'}`)
}

function indexFile(): string {
  return join(themesDir(), 'index.json')
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
    out.push({ id: item.id, name: cleanName(item.name), mime: item.mime, seed: item.seed, palette })
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
  return {
    id: item.id,
    name: item.name,
    source: { kind: 'uploaded', assetId: item.id },
    seed: item.seed,
    palette: item.palette
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
const pending = new Map<string, { path: string; mime: string }>()
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
  const id = prefixedId('img')
  const path = join(themesDir(), `${id}${EXT_OF[mime] ?? '.png'}`)
  writeFileSync(path, bytes)

  evictPending()
  pending.set(id, { path, mime })

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
}): ImageTheme[] {
  // ★ 只认刚刚由 importImage 发出去的 id。渲染层编不出一个能通过这一句的 id ——
  //   它不知道我们生成了什么,而这张表在进程内存里
  const entry = pending.get(req.id)
  if (entry === undefined) throw new IpcError('unknown', '这次导入已经失效,请重新选择图片')

  // 颜色是要写进 `style` 和 CSS 变量的,必须是我们认识的形状
  if (!HEX_RE.test(req.seed)) throw new IpcError('unknown', '种子色不是合法的 #rrggbb')
  const palette = req.palette.filter((c) => HEX_RE.test(c)).slice(0, 8)

  pending.delete(req.id)
  const items = readIndex()
  items.unshift({
    id: req.id,
    name: cleanName(req.name),
    mime: entry.mime,
    seed: req.seed.toLowerCase(),
    palette
  })
  writeIndex(items)
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
    writeIndex(readIndex().filter((t) => t.id !== req.id))
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
  return rest.map(toTheme)
}

/**
 * 扫掉没进表的文件 —— 两相导入中途放弃留下的那种(见契约的 `ImportedImage`)。
 * 启动时跑一次:这时候 `pending` 必然是空的,所以「不在表里」就等于「没人要」。
 */
export function sweepOrphans(): void {
  try {
    const keep = new Set(readIndex().map((t) => basename(fileOf(t))))
    for (const name of readdirSync(themesDir())) {
      if (name === 'index.json' || keep.has(name)) continue
      rmSync(join(themesDir(), name), { force: true })
    }
  } catch (err) {
    // 扫地失败不该拦住启动 —— 最坏的结果只是 userData 里多几个文件
    getHost().logger.warn(`[theme] 清理孤儿图片失败:${String(err)}`)
  }
}
