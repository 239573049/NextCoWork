import { shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  WORKSPACE_FILE_ERROR_PREFIX,
  WORKSPACE_IMAGE_LIMIT,
  WORKSPACE_TEXT_LIMIT,
  type WorkspaceFile,
  type WorkspaceFileErrorCode,
  type WorkspaceFileMutationRequest,
  type WorkspaceFileMutationResult,
  type WorkspaceFileRequest,
  type WorkspaceFileWriteRequest,
  type WorkspaceTextFile
} from '../../shared/domain/workspace-file'
import { PathEscapeError, resolveAnywhere } from '../kernel/tool/path-guard'
import { store } from '../state/store'
import { IpcError } from './errors'

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.pyc',
  '.sqlite', '.sqlite3', '.db', '.mp3', '.wav', '.ogg', '.flac',
  '.mp4', '.mov', '.webm', '.avi', '.woff', '.woff2', '.ttf', '.otf',
  '.heic', '.tif', '.tiff', '.psd', '.dmg', '.iso'
])
const MAX_COPY_ENTRIES = 10_000
const MAX_COPY_BYTES = 256 * 1024 * 1024

function fail(code: WorkspaceFileErrorCode): never {
  throw new IpcError('tool_failed', `${WORKSPACE_FILE_ERROR_PREFIX}${code}`)
}

function translateError(error: unknown): never {
  if (error instanceof IpcError) throw error
  if (error instanceof PathEscapeError) fail('invalid-path')
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') fail('not-found')
  if (code === 'EEXIST' || code === 'ENOTEMPTY') fail('exists')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') fail('permission')
  if (code === 'ELOOP') fail('symlink')
  if (code === 'EISDIR') fail('not-file')
  fail('io')
}

function workspaceRoot(workspaceId: string): string {
  if (typeof workspaceId !== 'string') fail('workspace-unavailable')
  const workspace = store.getWorkspace(workspaceId)
  if (!workspace) fail('workspace-unavailable')
  try {
    const root = realpathSync.native(workspace.rootPath)
    if (!lstatSync(root).isDirectory()) fail('workspace-unavailable')
    return root
  } catch {
    fail('workspace-unavailable')
  }
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 解析一条来自渲染层的文档路径。**读/写/新建/复制/移动/删除共用这一处。**
 *
 * 两种形态:
 *
 * 1. **工作区相对路径**(常态,文件树给出的就是这种)。逐段 lstat,任何一段是软链都拒 ——
 *    否则一次「重命名 link」可能悄悄改的是它的目标,也可能在读取和保存之间被换成外部链接。
 * 2. **绝对路径**。工具卡片和 Markdown 链接现在会给出工作区外的绝对路径,点开要能落到这儿。
 *    ★ 这种形态**只检查最后一段**不是软链,不逐段审计祖先:macOS 上 `/tmp` 本身就是
 *    指向 `/private/tmp` 的软链,逐段审计会把 `/tmp/x` 这类完全正常的路径判成 `symlink`。
 *    「编辑不会写穿一条链」这个性质对目标文件本身仍然成立。
 */
function checkedPath(root: string, path: string, allowRoot = false): string {
  if (typeof path !== 'string' || path.includes('\0')) fail('invalid-path')
  if (path === '' && allowRoot) return root

  if (isAbsolute(path)) {
    // ★ lstat 的是**词法形式**,不是 resolveAnywhere 返回的 realpath ——
    //   后者已经把软链解开了,拿它去问"是不是软链"永远得到否。
    const lexical = resolve(path)
    if (statIfPresent(lexical)?.isSymbolicLink() === true) fail('symlink')
    const target = resolveAnywhere(root, path).abs
    if (target === root) fail('invalid-path')
    return target
  }

  if (path.includes('\\') || /^[a-z]:/i.test(path)) fail('invalid-path')
  const segments = path.split('/')
  if (segments.some((part) => part === '' || part === '.' || part === '..')) fail('invalid-path')
  const target = resolveAnywhere(root, path).abs
  if (target === root) fail('invalid-path')
  for (let index = 1; index <= segments.length; index++) {
    const component = resolve(root, ...segments.slice(0, index))
    const stat = statIfPresent(component)
    if (stat?.isSymbolicLink()) fail('symlink')
    if (!stat) break
  }
  return target
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** O_NOFOLLOW 配合有上限的 read，拒绝设备/FIFO，也不会因读取中增长而无限分配。 */
function readBounded(path: string, limit: number): { bytes?: Buffer; stat: Stats } {
  const before = lstatSync(path)
  if (!before.isFile()) fail('not-file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail('not-file')
    if (stat.size > limit) return { stat }
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let used = 0
    while (used < buffer.length) {
      const length = readSync(fd, buffer, used, buffer.length - used, used)
      if (length === 0) break
      used += length
    }
    const after = fstatSync(fd)
    if (used > limit || after.size > limit) return { stat: after }
    // 文件读取期间被外部写入时，让用户重试，不返回混合版本的内容。
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || used !== stat.size) fail('conflict')
    return { bytes: buffer.subarray(0, used), stat: after }
  } finally {
    closeSync(fd)
  }
}

function decodeText(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function binaryText(content: string): boolean {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    if (code <= 8 || code === 11 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

function readFileAt(root: string, path: string): WorkspaceFile {
  const target = checkedPath(root, path)
  const extension = extname(path).toLowerCase()
  const mime = IMAGE_MIME[extension]
  const { bytes, stat } = readBounded(target, mime ? WORKSPACE_IMAGE_LIMIT : WORKSPACE_TEXT_LIMIT)
  const base = {
    path,
    size: stat.size,
    revision: bytes ? revision(bytes) : `large:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }
  if (!bytes) return { ...base, kind: 'binary', reason: 'too-large' }
  if (mime) return { ...base, kind: 'image', mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  if (BINARY_EXTENSIONS.has(extension)) return { ...base, kind: 'binary', reason: 'unsupported' }
  const content = decodeText(bytes)
  if (content === undefined || bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
    bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { ...base, kind: 'binary', reason: 'encoding' }
  }
  if (binaryText(content)) return { ...base, kind: 'binary', reason: 'unsupported' }
  return { ...base, kind: 'text', content }
}

export function readWorkspaceFile(req: WorkspaceFileRequest): WorkspaceFile {
  try {
    return readFileAt(workspaceRoot(req.workspaceId), req.path)
  } catch (error) {
    translateError(error)
  }
}

export function writeWorkspaceFile(req: WorkspaceFileWriteRequest): WorkspaceTextFile {
  try {
    const root = workspaceRoot(req.workspaceId)
    const target = checkedPath(root, req.path)
    if (typeof req.content !== 'string' || typeof req.revision !== 'string') fail('invalid-encoding')
    if (req.content.length > WORKSPACE_TEXT_LIMIT) fail('too-large')
    const bytes = Buffer.from(req.content, 'utf8')
    if (bytes.length > WORKSPACE_TEXT_LIMIT) fail('too-large')
    if (decodeText(bytes) !== req.content || binaryText(req.content)) fail('invalid-encoding')
    const current = readFileAt(root, req.path)
    if (current.kind !== 'text') fail('unsupported')
    if (current.revision !== req.revision) fail('conflict')
    if (current.content === req.content) return current

    // 同目录临时文件 + 原子替换，保存中断不会留下被截断的用户文件。
    const temporary = resolve(dirname(target), `.ncw-save-${randomUUID()}.tmp`)
    let created = false
    try {
      const fd = openSync(temporary, 'wx', lstatSync(target).mode & 0o777)
      created = true
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      checkedPath(root, req.path)
      if (readFileAt(root, req.path).revision !== req.revision) fail('conflict')
      renameSync(temporary, target)
      created = false
    } finally {
      if (created) rmSync(temporary, { force: true })
    }
    return { kind: 'text', path: req.path, size: bytes.length, revision: revision(bytes), content: req.content }
  } catch (error) {
    translateError(error)
  }
}

function requireAbsent(path: string): void {
  if (statIfPresent(path)) fail('exists')
}

function requireParent(path: string): void {
  if (!lstatSync(dirname(path)).isDirectory()) fail('invalid-path')
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** 预先验证整个复制树；复制遇到软链/设备时不会给它们创建新的访问入口。 */
function inspectCopy(root: string, path: string): void {
  let count = 0
  let bytes = 0
  function inspect(relativePath: string): void {
    const absolute = checkedPath(root, relativePath)
    const stat = lstatSync(absolute)
    count++
    if (count > MAX_COPY_ENTRIES) fail('too-large')
    if (stat.isFile()) {
      bytes += stat.size
      if (bytes > MAX_COPY_BYTES) fail('too-large')
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(absolute)) inspect(`${relativePath}/${name}`)
    } else {
      fail('unsupported')
    }
  }
  inspect(path)
}

function copyTree(root: string, source: string, destination: string, onCreated?: () => void): void {
  const sourcePath = checkedPath(root, source)
  const destinationPath = checkedPath(root, destination)
  requireAbsent(destinationPath)
  const stat = lstatSync(sourcePath)
  if (stat.isFile()) {
    copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    onCreated?.()
  } else if (stat.isDirectory()) {
    mkdirSync(destinationPath, { mode: stat.mode & 0o777 })
    onCreated?.()
    for (const name of readdirSync(sourcePath)) copyTree(root, `${source}/${name}`, `${destination}/${name}`)
  } else {
    fail('unsupported')
  }
}

export async function mutateWorkspaceFile(req: WorkspaceFileMutationRequest): Promise<WorkspaceFileMutationResult> {
  try {
    const root = workspaceRoot(req.workspaceId)
    const target = checkedPath(root, req.path)
    switch (req.operation) {
      case 'create-file':
        requireParent(target)
        writeFileSync(target, '', { flag: 'wx' })
        break
      case 'create-directory':
        requireParent(target)
        mkdirSync(target)
        break
      case 'delete':
        lstatSync(target)
        // 使用系统废纸篓；失败时不降级为永久删除。
        await shell.trashItem(target)
        break
      case 'rename':
      case 'move':
      case 'copy': {
        if (typeof req.destination !== 'string') fail('invalid-path')
        const destination = checkedPath(root, req.destination)
        const stat = lstatSync(target)
        if (!stat.isFile() && !stat.isDirectory()) fail('unsupported')
        if (stat.isDirectory() && inside(target, destination)) fail('invalid-path')
        requireAbsent(destination)
        requireParent(destination)
        if (req.operation === 'copy') {
          inspectCopy(root, req.path)
          // 暂存后发布：失败只清理本次创建的暂存目录，绝不删除目标路径。
          const parent = req.destination.includes('/') ? req.destination.slice(0, req.destination.lastIndexOf('/') + 1) : ''
          const temporaryRelative = `${parent}.ncw-copy-${randomUUID()}.tmp`
          const temporary = checkedPath(root, temporaryRelative)
          let created = false
          try {
            copyTree(root, req.path, temporaryRelative, () => { created = true })
            requireAbsent(checkedPath(root, req.destination))
            renameSync(temporary, destination)
            created = false
          } finally {
            if (created) rmSync(temporary, { recursive: true, force: true })
          }
        } else {
          renameSync(target, destination)
        }
        return { path: req.path, destination: req.destination }
      }
      default:
        fail('unsupported')
    }
    return { path: req.path }
  } catch (error) {
    translateError(error)
  }
}

export function revealWorkspaceFile(req: WorkspaceFileRequest): void {
  try {
    const target = checkedPath(workspaceRoot(req.workspaceId), req.path, true)
    lstatSync(target)
    shell.showItemInFolder(target)
  } catch (error) {
    translateError(error)
  }
}
