import { randomUUID } from 'node:crypto'
import type { WorkspaceFile, WorkspaceFileErrorCode, WorkspaceFileMutationRequest, WorkspaceFileMutationResult, WorkspaceFileWriteRequest, WorkspaceRecoveryEntry, WorkspaceRecoveryListing, WorkspaceTextFile } from '../../shared/domain/workspace-file'
import { WORKSPACE_FILE_ERROR_PREFIX, WORKSPACE_TEXT_LIMIT } from '../../shared/domain/workspace-file'
import { classifyWorkspaceFile, contentRevision, decodeWorkspaceText, isBinaryText, workspaceReadLimit } from '../kernel/workspace-file-content'
import type { EnvironmentStat, WorkspaceEnvironment } from './contract'
import { EnvironmentError, missingPath } from './errors'

export class EnvironmentFileError extends Error {
  constructor(readonly fileCode: WorkspaceFileErrorCode) { super(`${WORKSPACE_FILE_ERROR_PREFIX}${fileCode}`) }
}
const fail = (code: WorkspaceFileErrorCode): never => { throw new EnvironmentFileError(code) }

export class EnvironmentFiles {
  constructor(private readonly environment: WorkspaceEnvironment) {}

  private async statIfPresent(path: string): Promise<EnvironmentStat | undefined> {
    try { return await this.environment.fs.lstat(path) } catch (error) { if (missingPath(error)) return undefined; throw error }
  }

  /** 绝对路径 → 工作区相对写法。这个模块的约定是不向渲染层返回磁盘绝对路径。 */
  private relative(absolute: string): string {
    return this.environment.path.relative(this.environment.rootPath, absolute)
  }

  /** 可恢复项的索引目录,按需建出来。 */
  private async recoveryIndex(): Promise<string> {
    const environment = this.environment
    const index = environment.path.join(environment.rootPath, '.next-cowork', 'trash-index')
    const existing = await this.statIfPresent(index)
    if (existing?.isSymbolicLink || (existing && !existing.isDir)) fail('symlink')
    if (!existing) {
      await environment.fs.mkdirp(index)
      await environment.fs.mkdir(index)
    }
    return index
  }

  /**
   * 列出可恢复的删除项,顺带回收孤儿索引。
   *
   * ★ payload 不在了就把索引条目删掉 —— 恢复成功后的自清理走的就是这条,不需要
   * 恢复流程自己记得去删。`occupied` 让 UI 能在原路径已被重新占用时先让用户改名,
   * 而不是点一个必然撞 `exists` 的按钮。
   */
  async listRecovery(): Promise<WorkspaceRecoveryListing> {
    const environment = this.environment
    environment.assertReady()
    const index = environment.path.join(environment.rootPath, '.next-cowork', 'trash-index')
    const directory = await this.statIfPresent(index)
    if (!directory?.isDir || directory.isSymbolicLink) return { entries: [], environmentKey: environment.key }
    const entries: WorkspaceRecoveryEntry[] = []
    for (const file of await environment.fs.readDir(index)) {
      if (file.isDir || !file.name.endsWith('.json')) continue
      const entry = environment.path.join(index, file.name)
      let parsed: { originalPath?: unknown; recoveryPath?: unknown; deletedAt?: unknown }
      try {
        parsed = JSON.parse((await environment.fs.readBytes(entry, 64 * 1024)).toString('utf8')) as typeof parsed
      } catch { await environment.fs.unlink(entry).catch(() => {}); continue }
      const originalPath = parsed.originalPath
      const recoveryPath = parsed.recoveryPath
      if (typeof originalPath !== 'string' || typeof recoveryPath !== 'string') {
        await environment.fs.unlink(entry).catch(() => {}); continue
      }
      // payload 没了(多半是已经恢复过)→ 索引条目也没有存在意义
      const payload = await this.statIfPresent(environment.path.join(environment.rootPath, recoveryPath))
      if (!payload) { await environment.fs.unlink(entry).catch(() => {}); continue }
      entries.push({
        token: file.name.slice(0, -'.json'.length),
        originalPath,
        recoveryPath,
        deletedAt: typeof parsed.deletedAt === 'number' ? parsed.deletedAt : 0,
        occupied: (await this.statIfPresent(environment.path.join(environment.rootPath, originalPath))) !== undefined
      })
    }
    entries.sort((a, b) => b.deletedAt - a.deletedAt)
    return { entries, environmentKey: environment.key }
  }

  async checkedPath(input: string, allowRoot = false): Promise<string> {
    const environment = this.environment
    environment.assertReady()
    if (typeof input !== 'string' || input.includes('\0')) fail('invalid-path')
    const root = await environment.fs.realpath(environment.rootPath)
    if (input === '' && allowRoot) return root
    if (environment.path.isAbsolute(input)) {
      if ((await this.statIfPresent(input))?.isSymbolicLink) fail('symlink')
    } else {
      if (input.includes('\\') || /^[a-z]:/i.test(input)) fail('invalid-path')
      const segments = input.split('/')
      if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail('invalid-path')
      let part = root
      for (const segment of segments) {
        part = environment.path.join(part, segment)
        const stat = await this.statIfPresent(part)
        if (stat?.isSymbolicLink) fail('symlink')
        if (!stat) break
      }
    }
    const target = (await environment.path.resolve(root, input)).abs
    if (target === root && !allowRoot) fail('invalid-path')
    return target
  }

  async read(path: string): Promise<WorkspaceFile> {
    const environment = this.environment
    const target = await this.checkedPath(path)
    const before = await environment.fs.lstat(target)
    if (!before.isFile || before.isSymbolicLink) fail('not-file')
    const extension = environment.path.extname(path).toLowerCase()
    const limit = workspaceReadLimit(extension)
    if (before.size > limit) return classifyWorkspaceFile(path, extension, undefined, before)
    const bytes = await environment.fs.readBytes(target, limit)
    const after = await environment.fs.lstat(target)
    if (after.isSymbolicLink || !after.isFile || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== after.size) fail('conflict')
    return classifyWorkspaceFile(path, extension, bytes, after)
  }

  async write(request: WorkspaceFileWriteRequest): Promise<WorkspaceTextFile> {
    const environment = this.environment
    const target = await this.checkedPath(request.path)
    if (typeof request.content !== 'string' || typeof request.revision !== 'string') fail('invalid-encoding')
    const bytes = Buffer.from(request.content)
    if (bytes.length > WORKSPACE_TEXT_LIMIT) fail('too-large')
    if (decodeWorkspaceText(bytes) !== request.content || isBinaryText(request.content)) fail('invalid-encoding')
    const current = await this.read(request.path)
    if (current.kind !== 'text') return fail('unsupported')
    if (current.revision !== request.revision) fail('conflict')
    if (current.content === request.content) return current
    const temporary = environment.path.join(environment.path.dirname(target), `.ncw-save-${randomUUID()}.tmp`)
    let created = false
    try {
      await environment.fs.writeBytes(temporary, bytes, { exclusive: true, mode: (await environment.fs.lstat(target)).mode & 0o777 })
      created = true
      if (await this.checkedPath(request.path) !== target || (await this.read(request.path)).revision !== request.revision) fail('conflict')
      await environment.fs.rename(temporary, target, true)
      created = false
    } finally {
      if (created) await environment.fs.unlink(temporary).catch(() => {})
    }
    return { kind: 'text', path: request.path, content: request.content, size: bytes.length, revision: contentRevision(bytes) }
  }

  private async requireAbsent(path: string): Promise<void> { if (await this.statIfPresent(path)) fail('exists') }
  private async requireParent(path: string): Promise<void> {
    if (!(await this.environment.fs.lstat(this.environment.path.dirname(path))).isDir) fail('invalid-path')
  }

  async mutate(request: WorkspaceFileMutationRequest): Promise<WorkspaceFileMutationResult> {
    const environment = this.environment
    if (request.environmentKey !== undefined && request.environmentKey !== environment.key) throw new EnvironmentError('conflict')
    const target = await this.checkedPath(request.path)
    if (request.operation === 'create-file' || request.operation === 'create-directory') {
      await this.requireParent(target)
      if (request.operation === 'create-file') await environment.fs.writeBytes(target, new Uint8Array(), { exclusive: true })
      else await environment.fs.mkdir(target)
    } else if (request.operation === 'delete') {
      const parent = environment.path.dirname(target)
      const trash = environment.path.join(parent, '.next-cowork-trash')
      if (target === trash) fail('unsupported')
      const existing = await this.statIfPresent(trash)
      if (existing?.isSymbolicLink || (existing && !existing.isDir)) fail('symlink')
      if (!existing) await environment.fs.mkdir(trash)
      const token = randomUUID()
      const recoveryPath = environment.path.join(trash, `${token}-${environment.path.basename(target)}`)
      /**
       * ★ 索引集中在 `<root>/.next-cowork/trash-index/`,而 payload 留在原父目录的回收站里。
       *
       * 分开放的理由各有一条:payload 不跨目录搬是为了避开跨设备 rename(远端挂载点很常见);
       * 索引集中是为了让「列出所有可恢复项」只读一个目录,而不是扫整棵树找 .next-cowork-trash。
       * 原先这份 metadata 写在 payload 旁边且**从来没有任何代码读过它**,恢复入口只活在
       * React 组件的单槽 state 里 —— 删第二个就覆盖第一个,切子树根就全没。
       */
      const index = await this.recoveryIndex()
      const entry = environment.path.join(index, `${token}.json`)
      const rollback: string[] = []
      await environment.fs.writeBytes(entry, Buffer.from(JSON.stringify({
        originalPath: this.relative(target), recoveryPath: this.relative(recoveryPath), deletedAt: Date.now()
      })), { exclusive: true })
      rollback.push(entry)
      try {
        if (await this.checkedPath(request.path) !== target) fail('conflict')
        await environment.fs.rename(target, recoveryPath)
      } catch (error) {
        // 索引条目和刚建出来的回收站目录都不能留:它们会变成永远指不到 payload 的孤儿
        for (const path of rollback) await environment.fs.unlink(path).catch(() => {})
        if (!existing) await environment.fs.rmdir(trash).catch(() => {})
        throw error
      }
      return { path: request.path, recoveryPath: this.relative(recoveryPath), environmentKey: environment.key }
    } else if (request.operation === 'rename' || request.operation === 'move' || request.operation === 'copy') {
      if (typeof request.destination !== 'string') return fail('invalid-path')
      const destination = await this.checkedPath(request.destination)
      const stat = await environment.fs.lstat(target)
      if (!stat.isFile && !stat.isDir) fail('unsupported')
      const relative = environment.path.relative(target, destination)
      if (stat.isDir && (relative === '' || (!relative.startsWith('../') && relative !== '..' && !environment.path.isAbsolute(relative)))) fail('invalid-path')
      await this.requireAbsent(destination)
      await this.requireParent(destination)
      if (request.operation === 'copy') await this.copy(target, destination)
      else await environment.fs.rename(target, destination)
      return { path: request.path, destination: request.destination }
    } else fail('unsupported')
    return { path: request.path }
  }

  private async copy(source: string, destination: string): Promise<void> {
    const { fs, path } = this.environment
    const entries: Array<{ source: string; relative: string; stat: EnvironmentStat }> = []
    let bytes = 0
    const inspect = async (absolute: string, relative: string): Promise<void> => {
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink || (!stat.isFile && !stat.isDir)) fail('unsupported')
      entries.push({ source: absolute, relative, stat })
      bytes += stat.isFile ? stat.size : 0
      if (entries.length > 10_000 || bytes > 256 * 1024 * 1024) fail('too-large')
      if (stat.isDir) for (const entry of await fs.readDir(absolute)) await inspect(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
    }
    await inspect(source, '')
    const temporary = path.join(path.dirname(destination), `.ncw-copy-${randomUUID()}.tmp`)
    const created: Array<{ path: string; isDir: boolean }> = []
    try {
      let transferred = 0
      for (const entry of entries) {
        const output = entry.relative ? path.join(temporary, entry.relative) : temporary
        if ((await fs.lstat(entry.source)).isSymbolicLink) fail('symlink')
        // ★ 先登记再写：copyFile 写到一半断线时，目标文件可能已存在却不在清理名单里，
        //   finally 对暂存根目录的 rmdir 会因「目录非空」失败并被吞掉，.ncw-copy-*.tmp 永久残留
        created.push({ path: output, isDir: entry.stat.isDir })
        if (entry.stat.isDir) await fs.mkdir(output)
        else transferred += await fs.copyFile(entry.source, output, 256 * 1024 * 1024 - transferred, entry.stat.mode & 0o777)
      }
      await this.requireAbsent(destination)
      await fs.rename(temporary, destination)
      created.length = 0
    } finally {
      for (const entry of created.reverse()) await (entry.isDir ? fs.rmdir(entry.path) : fs.unlink(entry.path)).catch(() => {})
    }
  }
}

export function remoteFileFailure(error: unknown): never {
  if (error instanceof EnvironmentFileError || error instanceof EnvironmentError) throw error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') fail('not-found')
  if (code === 'EEXIST' || code === 'ENOTEMPTY') fail('exists')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') fail('permission')
  if (code === 'ENOTSUP') fail('unsupported')
  throw error
}