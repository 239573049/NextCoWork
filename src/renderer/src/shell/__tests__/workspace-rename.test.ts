/**
 * 外层工作区标签改名 —— 乐观更新与回滚。
 *
 * ★ 这里值得写用例的**只有失败那条**:成功路径肉眼就能验(名字变了),
 * 而失败时「乐观值没退回去」的表现是**标签上挂着一个磁盘上并不存在的名字**,
 * 一直挂到下一次广播或重载为止 —— 用户会以为改成功了。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/app', () => ({ updateWorkspace: vi.fn() }))
vi.mock('../../services/sessions', () => ({ renameSession: vi.fn() }))
vi.mock('../../services/workspace-files', () => ({
  mutateWorkspaceFile: vi.fn(),
  workspaceFileErrorKey: vi.fn(() => 'files.manage.failed')
}))

import type { Workspace } from '../../../../shared/domain/workspace'
import { updateWorkspace } from '../../services/app'
import { useWindowStore } from '../../stores/window'
import { submitWorkspaceRename } from '../tab-rename-actions'

const update = vi.mocked(updateWorkspace)
const windowInitial = useWindowStore.getState()

// 这几条用例只碰 name,其余字段给最小值即可
function workspace(name: string): Workspace {
  return { id: 'w1', name, rootPath: '/tmp/w1' } as Workspace
}

function nameOf(): string | undefined {
  return useWindowStore.getState().workspaceTargets['w1']?.name
}

beforeEach(() => {
  update.mockReset()
  useWindowStore.setState({ ...windowInitial, workspaceTargets: { w1: workspace('旧名字') } }, true)
})

describe('submitWorkspaceRename', () => {
  it('成功时先乐观改、再用主进程返回的真值覆盖', async () => {
    let seen: string | undefined
    update.mockImplementation(async (req) => {
      // IPC 还在飞的这一刻,界面上就已经是新名字了 —— 这就是乐观更新的全部目的
      seen = nameOf()
      return workspace(req.name ?? '')
    })
    await expect(submitWorkspaceRename('w1', '新名字')).resolves.toBe(true)
    expect(seen).toBe('新名字')
    expect(nameOf()).toBe('新名字')
  })

  it('★ 失败时把旧名字放回去 —— 不能等下一次广播,那条广播根本不会来', async () => {
    update.mockRejectedValueOnce(new Error('nope'))
    await expect(submitWorkspaceRename('w1', '新名字')).resolves.toBe(false)
    expect(nameOf()).toBe('旧名字')
  })

  it('空白、同名、以及不存在的工作区都不发 IPC', async () => {
    await expect(submitWorkspaceRename('w1', '   ')).resolves.toBe(false)
    await expect(submitWorkspaceRename('w1', '旧名字')).resolves.toBe(false)
    await expect(submitWorkspaceRename('缺席', 'x')).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('两侧空白会被裁掉 —— 不然文件树里会出现一个看不见的前缀', async () => {
    update.mockImplementation(async (req) => workspace(req.name ?? ''))
    await submitWorkspaceRename('w1', '  带空白  ')
    expect(update.mock.calls[0]?.[0]).toMatchObject({ id: 'w1', name: '带空白' })
  })
})
