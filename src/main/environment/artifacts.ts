import { randomUUID } from 'node:crypto'
import { promises as localFs } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceEnvironment } from './contract'
import { EnvironmentError, missingPath } from './errors'
import { EnvironmentFiles } from './files'

export async function uploadWorkspaceAttachment(environment: WorkspaceEnvironment, bytes: Uint8Array, name: string, assertCurrent: () => void = () => environment.assertReady()): Promise<string> {
  assertCurrent()
  environment.assertReady()
  if (!environment.remote || bytes.byteLength > 32 * 1024 * 1024) throw new EnvironmentError('unsupported')
  const files = new EnvironmentFiles(environment)
  const directory = await files.checkedPath('.next-cowork/attachments')
  const extension = /\.[a-z0-9]{1,16}$/i.exec(name)?.[0] ?? '.bin'
  const token = randomUUID()
  const temporary = environment.path.join(directory, `.ncw-upload-${token}.tmp`)
  const target = environment.path.join(directory, `${token}${extension}`)
  assertCurrent()
  await environment.fs.mkdirp(temporary)
  if (await files.checkedPath('.next-cowork/attachments') !== directory) throw new EnvironmentError('conflict')
  try {
    assertCurrent()
    await environment.fs.writeBytes(temporary, bytes, { exclusive: true, mode: 0o600 })
    assertCurrent()
    if (await files.checkedPath('.next-cowork/attachments') !== directory) throw new EnvironmentError('conflict')
    await environment.fs.rename(temporary, target)
    return target
  } finally { await environment.fs.unlink(temporary).catch(() => {}) }
}

/**
 * 有界的递归删除。`EnvironmentFs` 只有 readDir/lstat/rmdir/unlink,没有现成的递归删。
 *
 * ★ 必须用 `lstat` 而不是 `stat`:备份目录里一条指向目录的软链,用 `stat` 会让递归
 * 顺着链接删到**链接目标**里去 —— 那可能是用户工作区外的任意目录。
 * 深度上限是防御远端返回环状结构时把自己转死,不是业务限制。
 */
async function removeTree(environment: WorkspaceEnvironment, path: string, depth = 0): Promise<void> {
  if (depth > 32) throw new EnvironmentError('unsupported')
  let stat
  try { stat = await environment.fs.lstat(path) } catch (error) {
    if (missingPath(error)) return
    throw error
  }
  if (stat.isDir && !stat.isSymbolicLink) {
    for (const entry of await environment.fs.readDir(path)) {
      await removeTree(environment, environment.path.join(path, entry.name), depth + 1)
    }
    await environment.fs.rmdir(path)
  } else await environment.fs.unlink(path)
}

export async function publishLocalDirectory(environment: WorkspaceEnvironment, source: string, destination: string): Promise<string> {
  environment.assertReady()
  if (!environment.remote) throw new EnvironmentError('unsupported')
  const target = await environment.path.resolveWithin(environment.rootPath, destination)
  const files: Array<{ source: string; relative: string; directory: boolean; size: number; mode: number }> = []
  let total = 0
  const inspect = async (absolute: string, relative: string): Promise<void> => {
    const stat = await localFs.lstat(absolute)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new EnvironmentError('unsupported')
    total += stat.isFile() ? stat.size : 0
    if (files.length >= 1000 || total > 50 * 1024 * 1024 || stat.size > 32 * 1024 * 1024) throw new EnvironmentError('unsupported')
    files.push({ source: absolute, relative, directory: stat.isDirectory(), size: stat.size, mode: stat.mode & 0o777 })
    if (stat.isDirectory()) for (const name of await localFs.readdir(absolute)) {
      if (name.includes('\\') || name.includes(':')) throw new EnvironmentError('invalid-path')
      await inspect(join(absolute, name), relative ? `${relative}/${name}` : name)
    }
  }
  await inspect(source, '')
  if (!files[0]?.directory) throw new EnvironmentError('invalid-path')
  const staging = environment.path.join(environment.path.dirname(target), `.ncw-upload-${randomUUID()}`)
  const backup = environment.path.join(environment.path.dirname(target), `.ncw-backup-${randomUUID()}`)
  const created: Array<{ path: string; directory: boolean }> = []
  let backedUp = false
  try {
    /**
     * ★ `mkdirp(p)` 的语义是**确保 p 的父目录存在**(实现就是 `mkdir(dirname(p), { recursive })`),
     * 不是 `mkdir -p p`。所以这一句建出来的是 `dirname(target)` —— staging 和 backup 都落在那儿,
     * 正是需要的;target 自己**不会**被建出来,于是首装时下面那句 `lstat(target)` 如实抛 ENOENT,
     * `backedUp` 保持 false,不留空备份。别改成 `mkdirp(dirname(target))`:那只保证
     * `dirname(dirname(target))` 存在,往尚不存在的子目录发布时会 ENOENT。
     */
    await environment.fs.mkdirp(target)
    if (await environment.path.resolveWithin(environment.rootPath, target) !== target) throw new EnvironmentError('conflict')
    for (const file of files) {
      environment.assertReady()
      const output = file.relative ? environment.path.join(staging, file.relative) : staging
      if (file.directory) await environment.fs.mkdir(output)
      else {
        const current = await localFs.lstat(file.source)
        if (!current.isFile() || current.isSymbolicLink() || current.size !== file.size) throw new EnvironmentError('conflict')
        const bytes = await localFs.readFile(file.source)
        if (bytes.length !== file.size) throw new EnvironmentError('conflict')
        await environment.fs.writeBytes(output, bytes, { exclusive: true, mode: file.mode })
      }
      created.push({ path: output, directory: file.directory })
    }
    try {
      const previous = await environment.fs.lstat(target)
      if (previous.isSymbolicLink || !previous.isDir) throw new EnvironmentError('conflict')
      await environment.fs.rename(target, backup)
      backedUp = true
    } catch (error) { if (!missingPath(error)) throw error }
    await environment.fs.rename(staging, target)
    created.length = 0
    // 成功了才删备份。★ 原先这里什么都不做,于是每装一次项目技能就在服务器上多留一个
    // .ncw-backup-<uuid>,永不回收。删失败不影响这次发布已经成功的事实,所以吞掉。
    if (backedUp) await removeTree(environment, backup).catch(() => {})
    return target
  } catch (error) {
    if (backedUp && !(error instanceof EnvironmentError && error.code === 'result-unknown')) {
      await environment.fs.exists(target).then((exists) => exists ? undefined : environment.fs.rename(backup, target)).catch(() => undefined)
    }
    throw error
  } finally {
    for (const entry of created.reverse()) await (entry.directory ? environment.fs.rmdir(entry.path) : environment.fs.unlink(entry.path)).catch(() => {})
  }
}