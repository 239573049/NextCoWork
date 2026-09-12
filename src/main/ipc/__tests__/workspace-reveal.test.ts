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
  writeFileSync(join(mocks.root, 'top.md'), '')
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
 * ★ 工作区相对写法里根是**空串**,不是 `display()` 给人看的那个 `'.'`。
 *
 * `parent` 是渲染层拿去当 files tab 的 rootPath 的,`listWorkspaceDir` 再用它拼每一项的
 * path:`'.'` 是真串,拼出来就是 `./top.md`,而 `checkedPath` 明令拒绝 `.` 段 —— 那棵树
 * 列得出来、每一个文件却都打不开。根**直属的每一个文件**都会走到这条路径上。
 */
it('roots a top-level file at the workspace root, not at "."', async () => {
  const result = await revealWorkspaceDocument({ workspaceId: 'workspace', path: 'top.md' })
  expect(result).toEqual({ remote: true, path: 'top.md', parent: '', name: 'top.md' })
})

/**
 * ★ 目录扎在**父目录**上并选中它自己,和本机 `showItemInFolder` 一致。
 * 原先目录扎在自己身上,`selectedPath` 恰好等于树根 —— 树根永远不是树里的一行,
 * 于是对任何目录点「在文件管理器中显示」都没有任何可见效果。
 */
it('selects a revealed directory inside its parent', async () => {
  const result = await revealWorkspaceDocument({ workspaceId: 'workspace', path: 'src' })
  expect(result).toEqual({ remote: true, path: 'src', parent: '', name: 'src' })
})

/** 根自己没有「在树里选中」这一说 —— 扎在根上,不选中任何一行,但仍要把树开出来 */
it('reveals the workspace root itself without selecting a row', async () => {
  const result = await revealWorkspaceDocument({ workspaceId: 'workspace', path: '' })
  expect(result).toMatchObject({ remote: true, path: '', parent: '' })
})

/**
 * ★ 远端 stat 抛的是裸 ENOENT。不归一化的话渲染层的 `workspaceFileErrorKey` 认不出来,
 * 一律落到 `document.error.io`「读写失败」—— 文件不在了却提示读写失败,用户会去查网络。
 */
it('normalizes a missing remote path into not-found', async () => {
  await expect(revealWorkspaceDocument({ workspaceId: 'workspace', path: 'src/gone.ts' }))
    .rejects.toThrow('workspace_file:not-found')
})

/**
 * ★ 迟到的返回不开 tab。几次 await 期间工作区可能已经重连,此时算出来的 `parent`
 * 属于**上一个**环境的根;渲染层照开不误,用户会得到一棵扎在陈旧路径上的树。
 * `assertReady()` 只保证手里这个环境对象自己还活着,不保证它还是当前环境。
 */
it('refuses to hand back a tree root when the environment reconnected mid-flight', async () => {
  const original = environment.fs.stat
  environment.fs.stat = async (path: string) => {
    // 复刻重连:generation 变了,getWorkspaceEnvironment 从此返回另一个环境
    environment = { ...remoteEnvironment(), key: 'server-a:2' }
    return original(path)
  }
  await expect(revealWorkspaceDocument({ workspaceId: 'workspace', path: 'src/a.ts' }))
    .rejects.toThrow('environment:conflict')
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
