/**
 * 「结果未知」这条码必须**完整穿过**主进程的错误归一化,一直到渲染层。
 *
 * ★ 渲染层靠 `environmentCode === 'result-unknown'` 决定要不要重读服务器
 * (见 `services/workspace-files.ts` 的 `isResultUnknown`)。这条链上有两处很容易把它
 * 压平:`remoteFileFailure` 按 errno 分类,`translateError` 兜底成 `workspace_file:io`。
 * 一旦压平,渲染层就再也认不出「操作可能已经生效了」,文件树会安静地一直显示旧状态 ——
 * 没有任何报错,只是内容是假的。所以这里钉一根哨兵。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EnvironmentError } from '../../../shared/domain/environment'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'

const mocks = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn(), trashItem: vi.fn() } }))
vi.mock('../../state/store', () => ({
  store: {
    getWorkspace: (id: string) =>
      id === 'workspace'
        ? { rootPath: mocks.root, environment: { kind: 'connection', connectionId: 'server-a' } }
        : undefined
  }
}))
vi.mock('../../runtime', () => ({ getWorkspaceEnvironment: () => environment }))

import { mutateWorkspaceDocument } from '../workspace-files'
import { toAgentError } from '../errors'

let temporary = ''
let environment: ReturnType<typeof remoteEnvironment>

function remoteEnvironment() {
  return { ...localEnvironment(nodeHost(), mocks.root), remote: true, key: 'server-a:1', description: 'server-a' }
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'ncw-unknown-'))
  mocks.root = join(temporary, 'workspace')
  mkdirSync(mocks.root, { recursive: true })
  writeFileSync(join(mocks.root, 'a.ts'), '')
  environment = remoteEnvironment()
})

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true })
})

it('keeps result-unknown identifiable after a remote rename loses the connection', async () => {
  // 复刻断线:rename 的请求已经发出去了,连接在收到回应之前断掉
  environment.fs.rename = async (): Promise<void> => { throw new EnvironmentError('result-unknown') }
  try {
    await mutateWorkspaceDocument({ workspaceId: 'workspace', path: 'a.ts', operation: 'rename', destination: 'b.ts' })
    throw new Error('Expected the rename to fail')
  } catch (error) {
    expect(toAgentError(error)).toMatchObject({
      environmentCode: 'result-unknown', messageKey: 'environment.error.result-unknown'
    })
  }
})

/** 反面:普通的 errno 仍旧归一化成文件错误码,不能人人都成「结果未知」 */
it('still flattens an ordinary errno into a workspace file code', async () => {
  environment.fs.rename = async (): Promise<void> => { throw Object.assign(new Error('nope'), { code: 'EACCES' }) }
  try {
    await mutateWorkspaceDocument({ workspaceId: 'workspace', path: 'a.ts', operation: 'rename', destination: 'b.ts' })
    throw new Error('Expected the rename to fail')
  } catch (error) {
    const agent = toAgentError(error)
    expect(agent.environmentCode).toBeUndefined()
    expect(agent.message).toBe('workspace_file:permission')
  }
})
