/**
 * copy 的暂存目录在失败路径上必须清干净。
 *
 * ★ 原先 `created.push` 排在写操作**之后**:`copyFile` 写到一半失败时，目标文件已经存在却
 * 不在清理名单里，于是 finally 里对暂存根目录的 `rmdir` 因「目录非空」失败、又被 `.catch`
 * 吞掉 —— `.ncw-copy-*.tmp` 就永久留在用户的工作区里。本地 `copyTree` 的 `onCreated` 是
 * 同一个形状的问题。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EnvironmentFiles } from '../files'
import { localEnvironment } from '../local'
import { nodeHost } from '../../kernel/host'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ncw-copy-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'payload')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const staging = (): string[] => readdirSync(root).filter((name) => name.startsWith('.ncw-copy-'))

it('leaves no staging directory behind when a remote copy fails mid-write', async () => {
  const environment = { ...localEnvironment(nodeHost(), root), remote: true, key: 'server:1', description: 'server' }
  // 复刻断线:文件已经建出来了，然后传输失败
  environment.fs.copyFile = async (_source: string, destination: string): Promise<number> => {
    await writeFile(destination, 'half')
    throw new Error('network dropped')
  }
  const files = new EnvironmentFiles(environment)
  await expect(files.mutate({ workspaceId: 'w', path: 'src', operation: 'copy', destination: 'copied' })).rejects.toThrow()
  expect(staging(), '失败的 copy 不得留下 .ncw-copy-*.tmp').toEqual([])
  expect(readdirSync(root).includes('copied'), '失败时绝不能留下半个目标').toBe(false)
})
