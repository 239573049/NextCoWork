import { app, clipboard, dialog, shell } from 'electron'
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
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_APP_TARGET_ID, REVEAL_TARGET_ID, type OpenTarget, type WorkspacePathKind } from '../../shared/domain/open-target'
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
  type WorkspaceRecoveryListing
} from '../../shared/domain/workspace-file'
import { PathEscapeError, resolveAnywhere } from '../kernel/tool/path-guard'
import { store } from '../state/store'
import { IpcError } from './errors'
import { isLocalEnvironment } from '../../shared/domain/environment'
import { getWorkspaceEnvironment } from '../runtime'
import { EnvironmentError } from '../environment/errors'
import { EnvironmentFileError, EnvironmentFiles, remoteFileFailure } from '../environment/files'
import { classifyWorkspaceFile, contentRevision as revision, decodeWorkspaceText as decodeText, isBinaryText as binaryText, workspaceReadLimit } from '../kernel/workspace-file-content'
import { displayPath } from '../kernel/tool/path-guard'
import { listOpenTargets as systemOpenTargets, openWithTarget } from '../system/open-with'

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
export async function writeWorkspaceDocument(req: WorkspaceFileWriteRequest): Promise<WorkspaceFile> {
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

export function writeWorkspaceFile(req: WorkspaceFileWriteRequest): WorkspaceFile {
  try {
    const root = workspaceRoot(req.workspaceId)
    const target = checkedPath(root, req.path)
    if (typeof req.content !== 'string' || typeof req.revision !== 'string') fail('invalid-encoding')
    /*
      需求:图片编辑类自定义编辑器要把编辑后的字节写回原文件。文本支线的
      校验(UTF-8 往返 + 拒二进制文本)对图片字节必然失败,这里按 `encoding`
      分流。二进制支线只对「当前已分类为 image 的文件」开放 —— 路径校验、
      软链拒绝、乐观锁、临时文件原子替换与文本支线走的是同一条路,不开新门。
    */
    if (req.encoding === 'base64') return writeBase64File(root, req, target)
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

/**
 * `encoding: 'base64'` 的写入支线 —— 覆写一张**已存在的图片**。
 *
 * 与文本支线的唯一差异是「字节从哪来、写到哪类文件」;其余不变式
 * (乐观锁、软链拒绝、同目录临时文件 + 原子替换、mode 保留)逐条对齐,
 * 理由都在文本支线里,不在此复述。
 */
function writeBase64File(root: string, req: WorkspaceFileWriteRequest, target: string): WorkspaceFile {
  // ★ 先按长度粗拒再解码:base64 字符串长度约为字节的 4/3,这一挡把
  //   「解码前就注定超限」的请求挡在 Buffer 分配之前。
  if (req.content.length > WORKSPACE_IMAGE_LIMIT * 2) fail('too-large')
  /*
    ★ 严格校验 base64,不依赖 `Buffer.from` 的宽容:它对非法字符是**静默丢弃**,
    不报错 —— 一次被截断的 payload 会被「成功」写进半张图。这里的两条
    (字符表 + 往返一致)合起来只放行规范的补齐 base64,canvas.toDataURL
    产出的正是这种。
  */
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(req.content)) fail('invalid-encoding')
  const bytes = Buffer.from(req.content, 'base64')
  if (bytes.toString('base64') !== req.content) fail('invalid-encoding')
  if (bytes.length > WORKSPACE_IMAGE_LIMIT) fail('too-large')
  const current = readFileAt(root, req.path)
  if (current.kind === 'binary' && current.reason === 'too-large') fail('too-large')
  if (current.kind !== 'image') fail('unsupported')
  if (current.revision !== req.revision) fail('conflict')
  // 内容没变就不写:与文本支线同一条规矩,免得「只是看了看」也把 mtime 顶起来。
  if (current.revision === revision(bytes)) return current

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
  const dataUrl = `data:${current.mime};base64,${bytes.toString('base64')}`
  return { kind: 'image', path: req.path, size: bytes.length, revision: revision(bytes), mime: current.mime, dataUrl }
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
        /*
          ★ `overwrite` **只对 rename 生效**,而且覆盖的实现是先把目标丢进系统
          废纸篓再改名 —— 同这个文件 delete 分支的立场:失败不降级为永久删除。
          直接 `renameSync` 盖上去的话,被盖掉的那份连废纸篓里都找不到。

          ★★ 目标是**目录**时一律拒绝。确认框上写的是「覆盖这个文件」,
          而把一整棵子树丢进废纸篓是另一回事,不能用同一句话换到同意。
        */
        if (req.overwrite === true && req.operation === 'rename') {
          const existing = statIfPresent(destination)
          if (existing) {
            if (!existing.isFile()) fail('exists')
            await shell.trashItem(destination)
          }
        }
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

/**
 * 「打开方式」下拉里那几项。
 *
 * ★ **不发路径给渲染层,只发 id + 产品名 + 图标 id**(见 `shared/domain/open-target.ts`)。
 * 菜单是渲染层画的,而绝对路径不进渲染层 —— 这是 `workspace-file.ts` 顶上那条
 * 约定,「复制绝对路径」因此也由主进程直接写剪贴板(见下面的 `copyWorkspacePath`)。
 *
 * ★ 与 `workspace:revealFile` 不同,这条**不需要工作区**:菜单内容只取决于这台
 * 机器上装了什么,和当前打开的是哪个工作区无关。渲染层在远端工作区里不画这个
 * 菜单(那些文件不在本机磁盘上),判断在调用点。
 */
export function listOpenTargets(): OpenTarget[] {
  return systemOpenTargets()
}

/**
 * 用某个程序打开工作区里的一个文件。
 *
 * 两条不变式,和这个文件里其它入口逐条对齐:
 *
 * 1. **路径仍走 `checkedPath`** —— 渲染层递进来的 id 查表即用,但路径照样是
 *    不可信输入(工具卡片给出的绝对路径也落在这条路上)。
 * 2. **目标 id 只用来查表。** 渲染层指定不了要跑什么命令,只能从
 *    `listOpenTargets()` 给过的那几个里挑一个。
 *
 * ★ **不存在的目标静默忽略。** 这一条不是偷懒:磁盘上的文件可能在这几次
 * `await` 之间被别的程序删掉/改名,那时编辑器照样能起来、只是打开一个空缓冲;
 * 而把「文件没了」报成「打开失败」会让用户去查编辑器装没装。真实失败
 * (编辑器被卸载、没权限)由 `open-with.ts` 那侧清缓存,下一次探测就不再列出它。
 */
export async function openWorkspaceFileWith(req: { workspaceId: string; path: string; targetId: string }): Promise<void> {
  let target: string
  try {
    target = checkedPath(workspaceRoot(req.workspaceId), req.path, true)
    lstatSync(target)
  } catch {
    return
  }
  /*
    需求:「打开方式」子菜单里的「文件管理器」「默认应用」两项要真的能用 ——
    它们不是可执行文件,`system/open-with.ts` 那张表里查不到,原先落进那边的
    `unknown open target` 分支,表现是点了「文件管理器」只弹一句「无法用这个程序打开」。
    两者都是 Electron 的 `shell` 能力,所以在这一层分流,而不是让 `system/open-with.ts`
    去依赖 Electron(那个文件只管真实进程)。
  */
  if (req.targetId === REVEAL_TARGET_ID) {
    shell.showItemInFolder(target)
    return
  }
  if (req.targetId === DEFAULT_APP_TARGET_ID) {
    // ★ openPath 失败不抛,返回一段错误文本(没有关联程序时就是这种)。不检查的话
    //   用户点了没反应、也没有任何提示。
    const failure = await shell.openPath(target)
    if (failure !== '') throw new IpcError('unknown', failure)
    return
  }
  await openWithTarget(req.targetId, target)
}

/**
 * 文件树右键「另存为…」:把工作区里的一个文件复制到用户在系统对话框里挑的位置。
 *
 * 和 `app:saveTextFile` 同一条约定:**落点由 showSaveDialog 产出**,渲染层只给
 * 工作区相对路径;源文件照样走 `checkedPath`(软链、越界一律拒)。只做本机工作区 ——
 * 远端文件不在本机磁盘上,`workspaceRoot` 会直接拒掉。
 *
 * 返回 false = 用户取消;调用方据此区分「没存」和「存失败」(后者抛错)。
 * 不回传目标路径:渲染层用不着它,也就不必让一条本机绝对路径进渲染层。
 */
export async function saveWorkspaceFileAs(req: { workspaceId: string; path: string }): Promise<boolean> {
  let source: string
  try {
    source = checkedPath(workspaceRoot(req.workspaceId), req.path)
    if (!lstatSync(source).isFile()) fail('not-file')
  } catch (error) {
    translateError(error)
  }
  const result = await dialog.showSaveDialog({
    defaultPath: join(app.getPath('downloads'), basename(source))
  })
  if (result.canceled || !result.filePath) return false
  // ★ 挑了源文件自己:复制到自身在部分平台上会先截断再读,等于把文件清空。
  if (resolve(result.filePath) === source) return true
  try {
    copyFileSync(source, result.filePath)
  } catch (error) {
    translateError(error)
  }
  return true
}

/**
 * 把一条路径写进系统剪贴板,**返回真正写进去的那一串**。
 *
 * ★ 为什么要主进程做:绝对路径不能进渲染层(这个文件的既有约定),
 *   而「复制相对路径」在**工作区外**的文件上只能是绝对路径 —— 判定要拿到
 *   真实根目录才做得对,那也只有主进程有。
 *
 * ★ 返回值不是装饰:工作区外的文件复制出来的是绝对路径,界面若还显示
 *   「已复制相对路径」,用户会以为拿到的是一条相对路径,粘到别处才发现不对。
 */
export async function copyWorkspacePath(req: { workspaceId: string; path: string; kind: WorkspacePathKind }): Promise<string> {
  const root = workspaceRoot(req.workspaceId)
  const target = checkedPath(root, req.path, true)
  lstatSync(target)
  const text = req.kind === 'relative' ? displayPath(root, target) : target
  clipboard.writeText(text)
  return text
}
