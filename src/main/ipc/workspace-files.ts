import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
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
  WORKSPACE_TEXT_LIMIT,
  type WorkspaceFile,
  type WorkspaceFileErrorCode,
  type WorkspaceFileMutationRequest,
  type WorkspaceFileMutationResult,
  type WorkspaceFileRequest,
  type WorkspaceFileWriteRequest,
  type WorkspaceRecoveryListing,
  type WorkspaceTextFile
} from '../../shared/domain/workspace-file'
import { PathEscapeError, resolveAnywhere } from '../kernel/tool/path-guard'
import { store } from '../state/store'
import { IpcError } from './errors'
import { isLocalEnvironment } from '../../shared/domain/environment'
import { getWorkspaceEnvironment } from '../runtime'
import { EnvironmentError } from '../environment/errors'
import { EnvironmentFileError, EnvironmentFiles, remoteFileFailure } from '../environment/files'
import { classifyWorkspaceFile, contentRevision as revision, decodeWorkspaceText as decodeText, isBinaryText as binaryText, workspaceReadLimit } from '../kernel/workspace-file-content'

const MAX_COPY_ENTRIES = 10_000
const MAX_COPY_BYTES = 256 * 1024 * 1024

function fail(code: WorkspaceFileErrorCode): never {
  throw new IpcError('tool_failed', `${WORKSPACE_FILE_ERROR_PREFIX}${code}`)
}

function translateError(error: unknown): never {
  if (error instanceof EnvironmentError) throw error
  if (error instanceof EnvironmentFileError) fail(error.fileCode)
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
  if (!isLocalEnvironment(workspace.environment)) throw new EnvironmentError('disconnected')
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

function readFileAt(root: string, path: string): WorkspaceFile {
  const target = checkedPath(root, path)
  const extension = extname(path).toLowerCase()
  const { bytes, stat } = readBounded(target, workspaceReadLimit(extension))
  return classifyWorkspaceFile(path, extension, bytes, stat)
}

function remoteEditor(workspaceId: string): EnvironmentFiles | undefined {
  const workspace = store.getWorkspace(workspaceId)
  if (!workspace || isLocalEnvironment(workspace.environment)) return undefined
  return new EnvironmentFiles(getWorkspaceEnvironment(workspaceId))
}

export async function readWorkspaceDocument(req: WorkspaceFileRequest): Promise<WorkspaceFile> {
  try { return await (remoteEditor(req.workspaceId)?.read(req.path) ?? readWorkspaceFile(req)) } catch (error) {
    try { remoteFileFailure(error) } catch (failure) { translateError(failure) }
  }
}
export async function writeWorkspaceDocument(req: WorkspaceFileWriteRequest): Promise<WorkspaceTextFile> {
  try { return await (remoteEditor(req.workspaceId)?.write(req) ?? writeWorkspaceFile(req)) } catch (error) {
    try { remoteFileFailure(error) } catch (failure) { translateError(failure) }
  }
}
export async function mutateWorkspaceDocument(req: WorkspaceFileMutationRequest): Promise<WorkspaceFileMutationResult> {
  try { return await (remoteEditor(req.workspaceId)?.mutate(req) ?? mutateWorkspaceFile(req)) } catch (error) {
    try { remoteFileFailure(error) } catch (failure) { translateError(failure) }
  }
}
export async function listWorkspaceRecovery(req: { workspaceId: string }): Promise<WorkspaceRecoveryListing> {
  const editor = remoteEditor(req.workspaceId)
  // 本机工作区走系统回收站,没有我们自己的索引可列
  if (!editor) return { entries: [], environmentKey: '' }
  try { return await editor.listRecovery() } catch (error) {
    try { remoteFileFailure(error) } catch (failure) { translateError(failure) }
  }
}

export async function revealWorkspaceDocument(req: WorkspaceFileRequest): Promise<void | { remote: true; path: string; parent: string; name: string }> {
  const editor = remoteEditor(req.workspaceId)
  if (!editor) { revealWorkspaceFile(req); return }
  try {
    const environment = getWorkspaceEnvironment(req.workspaceId)
    const key = environment.key
    const path = await editor.checkedPath(req.path, true)
    await environment.fs.stat(path)
    environment.assertReady()
    /**
     * ★ 迟到的返回不开 tab。`environment.key` 里带着 generation,重连就换一把。
     *
     * 中间这几次 await 期间工作区可能已经重连(甚至换了连接):那时算出来的
     * `parent` 属于**上一个**环境的根,渲染层照开不误,用户会得到一棵扎在陈旧路径上、
     * 每一项都列不出来的树。`assertReady()` 只保证手里这个环境对象自己还活着,
     * 不保证它还是这个工作区**当前**的环境 —— 所以要按 runtime 里 MCP 那套显式比 key。
     */
    if (getWorkspaceEnvironment(req.workspaceId).key !== key) throw new EnvironmentError('conflict')
    /**
     * ★ 用 realpath 后的根来比:`checkedPath` 返回的是 realpath 过的路径,而
     * `environment.rootPath` 是配置里的原样写法。根自身是软链时(BSD 的 /home →
     * /usr/home、macOS 的 /var → /private/var),拿两者直接比会把工作区内的文件
     * 判成越界。
     */
    const root = await environment.fs.realpath(environment.rootPath)
    /**
     * ★ 工作区相对写法里,根是**空串**不是 `'.'`。
     *
     * `display()` 对根返回 `'.'`(它是给人看的写法),而这条返回值是给机器用的:
     * 渲染层拿 `parent` 当 files tab 的 rootPath,`listWorkspaceDir` 再拿它拼每一项的
     * path。`'.'` 是真串,拼出来就是 `./a.txt` —— 而 `checkedPath` 明令拒绝 `.` 段,
     * 于是那棵树里的文件一个也打不开。根**下的每一个文件**都会走到这条路径上。
     */
    const relative = (absolute: string): string | undefined => {
      /**
       * ★ 必须走 `display()` 而不是 `relative()`。
       *
       * `relative()` 没有 `inside()` 判断:对工作区外的目标它产出 `../../etc` 这种字符串,
       * 渲染层原样当成 rootPath 开一个 files tab,而 `listWorkspaceDir` 只 resolve、不查
       * `outside`,于是工作区外的目录被整棵列出来。越界就不返回扎根指令 —— 文件树本来
       * 也表达不了工作区外的位置。注意围栏只针对 reveal 这个 UI 入口,Agent 通过工具
       * 显式访问绝对路径是被允许的行为,不在这里拦。
       */
      const shown = environment.path.display(root, absolute)
      if (environment.path.isAbsolute(shown)) return undefined
      return shown === '.' ? '' : shown
    }
    const name = environment.path.basename(path)
    // 根自己没有「在树里选中」这一说 —— 它就是树根。扎在根上,不选中任何一行。
    if (path === root) return { remote: true, path: '', parent: '', name }
    /**
     * ★ 目录也扎在**父目录**上并选中它自己,和本机 `showItemInFolder` 一致。
     *
     * 原先目录是扎在自己身上的,于是 `selectedPath` 恰好等于树根 —— 而树根永远不是
     * 树里的一行,「在文件管理器中显示」对任何目录都没有任何可见效果。
     */
    const parent = relative(environment.path.dirname(path))
    const selected = relative(path)
    if (parent === undefined || selected === undefined) return
    return { remote: true, path: selected, parent, name }
  } catch (error) {
    // 远端 stat 抛的是裸 ENOENT,不归一化就会在界面上显示成「读写失败」
    try { remoteFileFailure(error) } catch (failure) { translateError(failure) }
  }
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
  /**
   * ★ 先登记再写。原先 `onCreated` 排在写之后:顶层是文件且 `copyFileSync` 写到一半失败时,
   * 调用方的 `created` 仍是 false,那句 `rmSync(temporary)` 根本不执行 —— 半个
   * `.ncw-copy-*.tmp` 就永久留在用户工作区里。登记一个还没建成的路径是无害的,
   * 清理侧本来就是 `force: true`。
   */
  if (stat.isFile()) {
    onCreated?.()
    copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
  } else if (stat.isDirectory()) {
    onCreated?.()
    mkdirSync(destinationPath, { mode: stat.mode & 0o777 })
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
