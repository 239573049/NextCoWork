/**
 * 改名 / 移动之后,标签跟着走。
 *
 * ★ 这里真正要钉住的是**非 `path` 字段不能在同步路径时被冲掉**。曾经的写法是
 * `ref: { path }` —— 整个替换,于是 `custom` 标签的 `pluginId` / `viewType`
 * 一改名就没了,插件编辑器当场降级成「提供它的插件已被禁用、卸载或装载失败」,
 * 而文件和插件其实都好好的。末尾那个 `as InnerTab` 断言让这个类型错误
 * 一声不响地编译过去了,所以**只有用例能拦住它**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTab } from '../../../../shared/domain/tab'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

vi.mock('../../services/browser', () => ({ closeBrowserTab: vi.fn(async () => undefined) }))
vi.mock('../../services/terminal', () => ({ killTerminal: vi.fn(async () => undefined) }))

import { useTabsStore } from '../tabs'
import { useWindowStore } from '../window'

const tabsInitial = useTabsStore.getState()
const windowInitial = useWindowStore.getState()
const workspaceId = 'workspace-apply-mutation'

const chat: InnerTab = { id: 'chat', kind: 'chat', pane: 'main', title: 'Chat', ref: { sessionId: null } }

const drawing: InnerTab = {
  id: 'drawing',
  kind: 'custom',
  pane: 'main',
  title: '1.excalidraw',
  ref: { path: '1.excalidraw', pluginId: 'acme.excalidraw', viewType: 'excalidraw.canvas' }
}

const tree: InnerTab = {
  id: 'tree',
  kind: 'files',
  pane: 'right',
  title: 'notes',
  ref: { path: 'notes', selectedPath: 'notes/a.md' }
}

function tabById(id: string): InnerTab | undefined {
  return useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.id === id)
}

beforeEach(() => {
  useTabsStore.setState(tabsInitial, true)
  useWindowStore.setState(windowInitial, true)
  useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, drawing, tree], activeTabId: chat.id })
})

describe('applyFileMutation · rename', () => {
  it('★ 改名保住 custom 标签的 pluginId / viewType —— 丢了就降级成「插件不在了」', () => {
    useTabsStore.getState().applyFileMutation({
      workspaceId,
      operation: 'rename',
      path: '1.excalidraw',
      destination: '2.excalidraw'
    })

    const tab = tabById('drawing')
    expect(tab?.ref).toEqual({
      path: '2.excalidraw',
      pluginId: 'acme.excalidraw',
      viewType: 'excalidraw.canvas'
    })
    expect(tab?.title).toBe('2.excalidraw')
  })

  it('files 标签的 selectedPath 同样不该被冲掉', () => {
    useTabsStore.getState().applyFileMutation({
      workspaceId,
      operation: 'rename',
      path: 'notes',
      destination: 'journal'
    })

    // 子树根跟着改,而「当前选中哪一个」是另一件事,不该被改名顺手清掉
    expect(tabById('tree')?.ref).toMatchObject({ path: 'journal', selectedPath: 'notes/a.md' })
  })

  it('路径对不上的标签一个字都不动(连引用都不换)', () => {
    const before = tabById('drawing')
    useTabsStore.getState().applyFileMutation({
      workspaceId,
      operation: 'rename',
      path: '别的文件.md',
      destination: '还是别的.md'
    })
    expect(tabById('drawing')).toBe(before)
  })
})
