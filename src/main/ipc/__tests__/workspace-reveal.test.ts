import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'

const mocks = vi.hoisted(() => ({ root: '', reveal: vi.fn(), trash: vi.fn() }))

vi.mock('electron', () => ({ shell: { showItemInFolder: mocks.reveal, trashItem: mocks.trash } }))
vi.mock('../../state/store', () => ({
  store: {
    getWorkspace: (id: string) =>
      id === 'workspace'
        ? { rootPath: mocks.root, environment: { kind: 'connection', connectionId: 'server-a' } }
        : undefined
  }
}))
vi.mock('../../runtime', () => ({ getWorkspaceEnvironment: () => environment }))

import { revealWorkspaceDocument } from '../workspace-files'

// 用真实临时目录:越界判定要经过 realpath(macOS 上 /var 与 /private/var),假根会全绿地什么都没测到
let temporary = ''
let outside = ''
let environment: ReturnType<typeof remoteEnvironment>

function remoteEnvironment() {
  // 复用本机实现的 fs/path,只把它标成远端 —— 被测的是 reveal 的围栏,不是 SFTP
  return { ...localEnvironment(nodeHost(), mocks.root), remote: true, key: 'server-a:1', description: 'server-a' }
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'ncw-reveal-'))
  mocks.root = join(temporary, 'workspace')
  outside = join(temporary, 'outside')
  mkdirSync(join(mocks.root, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(mocks.root, 'src', 'a.ts'), '')
  writeFileSync(join(outside, 'secret.env'), '')
  environment = remoteEnvironment()
  mocks.reveal.mockClear()
})

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true })
})

it('roots the tree at the revealed file inside the workspace', async () => {
  const result = await revealWorkspaceDocument({ workspaceId: 'workspace', path: 'src/a.ts' })
  expect(result).toEqual({ remote: true, path: 'src/a.ts', parent: 'src', name: 'a.ts' })
})

/**
 * ★ `parent` 是渲染层用来扎文件树根的。原先它走 `relative()`(没有 inside 判断),
 * 对工作区外的目标产出 `../../outside`,渲染层原样开成 files tab 的 rootPath,
 * 而 listWorkspaceDir 只 resolve、不查 outside —— 工作区外的目录被整棵列出来。
 */
it('never hands back a tree root outside the workspace', async () => {
  const result = await revealWorkspaceDocument({ workspaceId: 'workspace', path: join(outside, 'secret.env') })
  expect(result, 'an out-of-workspace reveal must not produce a tree root').toBeUndefined()
})

/** 远端工作区绝不能调用本机 Finder/资源管理器 —— 那会打开客户端上一个毫不相干的路径。 */
it('never calls the client file manager for a remote workspace', async () => {
  await revealWorkspaceDocument({ workspaceId: 'workspace', path: 'src/a.ts' })
  await revealWorkspaceDocument({ workspaceId: 'workspace', path: join(outside, 'secret.env') })
  expect(mocks.reveal).not.toHaveBeenCalled()
})
