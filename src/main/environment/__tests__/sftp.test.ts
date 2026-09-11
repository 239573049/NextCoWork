import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { EnvironmentError } from '../errors'
import { SftpFileSystem } from '../ssh/sftp'
import { createWorkspacePaths } from '../paths'
import { EnvironmentFiles } from '../files'
import { localEnvironment } from '../local'
import { nodeHost } from '../../kernel/host'
import { publishLocalDirectory, uploadWorkspaceAttachment } from '../artifacts'

const server = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync)

it.skipIf(!server)('talks to the native SFTP subsystem without parsing shell output', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ncw-sftp-')))
  const child = spawn(server!, [], { stdio: 'pipe' })
  const fs = new SftpFileSystem(child.stdin, child.stdout, process.platform)
  try {
    await fs.ready
    const target = join(root, 'file with spaces.bin')
    const bytes = Buffer.from([0, 1, 10, 128, 255])
    await fs.writeBytes(target, bytes, { exclusive: true })
    expect(await fs.readBytes(target)).toEqual(bytes)
    expect(Buffer.from(await fs.readFileBytes(target, 2))).toEqual(bytes.subarray(0, 2))
    await expect(fs.writeBytes(target, Buffer.from('overwrite'), { exclusive: true })).rejects.toThrow()
    expect(await fs.readBytes(target)).toEqual(bytes)
    const temporary = join(root, 'replacement')
    await fs.writeBytes(temporary, Buffer.from('replacement'), { exclusive: true })
    await fs.rename(temporary, target, true)
    expect(await fs.readFile(target)).toBe('replacement')
    await fs.mkdirp(join(root, 'nested', 'child', 'file.txt'))
    expect((await fs.stat(join(root, 'nested', 'child'))).isDir).toBe(true)
    await symlink(tmpdir(), join(root, 'outside'))
    const paths = createWorkspacePaths(fs, process.platform)
    await expect(paths.resolveWithin(root, 'outside')).rejects.toThrow()
    expect((await fs.readDir(root)).map((entry) => entry.name)).toContain('file with spaces.bin')
    const editor = new EnvironmentFiles({ ...localEnvironment(nodeHost(), root), fs, path: paths, remote: true })
    await fs.writeFile(join(root, 'editable.txt'), 'original')
    const document = await editor.read('editable.txt')
    await editor.write({ workspaceId: 'remote', path: 'editable.txt', revision: document.revision, content: 'saved' })
    await expect(editor.write({ workspaceId: 'remote', path: 'editable.txt', revision: document.revision, content: 'stale' })).rejects.toThrow('conflict')
    expect(await fs.readFile(join(root, 'editable.txt'))).toBe('saved')
    await editor.mutate({ workspaceId: 'remote', path: 'editable.txt', destination: 'copy.txt', operation: 'copy' })
    expect(await fs.readFile(join(root, 'copy.txt'))).toBe('saved')
    const deleted = await editor.mutate({ workspaceId: 'remote', path: 'copy.txt', operation: 'delete' })
    expect(await fs.exists(join(root, 'copy.txt'))).toBe(false)
    // recoveryPath 是**工作区相对**写法(这个模块不向渲染层返回磁盘绝对路径),所以裸 fs 要自己拼根
    expect(deleted.recoveryPath!.startsWith('/')).toBe(false)
    expect(await fs.readFile(join(root, deleted.recoveryPath!))).toBe('saved')
    await expect(editor.mutate({ workspaceId: 'remote', path: deleted.recoveryPath!, operation: 'move', destination: 'copy.txt', environmentKey: 'another-server' })).rejects.toThrow('conflict')
    await editor.mutate({ workspaceId: 'remote', path: deleted.recoveryPath!, operation: 'move', destination: 'copy.txt', environmentKey: deleted.environmentKey })
    expect(await fs.readFile(join(root, 'copy.txt'))).toBe('saved')
    /**
     * ★ 恢复入口是从**服务器上的索引**派生的,不是客户端状态。
     *
     * 原先 metadata 写在 payload 旁边且从来没有任何代码读过它,恢复按钮只活在 FilesView
     * 的单槽 useState 里:删第二个覆盖第一个、切子树根就全没、重连重启更不用说。
     * 这一组按删两个 → 列出两条 → 恢复其一 → 孤儿索引自清理的顺序走一遍。
     */
    await fs.writeFile(join(root, 'one.txt'), '1')
    await fs.writeFile(join(root, 'two.txt'), '2')
    const first = await editor.mutate({ workspaceId: 'remote', path: 'one.txt', operation: 'delete' })
    await editor.mutate({ workspaceId: 'remote', path: 'two.txt', operation: 'delete' })
    const listed = await editor.listRecovery()
    expect(listed.entries.map((entry) => entry.originalPath).sort(), '删两个就要能列出两个').toEqual(['one.txt', 'two.txt'])
    expect(listed.entries.every((entry) => !entry.occupied)).toBe(true)
    // 原路径被重新占用时要标出来,否则用户只能点一个必然撞 exists 的按钮
    await fs.writeFile(join(root, 'one.txt'), 'reoccupied')
    expect((await editor.listRecovery()).entries.find((entry) => entry.originalPath === 'one.txt')?.occupied).toBe(true)
    await fs.unlink(join(root, 'one.txt'))
    await editor.mutate({ workspaceId: 'remote', path: first.recoveryPath!, operation: 'move', destination: 'one.txt', environmentKey: first.environmentKey })
    expect(await fs.readFile(join(root, 'one.txt'))).toBe('1')
    const afterRestore = await editor.listRecovery()
    expect(afterRestore.entries.map((entry) => entry.originalPath), '恢复成功后孤儿索引要自清理').toEqual(['two.txt'])
    await expect(editor.read('outside/file')).rejects.toThrow('symlink')
    const source = await mkdtemp(join(tmpdir(), 'ncw-local-package-'))
    try {
      await writeFile(join(source, 'SKILL.md'), 'package')
      await mkdir(join(source, 'scripts'))
      await writeFile(join(source, 'scripts', 'run.sh'), 'exit 0', { mode: 0o700 })
      const remote = { ...localEnvironment(nodeHost(), root), fs, path: paths, remote: true }
      await publishLocalDirectory(remote, source, join(root, 'skills', 'package'))
      expect(await fs.readFile(join(root, 'skills', 'package', 'scripts', 'run.sh'))).toBe('exit 0')
      expect((await fs.stat(join(root, 'skills', 'package', 'scripts', 'run.sh'))).mode & 0o777).toBe(0o700)
      expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe('package')
      /**
       * ★ 首装不留备份,重装也不留。
       *
       * `mkdirp(p)` 只保证 p 的**父目录**存在,所以首装时 target 不存在、不会进备份分支;
       * 重装时 target 被 rename 成 .ncw-backup-<uuid>,发布成功后必须删掉 —— 否则每装一次
       * 项目技能就在服务器上多积一个备份目录,永不回收。
       */
      const leftovers = async (): Promise<string[]> =>
        (await fs.readDir(join(root, 'skills'))).map((entry) => entry.name).filter((name) => name.startsWith('.ncw-'))
      expect(await leftovers(), '首装不应产生备份或暂存目录').toEqual([])
      await writeFile(join(source, 'SKILL.md'), 'republished')
      await publishLocalDirectory(remote, source, join(root, 'skills', 'package'))
      expect(await fs.readFile(join(root, 'skills', 'package', 'SKILL.md'))).toBe('republished')
      expect(await leftovers(), '重装成功后备份目录必须被回收').toEqual([])
      const uploaded = await uploadWorkspaceAttachment(remote, Buffer.from('CLIENT FILE'), '../../report.pdf')
      expect(uploaded).toContain(join(root, '.next-cowork', 'attachments'))
      expect(uploaded).toMatch(/\.pdf$/)
      expect(await fs.readFile(uploaded)).toBe('CLIENT FILE')
      expect((await fs.stat(uploaded)).mode & 0o777).toBe(0o600)
    } finally { await rm(source, { recursive: true, force: true }) }
    await fs.unlink(target)
    expect(await fs.exists(target)).toBe(false)
  } finally {
    fs.close()
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it.skipIf(!server)('reports unknown writes and keeps the original failure when cleanup also disconnects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ncw-sftp-failure-')))
  const child = spawn(server!, [], { stdio: 'pipe' })
  let connected = true
  const fs = new SftpFileSystem(child.stdin, child.stdout, process.platform, () => {
    if (!connected) throw new EnvironmentError('disconnected')
  })
  try {
    await fs.ready
    vi.spyOn(fs.stream, 'writeData').mockImplementation(() => { connected = false; fs.close(); return true })
    await expect(fs.writeBytes(join(root, 'interrupted'), Buffer.from('value'), { exclusive: true })).rejects.toMatchObject({ code: 'result-unknown' })
    await expect(fs.readFile(join(root, 'interrupted'))).rejects.toMatchObject({ code: 'disconnected' })
  } finally { fs.close(); child.kill(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(!server)('preserves the destination when an atomic replacement is refused', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ncw-sftp-atomic-')))
  const child = spawn(server!, [], { stdio: 'pipe' })
  const fs = new SftpFileSystem(child.stdin, child.stdout, process.platform)
  try {
    await fs.ready
    const path = join(root, 'protected')
    await fs.writeFile(path, 'original')
    vi.spyOn(fs.stream, 'ext_openssh_rename').mockImplementation((_source, _destination, callback) => { callback({ code: 8 }); return true })
    await expect(fs.writeFile(path, 'replacement')).rejects.toMatchObject({ code: 'ENOTSUP' })
    expect(await fs.readFile(path)).toBe('original')
    expect((await fs.readDir(root)).map((entry) => entry.name)).toEqual(['protected'])
  } finally { fs.close(); child.kill(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})