import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bootstrap } from '../../../../shared/domain/bootstrap'
import { DEFAULT_SETTINGS } from '../../../../shared/domain/settings'
import type { OuterTab } from '../../../../shared/domain/tab'
import { DEFAULT_WORKSPACE_SETTINGS, type Workspace } from '../../../../shared/domain/workspace'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

import { persistOuterTabs } from '../../services/app'
import { useWindowStore } from '../window'

const initial = useWindowStore.getState()
const mockPersistOuter = vi.mocked(persistOuterTabs)

const workspace = (id = 'workspace-a'): Workspace => ({
  id,
  name: id,
  rootPath: `/tmp/${id}`,
  settings: DEFAULT_WORKSPACE_SETTINGS,
  createdAt: 1,
  lastOpenedAt: 1
})

const workspaceTab = (id = 'outer-a', workspaceId = 'workspace-a'): OuterTab => ({
  id,
  kind: 'workspace',
  ref: { workspaceId }
})

const boot = (outer: OuterTab[], activeOuterId: string | null, workspaces: Workspace[] = [workspace()]): Bootstrap => ({
  windowKind: 'main',
  settings: DEFAULT_SETTINGS,
  resolvedTheme: 'dark',
  workspaces,
  tabState: { outer, activeOuterId },
  activeRuns: [],
  versions: {
    app: '0.0.0',
    electron: '44.1.1',
    chrome: '152',
    node: '24.19.0'
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  useWindowStore.setState(initial, true)
})

describe('browser management navigation', () => {
  it('点击浏览器只切换主内容模式，不新增、激活或持久化外层标签', () => {
    const outer = [workspaceTab()]
    useWindowStore.setState({
      outer,
      activeOuterId: 'outer-a',
      activeWorkspaceId: 'workspace-a'
    })

    useWindowStore.getState().openFeature('browser')

    const state = useWindowStore.getState()
    expect(state.activeStandaloneFeature).toBe('browser')
    expect(state.outer).toBe(outer)
    expect(state.activeOuterId).toBe('outer-a')
    expect(state.activeWorkspaceId).toBe('workspace-a')
    expect(mockPersistOuter).not.toHaveBeenCalled()
  })

  it('关闭浏览器管理页后回到原工作区，不改变标签布局', () => {
    const outer = [workspaceTab()]
    useWindowStore.setState({
      outer,
      activeOuterId: 'outer-a',
      activeWorkspaceId: 'workspace-a',
      activeStandaloneFeature: 'browser'
    })

    useWindowStore.getState().closeStandaloneFeature()

    const state = useWindowStore.getState()
    expect(state.activeStandaloneFeature).toBeNull()
    expect(state.outer).toBe(outer)
    expect(state.activeOuterId).toBe('outer-a')
    expect(state.activeWorkspaceId).toBe('workspace-a')
    expect(mockPersistOuter).not.toHaveBeenCalled()
  })

  it('显式切换工作区时退出浏览器管理模式，并恢复目标工作区的面板状态', () => {
    useWindowStore.setState({
      outer: [workspaceTab(), workspaceTab('outer-b', 'workspace-b')],
      activeOuterId: 'outer-a',
      activeWorkspaceId: 'workspace-a',
      activeStandaloneFeature: 'browser',
      rightPanelOpen: false,
      rightPanelOpenByWorkspace: { 'workspace-b': true }
    })

    useWindowStore.getState().activate('outer-b')

    const state = useWindowStore.getState()
    expect(state.activeStandaloneFeature).toBeNull()
    expect(state.activeOuterId).toBe('outer-b')
    expect(state.activeWorkspaceId).toBe('workspace-b')
    expect(state.rightPanelOpen).toBe(true)
  })

  it('其他功能仍按原行为创建外层标签', () => {
    useWindowStore.getState().openFeature('skills')

    const state = useWindowStore.getState()
    expect(state.activeStandaloneFeature).toBeNull()
    expect(state.outer).toHaveLength(1)
    expect(state.outer[0]).toMatchObject({
      kind: 'feature',
      ref: { feature: 'skills' }
    })
    expect(mockPersistOuter).toHaveBeenCalledTimes(1)
  })
})

describe('browser feature-tab migration', () => {
  it('清理旧浏览器外层标签，并将失效的活动项修复到工作区', () => {
    useWindowStore.getState().hydrate(
      boot(
        [
          workspaceTab(),
          {
            id: 'legacy-browser',
            kind: 'feature',
            ref: { feature: 'browser' }
          }
        ],
        'legacy-browser'
      )
    )

    const state = useWindowStore.getState()
    expect(state.outer.map((tab) => tab.id)).toEqual(['outer-a'])
    expect(state.activeOuterId).toBe('outer-a')
    expect(state.activeWorkspaceId).toBe('workspace-a')
    expect(state.activeStandaloneFeature).toBeNull()
    expect(mockPersistOuter).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        outer: [workspaceTab()],
        activeOuterId: 'outer-a'
      })
    )
  })

  it('旧布局只有浏览器标签时，从最近工作区恢复一个有效工作区标签', () => {
    useWindowStore.getState().hydrate(
      boot(
        [
          {
            id: 'legacy-browser',
            kind: 'feature',
            ref: { feature: 'browser' }
          }
        ],
        'legacy-browser'
      )
    )

    const state = useWindowStore.getState()
    expect(state.outer).toHaveLength(1)
    expect(state.outer[0]).toMatchObject({
      kind: 'workspace',
      ref: { workspaceId: 'workspace-a' }
    })
    expect(state.activeOuterId).toBe(state.outer[0]?.id)
    expect(state.activeWorkspaceId).toBe('workspace-a')
  })
})
