/**
 * 本机数据管理的主进程实现。
 *
 * 所有路径、对话框、数据库快照和删除操作都集中在这里；渲染层只收到
 * 结构化结果，不能把任意路径传进来。归档使用无压缩 ZIP（读取时同时支持
 * deflate），不依赖系统 zip 命令，因此打包到另一台设备仍可恢复。
 */
import { app, dialog, shell } from 'electron'
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  realpathSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type {
  BackupManifest,
  BackupStatus,
  CleanupAge,
  CleanupPreview,
  CleanupResult,
  DataExport,
  EncryptedCredentials,
  ImportApplyResult,
  ImportPreview,
  RestorePreview,
  RestoreResult
} from '../../shared/domain/data'
import {
  BACKUP_FORMAT_VERSION,
  DATA_EXPORT_VERSION,
  cutoffForAge,
  dataMergeDecision,
  isDataExport
} from '../../shared/domain/data'
import { DEFAULT_SETTINGS, mergeSettings, type StorageStats } from '../../shared/domain/settings'
import { mcpSecretKind, mcpSecretRef } from '../../shared/domain/mcp'
import { searchSecretRef } from '../../shared/domain/search'
import { DRAFT_ATTACHMENT_TTL_MS } from '../../shared/domain/attachment'
import { databaseDirectory, databaseFilePath, databaseSchemaVersion, checkpointDatabase, closeDatabase, openDatabase, txAsync, vacuumDatabase } from '../db'
import { MIGRATIONS } from '../db/schema'
import * as repo from '../db/repo'
import { getHost } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { PROXY_PASSWORD_REF } from '../net/proxy'
import { IpcError } from './errors'
import { runs } from '../kernel/run-registry'

const BACKUP_STATUS_KEY = 'data.backup.status'
const ATTACHMENTS_DIR = 'attachments'
const BACKUP_EXT = '.ncwbackup'
const AUTO_BACKUP_RE = /^nextcowork-auto\.ncwbackup$/
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024
const pendingImports = new Map<number, DataExport>()
const pendingImportPaths = new Map<number, string>()
let importSeq = 0
let pendingRestore: { path: string; preview: RestorePreview } | null = null
let backupRunning = false

interface StoredBackupStatus {
  lastBackupAt: number | null
  lastBackupPath: string | null
  lastError: string | null
}

function dataDirectory(): string {
  return databaseDirectory()
}

function attachmentDirectory(): string {
  return join(dataDirectory(), ATTACHMENTS_DIR)
}

function readBackupStatus(): StoredBackupStatus {
  const raw = store.getKv<unknown>(BACKUP_STATUS_KEY, null)
  if (typeof raw !== 'object' || raw === null) return { lastBackupAt: null, lastBackupPath: null, lastError: null }
  const r = raw as Record<string, unknown>
  return {
    lastBackupAt: typeof r.lastBackupAt === 'number' ? r.lastBackupAt : null,
    lastBackupPath: typeof r.lastBackupPath === 'string' ? r.lastBackupPath : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null
  }
}

function writeBackupStatus(status: StoredBackupStatus): void {
  store.setKv(BACKUP_STATUS_KEY, status)
}

interface LocalBackupState {
  directory: string | null
  status: StoredBackupStatus
}

/**
 * A backup directory is a local-device preference. It must never be imported
 * from another machine's database, and a malformed legacy value must not turn
 * into a path relative to the process working directory.
 */
function normalizeLocalBackupDirectory(value: unknown, root = dataDirectory(), dbPath = databaseFilePath()): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null
  const path = resolve(value)
  if (isDangerousBackupPath(path, root, dbPath)) return null
  // A symlink selected as the backup directory is ambiguous: preserving the
  // link can preserve an application-managed path, while following it can
  // make a delete operation cross the data boundary.  Treat legacy symlink
  // values as invalid; the user can choose the real directory again.
  try {
    if (lstatSync(path).isSymbolicLink()) return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null
  }
  return path
}

/**
 * Resolve an existing prefix through symlinks while retaining non-existent
 * trailing components.  Backup paths are user-controlled filesystem input;
 * lexical `resolve()` alone is not enough to decide whether a path overlaps
 * the application's managed tree.
 */
function canonicalBoundaryPath(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  while (true) {
    try {
      const real = realpathSync(current)
      return resolve(real, ...tail.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return resolve(path)
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * Backup directories must be disjoint from the application data tree.  This
 * rejects the root itself, every managed descendant (including the database
 * file), and an ancestor that would make the whole application tree part of
 * the protected backup directory.  Symlink targets are checked canonically.
 */
function isDangerousBackupPath(path: string, root: string, dbPath: string | null): boolean {
  const managedRoot = resolve(root)
  if (path === managedRoot || isWithin(managedRoot, path) || isWithin(path, managedRoot)) return true
  if (dbPath !== null && path === resolve(dbPath)) return true
  const canonicalRoot = canonicalBoundaryPath(managedRoot)
  const canonicalPath = canonicalBoundaryPath(path)
  return canonicalPath === canonicalRoot || isWithin(canonicalRoot, canonicalPath) || isWithin(canonicalPath, canonicalRoot)
}

/** Return the lexical path only when it is a safe external location. */
function externalBackupPath(value: unknown, root = dataDirectory(), dbPath = databaseFilePath()): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null
  const path = resolve(value)
  const managedRoot = resolve(root)
  if (dbPath !== null && path === resolve(dbPath)) return null
  if (path === managedRoot || isWithin(path, managedRoot)) return null

  const canonicalRoot = canonicalBoundaryPath(managedRoot)
  const canonicalPath = canonicalBoundaryPath(path)
  if (isWithin(canonicalPath, canonicalRoot)) return null
  if (isWithin(canonicalRoot, canonicalPath)) {
    // A legacy configuration may be a symlink *inside* the managed tree that
    // points to an external backup directory. Preserve the link itself, but
    // never follow it. Regular descendants and symlinks that resolve back
    // into the managed tree are not protected.
    try {
      if (lstatSync(path).isSymbolicLink()) return path
    } catch { /* a missing path cannot be a managed symlink */ }
    return null
  }
  // The directory must be disjoint from the managed root. An ancestor would
  // otherwise protect the entire application tree during clear-local-data.
  return path
}

function captureLocalBackupState(): LocalBackupState {
  const settings = store.getSettings()
  return {
    directory: normalizeLocalBackupDirectory(settings.data.backupDirectory),
    status: readBackupStatus()
  }
}

/**
 * Keep only a status that can be proven to belong to the current device's
 * configured directory. This prevents an archive from another machine from
 * leaving an absolute path in `data.backup.status` after restore.
 */
function sanitizeLocalBackupStatus(directory: string | null, status: StoredBackupStatus): StoredBackupStatus {
  if (directory === null) return { lastBackupAt: null, lastBackupPath: null, lastError: null }
  if (status.lastBackupPath === null) return { ...status }
  if (!isAbsolute(status.lastBackupPath) || !isWithin(directory, status.lastBackupPath)) {
    return { lastBackupAt: null, lastBackupPath: null, lastError: null }
  }
  return { ...status, lastBackupPath: resolve(status.lastBackupPath) }
}

/** Re-apply the local-only backup settings after replacing a database file. */
function restoreLocalBackupState(state: LocalBackupState): void {
  const directory = normalizeLocalBackupDirectory(state.directory)
  store.updateSettings({ data: { backupDirectory: directory } })
  writeBackupStatus(sanitizeLocalBackupStatus(directory, state.status))
}

function toBackupStatus(): BackupStatus {
  const settings = store.getSettings()
  const s = readBackupStatus()
  const directory = normalizeLocalBackupDirectory(settings.data.backupDirectory)
  return {
    directory,
    lastBackupAt: s.lastBackupAt,
    lastBackupPath: s.lastBackupPath,
    lastError: s.lastError,
    running: backupRunning
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8')
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w')
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (err) {
    // A failed write/rename must never leave a file that looks like a usable
    // export or backup.  In particular, a later automatic-backup sweep must
    // not mistake the temporary file for the last successful backup.
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
    try { unlinkSync(tmp) } catch { /* the rename may already have won */ }
    throw err
  }
}

// ── minimal ZIP writer/reader ──────────────────────────────────────────────

interface ZipEntry { name: string; data: Buffer }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const local = Buffer.alloc(30 + name.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    data.copy(local, 30 + name.length)
    locals.push(local)

    const c = Buffer.alloc(46 + name.length)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0, 8)
    c.writeUInt16LE(0, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0, 14)
    c.writeUInt32LE(crc32(data), 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    name.copy(c, 46)
    central.push(c)
    offset += local.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // central-directory disk
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, end])
}

/**
 * Read the central directory instead of trusting local headers alone.
 *
 * A local-header-only reader accepts truncated archives, duplicate names and
 * arbitrary bytes after the last entry.  That is especially dangerous for a
 * restore operation because the first matching file silently wins.  We only
 * need the small, single-disk subset used by our backups, but we validate that
 * subset completely (including CRC and local/central header agreement).
 */
function readZip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  if (bytes.length < 22) throw new IpcError('unknown', '不是有效的 ZIP 备份文件')

  // EOCD may be preceded by a comment of at most 65535 bytes.  Require its
  // declared comment to end exactly at EOF; this rejects tail garbage.
  let eocd = -1
  const first = Math.max(0, bytes.length - (22 + 0xffff))
  for (let i = bytes.length - 22; i >= first; i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue
    const commentLength = bytes.readUInt16LE(i + 20)
    if (i + 22 + commentLength === bytes.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new IpcError('unknown', 'ZIP 归档缺少结束目录')

  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const onDisk = bytes.readUInt16LE(eocd + 8)
  const total = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  // ZIP64/multi-disk archives are outside the backup format we produce.
  if (disk !== 0 || centralDisk !== 0 || onDisk !== total || total === 0 || total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new IpcError('unknown', '不支持的 ZIP 归档结构')
  }
  if (centralOffset > eocd || centralSize > eocd - centralOffset || centralOffset + centralSize !== eocd) {
    throw new IpcError('unknown', 'ZIP 中央目录越界')
  }

  interface CentralEntry {
    name: string
    flags: number
    method: number
    crc: number
    compressedSize: number
    uncompressedSize: number
    localOffset: number
  }

  const entries: CentralEntry[] = []
  const names = new Set<string>()
  let offset = centralOffset
  for (let i = 0; i < total; i++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new IpcError('unknown', 'ZIP 中央目录条目损坏')
    }
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const crc = bytes.readUInt32LE(offset + 16)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new IpcError('unknown', '不支持 ZIP64 条目')
    }
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > eocd) throw new IpcError('unknown', 'ZIP 中央目录条目越界')
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    // Backups contain files, never directories or paths supplied by a caller.
    // Reject traversal and absolute names before they can enter the map.
    const segments = name.split('/')
    if (name === '' || name.startsWith('/') || name.includes('\\') || segments.some((part) => part === '' || part === '.' || part === '..')) {
      throw new IpcError('unknown', `ZIP 条目路径非法: ${name}`)
    }
    if (names.has(name)) throw new IpcError('unknown', `ZIP 条目重复: ${name}`)
    names.add(name)
    // We can decode UTF-8 (our writer sets the flag); accepting legacy names
    // here would make two byte sequences map to the same logical entry.
    if ((flags & 0x1) !== 0 || (flags & ~0x0808) !== 0) {
      throw new IpcError('unknown', `ZIP 条目使用了不支持的特性: ${name}`)
    }
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset })
    offset = end
  }
  if (offset !== eocd) throw new IpcError('unknown', 'ZIP 中央目录长度不匹配')

  // Validate local entries in physical order.  This also catches overlapping
  // offsets and bytes inserted between entries (except an optional data
  // descriptor, which is explicitly checked below).
  const physical = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  let previousEnd = 0
  for (let physicalIndex = 0; physicalIndex < physical.length; physicalIndex++) {
    const entry = physical[physicalIndex]!
    const lo = entry.localOffset
    if (physicalIndex === 0 && lo !== 0) throw new IpcError('unknown', 'ZIP 本地条目前存在未声明数据')
    if (lo < previousEnd || lo + 30 > centralOffset || bytes.readUInt32LE(lo) !== 0x04034b50) {
      throw new IpcError('unknown', `ZIP 本地条目偏移无效: ${entry.name}`)
    }
    const localFlags = bytes.readUInt16LE(lo + 6)
    const localMethod = bytes.readUInt16LE(lo + 8)
    const localCrc = bytes.readUInt32LE(lo + 14)
    const localCompressed = bytes.readUInt32LE(lo + 18)
    const localUncompressed = bytes.readUInt32LE(lo + 22)
    const nameLength = bytes.readUInt16LE(lo + 26)
    const extraLength = bytes.readUInt16LE(lo + 28)
    const nameEnd = lo + 30 + nameLength
    const dataStart = nameEnd + extraLength
    if (dataStart > centralOffset || dataStart < lo || bytes.subarray(lo + 30, nameEnd).toString('utf8') !== entry.name) {
      throw new IpcError('unknown', `ZIP 本地条目损坏: ${entry.name}`)
    }
    if (localMethod !== entry.method || (localFlags & 0x1) !== 0 || (localFlags & ~0x0808) !== 0 || (localFlags & 0x0808) !== (entry.flags & 0x0808)) {
      throw new IpcError('unknown', `ZIP 本地/中央目录不一致: ${entry.name}`)
    }
    if ((localFlags & 0x8) === 0 && (localCrc !== entry.crc || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize)) {
      throw new IpcError('unknown', `ZIP 本地大小或校验和不一致: ${entry.name}`)
    }
    if (entry.compressedSize > centralOffset - dataStart) throw new IpcError('unknown', `ZIP 条目越界: ${entry.name}`)
    const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize)
    let data: Buffer
    try {
      data = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw) : (() => { throw new Error('unsupported compression') })()
    } catch {
      throw new IpcError('unknown', `备份归档条目解压失败: ${entry.name}`)
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
      throw new IpcError('unknown', `备份归档条目校验失败: ${entry.name}`)
    }
    out.set(entry.name, data)

    let end = dataStart + entry.compressedSize
    const next = physical[physicalIndex + 1]?.localOffset ?? centralOffset
    if ((localFlags & 0x8) !== 0) {
      // Optional data descriptor: signature + crc + two sizes, or the
      // signature-less 12-byte form.  The next local header/central directory
      // determines where it ends, so accept only 12 or 16 bytes.
      const gap = next - end
      if (gap !== 12 && gap !== 16) throw new IpcError('unknown', `ZIP 数据描述符无效: ${entry.name}`)
      const descriptor = bytes.subarray(end, next)
      const at = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0
      if (descriptor.length - at !== 12 || descriptor.readUInt32LE(at) !== entry.crc || descriptor.readUInt32LE(at + 4) !== entry.compressedSize || descriptor.readUInt32LE(at + 8) !== entry.uncompressedSize) {
        throw new IpcError('unknown', `ZIP 数据描述符校验失败: ${entry.name}`)
      }
      end = next
    } else if (next !== end) {
      // Our format never emits padding between local entries.  Rejecting a
      // gap prevents hidden bytes from being smuggled into an archive that
      // otherwise passes the central-directory checks.
      throw new IpcError('unknown', `ZIP 本地条目之间存在未声明数据: ${entry.name}`)
    }
    previousEnd = end
  }
  if (out.size !== entries.length) throw new IpcError('unknown', 'ZIP 条目数量不一致')
  return out
}

// ── credentials and JSON export ────────────────────────────────────────────

function credentialRefs(): string[] {
  const refs = new Set<string>()
  for (const p of store.listProviders()) refs.add(p.credentialRef)
  for (const cfg of store.listMcpServers()) refs.add(mcpSecretRef(cfg.id, mcpSecretKind(cfg)))
  for (const c of store.listSearchProviders()) refs.add(searchSecretRef(c.id))
  refs.add(PROXY_PASSWORD_REF)
  return [...refs]
}

/**
 * The encrypted section travels with the configuration it belongs to.  The
 * old implementation checked it only against the *current* machine's
 * configuration, which made a perfectly valid export fail as soon as it
 * contained a provider/MCP/search service that had not been created locally
 * yet.  Build the allow-list from both sides before writing any credential.
 *
 * We intentionally use the provider's persisted `credentialRef` rather than
 * deriving `provider:${id}`: older installations and the built-in provider
 * can have stable refs that predate the current naming rule.
 */
function credentialRefsForData(data: DataExport): Set<string> {
  const refs = new Set(credentialRefs())
  for (const provider of data.providers) {
    if (typeof provider.credentialRef === 'string' && provider.credentialRef !== '') {
      refs.add(provider.credentialRef)
    }
  }
  for (const cfg of data.mcpServers) {
    if (typeof cfg?.id !== 'string' || cfg.id === '') continue
    const kind = cfg.transport === 'stdio' ? 'env' : 'headers'
    refs.add(mcpSecretRef(cfg.id, kind))
  }
  for (const cfg of data.searchProviders) {
    if (typeof cfg?.id === 'string') {
      refs.add(searchSecretRef(cfg.id as Parameters<typeof searchSecretRef>[0]))
    }
  }
  refs.add(PROXY_PASSWORD_REF)
  return refs
}

function encryptCredentials(values: Record<string, string>, password: string): EncryptedCredentials {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()])
  return {
    algorithm: 'scrypt-aes-256-gcm',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

function decryptCredentials(block: EncryptedCredentials, password: string): Record<string, string> {
  try {
    if (block.algorithm !== 'scrypt-aes-256-gcm') throw new Error('unsupported algorithm')
    const salt = Buffer.from(block.salt, 'base64')
    const nonce = Buffer.from(block.nonce, 'base64')
    const tag = Buffer.from(block.tag, 'base64')
    const ciphertext = Buffer.from(block.ciphertext, 'base64')
    if (salt.length < 16 || salt.length > 64 || nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted block')
    const key = scryptSync(password, Buffer.from(block.salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed: unknown = JSON.parse(plain)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('credentials is not an object')
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') throw new Error('credential value is not a string')
      out[k] = v
    }
    return out
  } catch {
    throw new IpcError('auth', '密码验证失败，未修改任何数据')
  }
}

async function createExport(includeEncryptedKeys: boolean, password?: string): Promise<DataExport> {
  const base = repo.exportDataSnapshot()
  const data: DataExport = { ...base }
  if (includeEncryptedKeys) {
    if (password === undefined || password.length < 8) throw new IpcError('auth', '加密导出密码至少需要 8 个字符')
    if (!getHost().secrets.available()) throw new IpcError('auth', '系统密钥环不可用，无法导出加密密钥')
    const values: Record<string, string> = {}
    for (const ref of credentialRefs()) {
      const value = await getHost().secrets.get(ref)
      if (value !== null && value !== '') values[ref] = value
    }
    data.encryptedCredentials = encryptCredentials(values, password)
  }
  return data
}

function compareCounts(data: DataExport): { newCount: number; overwriteCount: number; skippedCount: number } {
  let newCount = 0
  let overwriteCount = 0
  let skippedCount = 0
  for (const w of data.workspaces) {
    const local = store.getWorkspace(w.id)
    const decision = dataMergeDecision(local, w)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  for (const item of data.sessions) {
    const local = store.getSession(item.session.id)
    const decision = dataMergeDecision(local, item.session)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  for (const p of data.providers) {
    const local = store.listProviders().find((x) => x.id === p.id)
    const decision = dataMergeDecision(local, p)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  for (const a of data.aliases) {
    const local = store.listAliases().find((x) => x.providerId === a.providerId && x.alias === a.alias)
    const decision = dataMergeDecision(local, a)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  for (const c of data.mcpServers) {
    const local = store.listMcpServers().find((x) => x.id === c.id)
    const decision = dataMergeDecision(local, c)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  for (const c of data.searchProviders) {
    const local = repo.listStoredSearchProviders().find((x) => x.id === c.id)
    const decision = dataMergeDecision(local, c)
    if (decision === 'new') newCount++
    else if (decision === 'overwrite') overwriteCount++
    else skippedCount++
  }
  return { newCount, overwriteCount, skippedCount }
}

function parseExport(path: string): DataExport {
  if (!existsSync(path)) throw new IpcError('unknown', '导入文件不存在')
  const stat = statSync(path)
  if (stat.size > MAX_IMPORT_BYTES) throw new IpcError('unknown', '导入文件过大')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new IpcError('unknown', '导入文件不是有效 JSON') }
  if (!isDataExport(value)) throw new IpcError('unknown', '导入文件格式或版本不受支持')
  if (value.version > DATA_EXPORT_VERSION) throw new IpcError('unknown', '导入文件版本高于当前应用')
  return value
}

interface CredentialRollbackState {
  /** The encrypted bytes are the source of truth for the Electron host. */
  blob: Uint8Array | undefined
  /** Plaintext is only retained briefly to repair simple/in-memory hosts. */
  plaintext: string | null
  plaintextReadable: boolean
}

/**
 * Capture the credentials an import is allowed to touch before opening the
 * SQLite transaction. `safeStorage.set()` is deliberately not part of the
 * SQLite transaction in every host implementation (and test hosts often use
 * an in-memory map), so a database rollback alone is insufficient.
 */
async function snapshotCredentialRollback(refs: readonly string[]): Promise<Map<string, CredentialRollbackState>> {
  const secrets = getHost().secrets
  const snapshot = new Map<string, CredentialRollbackState>()
  for (const ref of refs) {
    let plaintext: string | null = null
    let plaintextReadable = true
    try {
      plaintext = await secrets.get(ref)
    } catch {
      // A corrupt/foreign safeStorage blob can be restored byte-for-byte even
      // when it cannot be decrypted. Keep that fact so rollback does not
      // accidentally delete a credential we could not inspect.
      plaintextReadable = false
    }
    snapshot.set(ref, {
      blob: repo.getCredential(ref),
      plaintext,
      plaintextReadable
    })
  }
  return snapshot
}

async function restoreCredentialRollback(snapshot: Map<string, CredentialRollbackState>): Promise<void> {
  if (snapshot.size === 0) return
  // Restore the encrypted database blobs first. This is what the production
  // Electron host reads, and it also makes the operation deterministic if a
  // custom host has no remove() hook.
  repo.tx(() => {
    for (const [ref, state] of snapshot) {
      if (state.blob === undefined) repo.removeCredential(ref)
      else repo.putCredential(ref, state.blob)
    }
  })

  const secrets = getHost().secrets
  for (const [ref, state] of snapshot) {
    try {
      if (state.plaintext !== null && state.plaintextReadable) {
        // Re-seeding the old plaintext repairs an in-memory/test host and is
        // harmless for Electron (it simply encrypts it again).
        await secrets.set(ref, state.plaintext)
      } else if (state.blob === undefined && state.plaintextReadable) {
        // The optional hook is implemented by Electron and nodeHost. Older
        // injected hosts can still rely on the database restoration above.
        await secrets.remove?.(ref)
      }
    } catch (err) {
      // Rollback is best effort at this boundary. Keep the original import
      // error as the user-facing cause, but leave an auditable diagnostic.
      console.error('[storage] 凭证回滚失败:', ref, err)
    }
  }
}

// ── public storage handlers ────────────────────────────────────────────────

export function getStats(): StorageStats {
  return repo.storageStats(dataDirectory(), attachmentDirectory(), readBackupStatus().lastBackupAt)
}

export async function openDataDirectory(): Promise<void> {
  const path = dataDirectory()
  const message = await shell.openPath(path)
  if (message) throw new IpcError('unknown', `打开数据目录失败: ${message}`)
}

export function vacuum(): StorageStats {
  vacuumDatabase()
  return getStats()
}

export async function exportData(req: { includeEncryptedKeys?: boolean; password?: string }): Promise<{ path: string; encrypted: boolean; bytes: number } | null> {
  const result = await dialog.showSaveDialog({
    title: '导出 NextCoWork 数据',
    defaultPath: join(dataDirectory(), `nextcowork-data-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return null
  const data = await createExport(req.includeEncryptedKeys === true, req.password)
  const bytes = jsonBytes(data)
  atomicWrite(result.filePath, bytes)
  return { path: result.filePath, encrypted: data.encryptedCredentials !== undefined, bytes: bytes.length }
}

export async function importPreview(): Promise<ImportPreview | null> {
  const result = await dialog.showOpenDialog({ title: '导入 NextCoWork 数据', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const path = result.filePaths[0]
  const data = parseExport(path)
  const counts = compareCounts(data)
  const id = ++importSeq
  pendingImports.set(id, data)
  pendingImportPaths.set(id, path)
  // 只有一个待确认导入；旧预览失效，避免用户确认错文件。
  for (const key of pendingImports.keys()) if (key !== id) pendingImports.delete(key)
  return {
    path,
    version: data.version,
    workspaceCount: data.workspaces.length,
    sessionCount: data.sessions.length,
    messageCount: data.sessions.reduce((n, s) => n + s.messages.length, 0),
    providerCount: data.providers.length,
    aliasCount: data.aliases.length,
    mcpServerCount: data.mcpServers.length,
    skippedCount: counts.skippedCount,
    overwriteCount: counts.overwriteCount,
    newCount: counts.newCount,
    hasEncryptedCredentials: data.encryptedCredentials !== undefined
  }
}

export async function importApply(req: { password?: string }): Promise<ImportApplyResult> {
  const id = Math.max(...pendingImports.keys(), 0)
  const data = pendingImports.get(id)
  if (data === undefined) throw new IpcError('unknown', '没有待确认的导入预览')
  let credentialValues: Record<string, string> = {}
  if (data.encryptedCredentials !== undefined) {
    if (req.password === undefined) throw new IpcError('auth', '该导出包含加密密钥，需要输入密码')
    // 先验证密码，再开始事务；无效密码不会修改任何记录。
    credentialValues = decryptCredentials(data.encryptedCredentials, req.password)
    const allowed = credentialRefsForData(data)
    for (const ref of Object.keys(credentialValues)) {
      if (!allowed.has(ref)) throw new IpcError('unknown', '导入文件包含未知凭证引用')
    }
  }
  const credentialRollback = await snapshotCredentialRollback(Object.keys(credentialValues))
  // 凭证写入使用 safeStorage，和数据库事务不是同一个同步 API。先保存数据库
  // 快照，任何一步失败都恢复整库，保证「导入失败 = 现有数据完全不变」。
  const dbPath = databaseFilePath()
  let safety: string | null = null
  if (dbPath !== null && existsSync(dbPath)) {
    checkpointDatabase()
    safety = `${dbPath}.import-safety-${Date.now()}`
    copyFileSync(dbPath, safety)
  }
  try {
    // 保持 SQLite 事务一直到 safeStorage 写入完成。electronSecrets.set
    // 最终写回 credentials 表；如果任一 Promise 失败，数据库和凭证行一起回滚。
    const result = await txAsync(async () => {
      const merged = repo.mergeDataExport(data)
      for (const [ref, value] of Object.entries(credentialValues)) {
        await getHost().secrets.set(ref, value)
      }
      return merged
    })
    pendingImports.clear()
    pendingImportPaths.clear()
    windows.emitToAll('settings:changed', store.getSettings())
    windows.emitToAll('workspace:changed', { workspaces: store.listWorkspaces() })
    windows.emitToAll('sessions:changed', {})
    return result
  } catch (err) {
    await restoreCredentialRollback(credentialRollback)
    if (safety !== null && dbPath !== null) {
      try {
        closeDatabase()
        atomicWrite(dbPath, readFileSync(safety))
        for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`) } catch { /* ignore */ } }
        openDatabase(dirname(dbPath))
      } catch (rollbackError) {
        console.error('[storage] 导入回滚失败', rollbackError)
      }
    }
    throw err
  } finally {
    if (safety !== null) { try { unlinkSync(safety) } catch { /* ignore */ } }
  }
}

export async function chooseBackupDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title: '选择备份目录', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  const path = resolve(result.filePaths[0])
  if (isDangerousBackupPath(path, dataDirectory(), databaseFilePath())) {
    throw new IpcError('unknown', '备份目录不能位于 NextCoWork 数据目录内或包含数据目录')
  }
  try {
    mkdirSync(path, { recursive: true })
    if (lstatSync(path).isSymbolicLink()) throw new Error('备份目录不能是符号链接')
    // Re-check after creation: a parent symlink can make a lexical path look
    // external while its real target is inside the managed tree.
    if (isDangerousBackupPath(path, dataDirectory(), databaseFilePath())) throw new Error('备份目录与数据目录重叠')
    const probe = join(path, `.nextcowork-write-test-${process.pid}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch (err) {
    if (err instanceof IpcError) throw err
    throw new IpcError('unknown', '备份目录不存在、不可写或与数据目录重叠')
  }
  store.updateSettings({ data: { backupDirectory: path } })
  windows.emitToAll('settings:changed', store.getSettings())
  return path
}

export function getBackupStatus(): BackupStatus {
  return toBackupStatus()
}

function ensureBackupDirectory(): string {
  const path = store.getSettings().data.backupDirectory
  if (!path) throw new IpcError('unknown', '请先选择备份目录')
  if (!isAbsolute(path)) throw new IpcError('unknown', '备份目录路径无效')
  const normalized = normalizeLocalBackupDirectory(path)
  if (normalized === null) throw new IpcError('unknown', '备份目录路径无效或与 NextCoWork 数据目录重叠')
  try {
    mkdirSync(normalized, { recursive: true })
    const lst = lstatSync(normalized)
    if (lst.isSymbolicLink()) throw new Error('备份目录不能是符号链接')
    if (isDangerousBackupPath(normalized, dataDirectory(), databaseFilePath())) throw new Error('备份目录与数据目录重叠')
    const st = statSync(normalized)
    if (!st.isDirectory()) throw new Error('不是目录')
    const probe = join(normalized, `.nextcowork-write-test-${process.pid}-${Date.now()}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch {
    throw new IpcError('unknown', '备份目录不存在或不可写')
  }
  return normalized
}

function dbSnapshot(): Buffer {
  checkpointDatabase()
  const path = databaseFilePath()
  if (path === null || !existsSync(path)) throw new IpcError('unknown', '数据库文件不可用')
  return readFileSync(path)
}

export async function createBackup(req: { manual?: boolean } = { manual: true }): Promise<BackupStatus> {
  if (backupRunning) return toBackupStatus()
  backupRunning = true
  try {
    const dir = ensureBackupDirectory()
    const database = dbSnapshot()
    const details = repo.listAllSessionDetails()
    const manifest: BackupManifest = {
      format: 'nextcowork-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: app.getVersion(),
      createdAt: Date.now(),
      schemaVersion: databaseSchemaVersion(),
      databaseSha256: sha256(database),
      sessionCount: details.length,
      messageCount: details.reduce((n, x) => n + x.messages.length, 0),
      // Backups contain a byte-for-byte database snapshot.  If the snapshot
      // has credential blobs, it does contain the encrypted credential area;
      // reporting false here would make the manifest lie about what is in the
      // archive (the blobs remain safeStorage-encrypted, but are still present).
      encryptedCredentials: repo.listCredentials().length > 0
    }
    const settings = jsonBytes(store.getSettings())
    const archive = makeZip([
      { name: 'manifest.json', data: jsonBytes(manifest) },
      { name: 'database.sqlite', data: database },
      { name: 'settings.json', data: settings }
    ])
    const baseName = req.manual === true ? `nextcowork-${new Date().toISOString().replaceAll(':', '-')}` : 'nextcowork-auto'
    let name = `${baseName}${BACKUP_EXT}`
    if (req.manual === true) {
      let n = 1
      while (existsSync(join(dir, name))) name = `${baseName}-${String(n++)}${BACKUP_EXT}`
    }
    const target = join(dir, name)
    atomicWrite(target, archive)
    if (req.manual !== true) {
      // 自动备份只管理自己的固定文件；手动备份永不被清理。
      for (const entry of readdirSync(dir)) {
        if (AUTO_BACKUP_RE.test(entry) && entry !== name) { try { unlinkSync(join(dir, entry)) } catch { /* 保留失败文件 */ } }
      }
    }
    writeBackupStatus({ lastBackupAt: manifest.createdAt, lastBackupPath: target, lastError: null })
    return toBackupStatus()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const old = readBackupStatus()
    writeBackupStatus({ ...old, lastError: message })
    throw err
  } finally {
    backupRunning = false
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizedSettings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return structuredClone(DEFAULT_SETTINGS)
  }
  return mergeSettings(DEFAULT_SETTINGS, value as Parameters<typeof mergeSettings>[1])
}

function parseBackup(path: string): { manifest: BackupManifest; database: Buffer; settings: unknown } {
  if (!isAbsolute(path) || !existsSync(path)) throw new IpcError('unknown', '备份文件不存在')
  try {
    if (statSync(path).size > MAX_BACKUP_BYTES) throw new IpcError('unknown', '备份文件过大')
  } catch (err) {
    if (err instanceof IpcError) throw err
    throw new IpcError('unknown', '无法读取备份文件')
  }
  const entries = readZip(readFileSync(path))
  const manifestRaw = entries.get('manifest.json')
  const dbRaw = entries.get('database.sqlite')
  const settingsRaw = entries.get('settings.json')
  if (!manifestRaw || !dbRaw || !settingsRaw) throw new IpcError('unknown', '备份缺少必要文件')
  let manifest: unknown
  try { manifest = JSON.parse(manifestRaw.toString('utf8')) } catch { throw new IpcError('unknown', '备份 manifest 损坏') }
  if (typeof manifest !== 'object' || manifest === null) throw new IpcError('unknown', '备份 manifest 无效')
  const m = manifest as Partial<BackupManifest>
  const latestSchema = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (
    m.format !== 'nextcowork-backup' ||
    m.formatVersion !== BACKUP_FORMAT_VERSION ||
    typeof m.appVersion !== 'string' ||
    m.appVersion.length === 0 ||
    m.appVersion.length > 256 ||
    typeof m.createdAt !== 'number' ||
    !Number.isFinite(m.createdAt) ||
    m.createdAt < 0 ||
    typeof m.databaseSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(m.databaseSha256) ||
    typeof m.schemaVersion !== 'number' ||
    !Number.isInteger(m.schemaVersion) ||
    m.schemaVersion < 1 ||
    m.schemaVersion > latestSchema ||
    typeof m.sessionCount !== 'number' ||
    !Number.isInteger(m.sessionCount) ||
    m.sessionCount < 0 ||
    typeof m.messageCount !== 'number' ||
    !Number.isInteger(m.messageCount) ||
    m.messageCount < 0 ||
    typeof m.encryptedCredentials !== 'boolean'
  ) throw new IpcError('unknown', '备份格式或数据库版本不受支持')
  if (sha256(dbRaw) !== m.databaseSha256) throw new IpcError('unknown', '备份数据库校验和不匹配')
  // SQLite header stores user_version as a big-endian uint32 at bytes 60..63.
  if (dbRaw.length < 64 || dbRaw.toString('ascii', 0, 15) !== 'SQLite format 3') throw new IpcError('unknown', '备份数据库文件无效')
  const schemaVersion = dbRaw.readUInt32BE(60)
  if (schemaVersion !== m.schemaVersion) throw new IpcError('unknown', '备份数据库版本与 manifest 不一致')
  let settings: unknown
  try { settings = JSON.parse(settingsRaw.toString('utf8')) } catch { throw new IpcError('unknown', '备份设置损坏') }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new IpcError('unknown', '备份设置结构无效')
  }
  try {
    // This also accepts older settings files that predate `data`; the shared
    // merger supplies the current defaults while rejecting non-object input.
    mergeSettings(DEFAULT_SETTINGS, settings as Parameters<typeof mergeSettings>[1])
  } catch {
    throw new IpcError('unknown', '备份设置结构无效')
  }
  validateBackupDatabase(dbRaw, m, settings)
  return { manifest: m as BackupManifest, database: dbRaw, settings }
}

/**
 * Cross-check manifest claims against the SQLite payload itself.  A checksum
 * proves that the database was not changed after the manifest was written,
 * but it does not prove that the manifest's human-readable counts are true.
 * Deserialize into an isolated in-memory handle so no application state is
 * touched while previewing an untrusted archive.
 */
function validateBackupDatabase(raw: Buffer, manifest: Partial<BackupManifest>, expectedSettings: unknown): void {
  let temp: DatabaseSync | null = null
  try {
    temp = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    // `deserialize` is present in the Node runtime shipped with Electron,
    // but older @types/node releases do not declare it yet.
    const deserialize = (temp as DatabaseSync & { deserialize(data: Uint8Array): void }).deserialize
    if (typeof deserialize !== 'function') throw new Error('当前运行时不支持 SQLite 归档校验')
    deserialize.call(temp, raw)
    const sessions = Number((temp.prepare('SELECT COUNT(*) AS n FROM sessions').get() as Record<string, unknown>)['n'] ?? -1)
    const messages = Number((temp.prepare('SELECT COUNT(*) AS n FROM messages').get() as Record<string, unknown>)['n'] ?? -1)
    const credentials = Number((temp.prepare('SELECT COUNT(*) AS n FROM credentials').get() as Record<string, unknown>)['n'] ?? -1)
    if (sessions !== manifest.sessionCount || messages !== manifest.messageCount) {
      throw new Error('manifest count mismatch')
    }
    if ((credentials > 0) !== manifest.encryptedCredentials) {
      throw new Error('manifest credential flag mismatch')
    }
    const settingsRow = temp.prepare('SELECT json FROM settings WHERE id = 1').get() as Record<string, unknown> | undefined
    let databaseSettings: unknown = DEFAULT_SETTINGS
    if (settingsRow !== undefined) {
      try {
        databaseSettings = JSON.parse(String(settingsRow['json']))
      } catch {
        throw new Error('settings row is not valid JSON')
      }
    }
    if (stableJson(normalizedSettings(databaseSettings)) !== stableJson(normalizedSettings(expectedSettings))) {
      throw new Error('settings.json 与 database.sqlite 不一致')
    }
  } catch (err) {
    if (err instanceof IpcError) throw err
    throw new IpcError('unknown', `备份数据库内容校验失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try { temp?.close() } catch { /* best effort */ }
  }
}

export async function restoreBackup(req: { confirm?: boolean }): Promise<RestoreResult | null> {
  if (req.confirm !== true || pendingRestore === null) {
    const result = await dialog.showOpenDialog({ title: '从备份恢复', properties: ['openFile'], filters: [{ name: 'NextCoWork 备份', extensions: ['ncwbackup'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const parsed = parseBackup(path)
    const preview: RestorePreview = {
      path,
      manifest: parsed.manifest,
      sessionCount: parsed.manifest.sessionCount,
      messageCount: parsed.manifest.messageCount,
      settingsIncluded: true
    }
    pendingRestore = { path, preview }
    return { restored: false, preview }
  }
  if (runs.activeRunIds().length > 0) throw new IpcError('unknown', '有运行中的 Agent，请先停止任务后再恢复')
  const target = pendingRestore
  const parsed = parseBackup(target.path)
  const dbPath = databaseFilePath()
  if (dbPath === null) throw new IpcError('unknown', '当前数据库不是文件库')
  const safety = `${dbPath}.restore-safety-${Date.now()}`
  const localBackupState = captureLocalBackupState()
  checkpointDatabase()
  copyFileSync(dbPath, safety)
  try {
    closeDatabase()
    atomicWrite(dbPath, parsed.database)
    // 清掉旧 WAL/SHM，防止旧日志覆盖恢复后的文件。
    for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`) } catch { /* 不存在 */ } }
    openDatabase(dirname(dbPath))
    // The archive may have been produced on another device. Restore the
    // current device's backup directory and sanitize its status immediately
    // after reopening the replacement database.
    restoreLocalBackupState(localBackupState)
    pendingRestore = null
    windows.emitToAll('settings:changed', store.getSettings())
    windows.emitToAll('workspace:changed', { workspaces: store.listWorkspaces() })
    windows.emitToAll('sessions:changed', {})
    return { restored: true, backupStatus: toBackupStatus() }
  } catch (err) {
    try {
      closeDatabase()
      for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`) } catch { /* 不存在 */ } }
      atomicWrite(dbPath, readFileSync(safety))
      for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`) } catch { /* 不存在 */ } }
      openDatabase(dirname(dbPath))
      restoreLocalBackupState(localBackupState)
    } catch (rollbackError) {
      console.error('[storage] 恢复回滚失败', rollbackError)
    }
    throw err
  } finally {
    try { unlinkSync(safety) } catch { /* 安全快照只用于失败回滚 */ }
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 普通会话附件的唯一受管理子树。themes/exports 等 scope 不属于清理范围。 */
function sessionAttachmentDirectory(): string {
  return join(attachmentDirectory(), 'sessions')
}

function isManagedSessionAttachment(path: string): boolean {
  return isWithin(sessionAttachmentDirectory(), path) && resolve(path) !== resolve(sessionAttachmentDirectory())
}

/** 删除受管理目录时保留用户选定的备份目录（无论它嵌套在哪一侧）。 */
function removeManagedPath(path: string, protectedPath: string | null): void {
  let stat
  try { stat = lstatSync(path) } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw new IpcError('unknown', `读取 ${path} 失败: ${String(err)}`)
  }

  // A symlink is a leaf. Never pass it to a recursive remover and never use
  // statSync here: both can follow a link into an external directory.
  if (stat.isSymbolicLink()) {
    if (protectedPath !== null && isWithin(protectedPath, path)) return
    try { unlinkSync(path) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new IpcError('unknown', `删除 ${path} 失败: ${String(err)}`)
    }
    return
  }

  if (protectedPath !== null && isWithin(protectedPath, path)) {
    // 备份目录位于待删目录之上/就是待删目录：整棵都不能动。
    return
  }
  if (protectedPath !== null && isWithin(path, protectedPath)) {
    // 备份目录是待删目录的子树：只清理其余兄弟，保留这条子树。
    try {
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        removeManagedPath(join(path, entry.name), protectedPath)
      }
    } catch (err) {
      throw new IpcError('unknown', `删除 ${path} 失败: ${String(err)}`)
    }
    return
  }
  try {
    if (stat.isDirectory()) rmSync(path, { recursive: true, force: true })
    else unlinkSync(path)
  } catch (err) { throw new IpcError('unknown', `删除 ${path} 失败: ${String(err)}`) }
}

function walkFiles(root: string): string[] {
  let rootStat
  try { rootStat = lstatSync(root) } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    return []
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    // Dirent.isDirectory() is intentionally not enough for a hostile tree:
    // inspect the link itself and treat symlinks as leaves.
    let stat
    try { stat = lstatSync(path) } catch { continue }
    if (stat.isSymbolicLink()) out.push(path)
    else if (stat.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

/**
 * 一次扫描，得出三类可回收对象。preview 与实际清理**共用它** ——
 * 两边各写一遍判据的话，预览说要删 3 个、实际删了 5 个，而没有任何测试会红。
 *
 * ## 判据的演变
 *
 * 原判据是「磁盘上有、表里没有 → 删」。它在附件根下只有会话附件时是对的。
 * 加了 draft/committed 之后要补两类：
 *
 * - **`.tmp` 残片**：上传写到一半崩掉留下的。它们永远不该存在，无条件回收。
 * - **超期草稿**：用户传了图但一直没发送。它们**在表里**，所以旧判据永远
 *   碰不到它们 —— 那不是「被误删」，而是反过来：**永远不会被回收**，
 *   一张没发出去的图会在磁盘上留到卸载。
 *
 * ## 未超期的草稿绝不动
 *
 * 这是这个函数里最重要的一条。用户挑好图去倒杯水，回来时图必须还在。
 * 宽限期给到 7 天，宁可多占几 MB。
 */
interface ReclaimScan {
  /** 要删的文件（孤儿 + 残片 + 超期草稿） */
  files: string[]
  /** 要删的行（文件已不存在的 + 超期草稿的） */
  rowIds: string[]
  /** row 与文件的对应关系，用来避免把同一附件在统计中算两次。 */
  rowPaths: Map<string, string>
  bytes: number
}

function reclaimAttachmentCount(scan: ReclaimScan): number {
  const rowPaths = new Set([...scan.rowPaths.values()].map((path) => resolve(path)))
  const standaloneFiles = scan.files.filter((path) => !rowPaths.has(resolve(path))).length
  return scan.rowIds.length + standaloneFiles
}

function scanReclaimable(now: number): ReclaimScan {
  // V5 后附件根下还有 themes/exports 等其它 scope。只遍历 sessions 子树，
  // 避免把主题图或导出资产误判成「表里没有的孤儿」。
  const root = sessionAttachmentDirectory()
  const referenced = new Set(
    repo.attachmentRows()
      .filter((row) => row.scope === 'session' && isManagedSessionAttachment(row.path))
      .map((row) => resolve(row.path))
  )

  const files: string[] = []
  let bytes = 0
  const add = (p: string): void => {
    files.push(p)
    try { bytes += lstatSync(p).size } catch { /* 统计不精确不影响回收 */ }
  }

  /*
    ★ **只扫 sessions/ 子树,不扫整个附件根。**

    附件根下不止会话附件:`themes/` 放主题图,它们由 `theme.ts` 的 index.json
    管理、**不在 attachments 表里**。而这个函数的孤儿判据是「表里没有就删」——
    对整个根跑一遍的话,用户传的每一张主题图都会在下一次清理时消失。

    所以判据按子树分治:sessions/ 归这里,themes/ 归 `sweepOrphans`,
    各自认自己的权威来源。判据的适用范围本身就是判据的一部分。
  */
  for (const path of walkFiles(root)) {
    // 上传中断留下的残片。以 `.` 开头 + `.tmp` 结尾，`ncw://` 也寻址不到它们
    if (basename(path).startsWith('.') && path.endsWith('.tmp')) { add(path); continue }
    // 真孤儿：磁盘上有、表里没有
    if (!referenced.has(resolve(path))) add(path)
  }

  const rowIds: string[] = []
  const rowPaths = new Map<string, string>()

  // 超期草稿：文件与行一起收
  for (const row of repo.listStaleDraftAttachments(now - DRAFT_ATTACHMENT_TTL_MS)) {
    if (row.scope !== 'session' || !isManagedSessionAttachment(row.path)) continue
    if (!files.includes(row.path)) {
      try { lstatSync(row.path); add(row.path) } catch { /* 文件已不存在 */ }
    }
    rowIds.push(row.id)
    rowPaths.set(row.id, row.path)
  }

  // 表里有、磁盘无 —— 只收行
  for (const row of repo.attachmentRows()) {
    // attachmentRows() 是兼容旧调用点的精简视图；路径边界仍由这里负责。
    if (!isManagedSessionAttachment(row.path)) continue
    let present = true
    try { lstatSync(row.path) } catch { present = false }
    if (!present && !rowIds.includes(row.id)) {
      rowIds.push(row.id)
      rowPaths.set(row.id, row.path)
      bytes += row.size
    }
  }

  return { files, rowIds, rowPaths, bytes }
}

interface PhysicalCleanup {
  deleted: number
  undeletable: string[]
}

/**
 * 数据库删除后回收已经没有任何引用的会话附件。
 *
 * 只接受 `attachments/sessions` 下的路径，并在删除前再次查询引用集合；
 * 因此外部绝对路径、主题/导出附件以及仍被其它会话引用的文件都会保留。
 */
function removeUnreferencedManagedFiles(paths: readonly string[]): PhysicalCleanup {
  const referenced = new Set(
    repo.attachmentRows()
      .filter((row) => row.scope === 'session' && isManagedSessionAttachment(row.path))
      .map((row) => resolve(row.path))
  )
  const undeletable: string[] = []
  let deleted = 0
  const seen = new Set<string>()
  for (const raw of paths) {
    if (!isManagedSessionAttachment(raw)) continue
    const path = resolve(raw)
    let stat
    try { stat = lstatSync(path) } catch { continue }
    if (seen.has(path) || referenced.has(path)) continue
    seen.add(path)
    try {
      // Unlink a regular file or the symlink itself; never recurse into an
      // unexpected directory and never follow a link to its target.
      if (!stat.isFile() && !stat.isSymbolicLink()) { undeletable.push(path); continue }
      unlinkSync(path)
      deleted++
    } catch {
      undeletable.push(path)
    }
  }
  return { deleted, undeletable: [...new Set(undeletable)] }
}

/**
 * Reclaim the physical files that belonged to a deleted session.  SQLite's
 * cascade removes the attachment rows, but it cannot remove files outside
 * the database.  Keep this helper in the storage boundary so session IPC and
 * the bulk cleanup paths share the same path and reference checks.
 */
export function removeSessionAttachmentFiles(paths: readonly string[]): PhysicalCleanup {
  return removeUnreferencedManagedFiles(paths)
}

function attachmentCleanupPreview(): CleanupPreview {
  const scan = scanReclaimable(Date.now())
  return {
    kind: 'attachments',
    sessionCount: 0,
    messageCount: 0,
    attachmentCount: reclaimAttachmentCount(scan),
    bytes: scan.bytes,
    undeletable: likelyUndeletable(scan.files)
  }
}

function likelyUndeletable(paths: readonly string[]): string[] {
  const result: string[] = []
  for (const raw of paths) {
    if (!isManagedSessionAttachment(raw)) continue
    try { lstatSync(raw) } catch { continue }
    try {
      // 删除权限由父目录决定；这里只做预览，不把文件内容或路径交给 renderer。
      accessSync(dirname(raw), constants.W_OK)
    } catch {
      result.push(raw)
    }
  }
  return [...new Set(result)]
}

export function cleanupPreview(req: { kind: 'attachments' | 'age' | 'history' | 'local-data'; age?: CleanupAge }): CleanupPreview {
  if (req.kind === 'attachments') return attachmentCleanupPreview()
  if (req.kind === 'age') {
    const ids = repo.sessionIdsBefore(cutoffForAge(Date.now(), req.age ?? 3))
    const preview = repo.cleanupPreview('age', cutoffForAge(Date.now(), req.age ?? 3))
    preview.undeletable = likelyUndeletable(repo.attachmentRowsForSessions(ids).map((row) => row.path))
    return preview
  }
  const preview = repo.cleanupPreview(req.kind)
  if (req.kind === 'history') {
    preview.undeletable = likelyUndeletable(repo.allSessionAttachmentRows().map((row) => row.path))
  }
  return preview
}

export function cleanupAttachments(): CleanupResult {
  if (runs.activeRunIds().length > 0) throw new IpcError('unknown', '有运行中的 Agent，请先停止任务后再清理')

  // ★ 预览与执行走同一次扫描，不是两次 —— 两次之间文件可能变化，
  //   而用户看到的数字必须就是实际发生的事。
  const scan = scanReclaimable(Date.now())
  const undeletable: string[] = []
  const failedPaths = new Set<string>()
  const rowPaths = new Set([...scan.rowPaths.values()].map((path) => resolve(path)))
  let deleted = 0

  for (const path of scan.files) {
    try {
      unlinkSync(path)
      // 文件同时有待删数据库行时，它们合起来仍是一条附件。
      if (!rowPaths.has(resolve(path))) deleted++
    } catch {
      failedPaths.add(resolve(path))
      undeletable.push(path)
    }
  }
  for (const id of scan.rowIds) {
    const path = scan.rowPaths.get(id)
    // 文件删不掉时保留行，下一次清理仍有完整信息可重试。
    if (path !== undefined && failedPaths.has(resolve(path))) continue
    repo.removeAttachmentRow(id)
    deleted++
  }

  return {
    kind: 'attachments',
    sessionCount: 0,
    messageCount: 0,
    attachmentCount: reclaimAttachmentCount(scan),
    bytes: scan.bytes,
    undeletable: [...new Set(undeletable)],
    deleted
  }
}

export function cleanupByAge(req: { age: CleanupAge }): CleanupResult {
  if (runs.activeRunIds().length > 0) throw new IpcError('unknown', '有运行中的 Agent，请先停止任务后再清理')
  const cutoff = cutoffForAge(Date.now(), req.age)
  const ids = repo.sessionIdsBefore(cutoff)
  const paths = repo.attachmentRowsForSessions(ids).map((row) => row.path)
  const result = repo.deleteByAge(cutoff)
  const physical = removeUnreferencedManagedFiles(paths)
  result.undeletable = physical.undeletable
  if (result.sessionCount > 0) windows.emitToAll('sessions:changed', {})
  return result
}

export function clearHistory(): CleanupResult {
  if (runs.activeRunIds().length > 0) throw new IpcError('unknown', '有运行中的 Agent，请先停止任务后再清理')
  const paths = repo.allSessionAttachmentRows().map((row) => row.path)
  const result = repo.deleteAllHistory()
  const physical = removeUnreferencedManagedFiles(paths)
  result.undeletable = physical.undeletable
  windows.emitToAll('sessions:changed', {})
  return result
}

/** 删除本应用管理的目录/文件；不会递归删除数据根目录本身。 */
export function clearLocalData(req: { confirm: boolean }): { deleted: boolean } {
  if (!req.confirm) throw new IpcError('unknown', '必须明确确认删除本机数据')
  if (runs.activeRunIds().length > 0) throw new IpcError('unknown', '有运行中的 Agent，请先停止任务后再删除')
  const root = dataDirectory()
  const configuredBackup = store.getSettings().data.backupDirectory
  // A malformed legacy setting must not accidentally protect a path relative
  // to the process working directory.  Only a user-selected absolute path is
  // an external backup location worth preserving.
  const externalBackup = externalBackupPath(configuredBackup)
  const managedNames = [ATTACHMENTS_DIR, 'themes', 'skills', 'agents', 'plugins', 'plugin', 'logs', 'cache', 'workspaces']
  for (const name of managedNames) {
    const path = join(root, name)
    removeManagedPath(path, externalBackup)
  }
  const dbPath = databaseFilePath()
  if (dbPath !== null) {
    closeDatabase()
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { unlinkSync(path) } catch { /* 已不存在 */ }
    }
  }
  // 保留 Claude CLI 共享目录和外部备份目录；应用退出后下次启动会重建数据库。
  app.quit()
  return { deleted: true }
}

/** 启动时按到期补做一次自动备份，不使用 React timer。 */
export function scheduleAutomaticBackup(): void {
  const settings = store.getSettings()
  if (settings.data.backupFrequency === 'manual' || !settings.data.backupDirectory) return
  const last = readBackupStatus().lastBackupAt ?? 0
  const interval = settings.data.backupFrequency === 'daily' ? 86_400_000 : 7 * 86_400_000
  if (Date.now() - last < interval) return
  setImmediate(() => { void createBackup({ manual: false }).catch((err) => console.warn('[storage] 自动备份失败', err)) })
}
