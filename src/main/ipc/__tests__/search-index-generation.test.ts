/**
 * `@` 检索的索引键必须带上 **environment.key**(里面有 generation)。
 *
 * ★ 索引是按工作区缓存的,TTL 15 秒。重连换的是一台可能内容完全不同的机器 ——
 * 键里少了 generation,重连之后那 15 秒里 `@` 出来的仍是**上一个连接**的文件清单,
 * 用户挑一条插进草稿、发给模型,模型再去读一个这台服务器上根本不存在的路径。
 *
 * 这条性质现在是对的,但它整个挂在一行字符串插值上,而且没有任何测试看着它 ——
 * 「这个键为什么这么长」是最容易被顺手简化掉的那种东西。这里钉一根哨兵。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'

const mocks = vi.hoisted(() => ({ root: '' }))

vi.mock('../../state/store', () => ({
  store: { getWorkspace: (id: string) => id === 'workspace' ? { rootPath: mocks.root } : undefined }
}))
vi.mock('../../runtime', () => ({ getWorkspaceEnvironment: () => environment }))

import { forgetFileIndex, searchWorkspaceFiles } from '../workspace-search'

let temporary = ''
let environment: ReturnType<typeof remoteEnvironment>

function remoteEnvironment(generation: number) {
  return {
    ...localEnvironment(nodeHost(), mocks.root),
    remote: true,
    key: JSON.stringify(['ssh', 'profile', 1, generation]),
    generation,
    description: 'server'
  }
}

const names = async (query: string): Promise<string[]> =>
  (await searchWorkspaceFiles({ workspaceId: 'workspace', query })).map((s) => s.path)

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'ncw-search-'))
  mocks.root = join(temporary, 'workspace')
  mkdirSync(mocks.root, { recursive: true })
  writeFileSync(join(mocks.root, 'alpha.txt'), '')
  environment = remoteEnvironment(1)
  forgetFileIndex('workspace')
})

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true })
  forgetFileIndex('workspace')
})

/**
 * ★ 先钉住「缓存是真的存在」。没有这一条,下面那条重连的断言就可能是因为
 * 索引压根没缓存而通过的 —— 一条什么都没测到的绿。
 */
it('reuses the index within its TTL while the connection is unchanged', async () => {
  expect(await names('alpha')).toEqual(['alpha.txt'])
  writeFileSync(join(mocks.root, 'bravo.txt'), '')
  expect(await names('bravo'), 'TTL 内不重新遍历,所以看不到新文件').toEqual([])
})

it('rebuilds the index after a reconnect even inside the TTL', async () => {
  expect(await names('alpha')).toEqual(['alpha.txt'])
  writeFileSync(join(mocks.root, 'bravo.txt'), '')
  // 重连:generation 加一,environment.key 随之变
  environment = remoteEnvironment(2)
  expect(await names('bravo'), '新连接必须重新遍历,不能端上一个连接的清单').toEqual(['bravo.txt'])
})

/** 关工作区要把**各代**的索引都丢掉,不能只丢当前这一代 */
it('forgets indexes from every generation', async () => {
  await names('alpha')
  environment = remoteEnvironment(2)
  await names('alpha')
  forgetFileIndex('workspace')
  writeFileSync(join(mocks.root, 'bravo.txt'), '')
  environment = remoteEnvironment(1)
  expect(await names('bravo'), '第 1 代的索引也该被丢掉了').toEqual(['bravo.txt'])
})
