/**
 * 设置浮层的开关状态 —— 三条不变量,每一条都对应一个具体会发生的退化:
 *
 * 1. **它永远不落盘。** 现在靠「`persist()` 只在 Tab 增删改移里调用」自动成立,
 *    但那是碰巧对的。哪天有人给 store 套 persist 中间件、或在 `set()` 后面补一句
 *    `persist(...)`,用户就会遇到「上次退出时开着设置,这次启动它自己弹出来」。
 * 2. **`openFeature('settings')` 不建 Tab。** `FeatureKind` 里有 `'settings'`,
 *    类型允许调用,而建出 Tab 就等于有了第二个设置入口(AppShell 文件头禁止的)。
 * 3. **持久化数据里的 settings 功能 Tab 会被 hydrate 过滤掉。**
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bootstrap } from '../../../../shared/domain/bootstrap'
import { DEFAULT_SETTINGS } from '../../../../shared/domain/settings'
import type { OuterTab } from '../../../../shared/domain/tab'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../../shared/domain/workspace'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

import { persistOuterTabs } from '../../services/app'
import { useWindowStore } from '../window'

const mockPersistOuter = vi.mocked(persistOuterTabs)
const windowInitial = useWindowStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useWindowStore.setState(windowInitial, true)
})

const boot = (outer: OuterTab[]): Bootstrap => ({
  windowKind: 'main',
  settings: DEFAULT_SETTINGS,
  resolvedTheme: 'dark',
  workspaces: [],
  tabState: { outer, activeOuterId: outer[0]?.id ?? null },
  activeRuns: [],
  versions: { app: '0.0.0', electron: '44.1.1', chrome: '152', node: '24.19.0' }
})

describe('设置浮层的开关状态', () => {
  it('初始是关着的', () => {
    expect(useWindowStore.getState().settingsPage).toBeNull()
  })

  it('openSettings 带页码时停在那一页,不带时给默认页', () => {
    useWindowStore.getState().openSettings('model')
    expect(useWindowStore.getState().settingsPage).toBe('model')

    useWindowStore.getState().closeSettings()
    useWindowStore.getState().openSettings()
    expect(useWindowStore.getState().settingsPage).toBe('general')
  })

  it('已经开着时再次不带页码打开,停在原地', () => {
    useWindowStore.getState().openSettings('data')
    useWindowStore.getState().openSettings()
    expect(useWindowStore.getState().settingsPage).toBe('data')
  })

  it('★ 开关设置一次都不落盘', () => {
    useWindowStore.getState().openSettings('about')
    useWindowStore.getState().closeSettings()
    expect(mockPersistOuter).not.toHaveBeenCalled()
  })

  it('开关设置不动外层 Tab', () => {
    const before = useWindowStore.getState().outer
    useWindowStore.getState().openSettings('about')
    expect(useWindowStore.getState().outer).toBe(before)
  })

  it("openFeature('settings') 改开浮层,不建 Tab、不落盘", () => {
    useWindowStore.getState().openFeature('settings')
    expect(useWindowStore.getState().settingsPage).toBe('general')
    expect(useWindowStore.getState().outer).toHaveLength(0)
    expect(mockPersistOuter).not.toHaveBeenCalled()
  })

  it('定时任务使用独立主内容模式', () => {
    useWindowStore.getState().openFeature('scheduled')
    expect(useWindowStore.getState().activeStandaloneFeature).toBe('scheduled')
    expect(useWindowStore.getState().outer).toHaveLength(0)
    expect(useWindowStore.getState().settingsPage).toBeNull()
  })

  it('hydrate 过滤掉持久化数据里的 settings 功能 Tab', () => {
    useWindowStore.getState().hydrate(
      boot([
        { id: 't1', kind: 'feature', ref: { feature: 'settings' } },
        { id: 't2', kind: 'feature', ref: { feature: 'scheduled' } }
      ])
    )
    const outer = useWindowStore.getState().outer
    expect(outer).toEqual([])
    expect(useWindowStore.getState().settingsPage).toBeNull()
  })

  it('关掉工作区 Tab 不影响设置浮层', () => {
    useWindowStore.getState().updateWorkspaces([{ id: 'ws-1', name: 'local', rootPath: '/tmp/ws-1', settings: DEFAULT_WORKSPACE_SETTINGS, createdAt: 1, lastOpenedAt: 1 }])
    useWindowStore.getState().openWorkspace('ws-1')
    useWindowStore.getState().openSettings('data')
    const id = useWindowStore.getState().outer[0]!.id
    useWindowStore.getState().close(id)
    expect(useWindowStore.getState().settingsPage).toBe('data')
  })
})
