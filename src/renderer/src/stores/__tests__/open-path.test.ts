import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InnerTab } from '../../../../shared/domain/tab'

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

vi.mock('../../services/browser', () => ({
  closeBrowserTab: vi.fn(async () => undefined)
}))

vi.mock('../../services/terminal', () => ({
  killTerminal: vi.fn(async () => undefined)
}))

import { useTabsStore } from '../tabs'
import { useWindowStore } from '../window'
import { usePluginsStore } from '../plugins'
import type { InstalledPlugin } from '../../../../shared/plugin/state'

const tabsInitial = useTabsStore.getState()
const windowInitial = useWindowStore.getState()
const workspaceId = 'workspace-open-path'

const chat: InnerTab = {
  id: 'chat',
  kind: 'chat',
  pane: 'main',
  title: 'Chat',
  ref: { sessionId: null }
}

beforeEach(() => {
  useTabsStore.setState(tabsInitial, true)
  useWindowStore.setState(windowInitial, true)
  useWindowStore.setState({ activeWorkspaceId: workspaceId, rightPanelOpen: false })
  useTabsStore.getState().hydrate(workspaceId, { tabs: [chat], activeTabId: chat.id })
})

describe('openPath', () => {
  it('opens a file in the workspace right panel and reveals it', () => {
    useTabsStore.getState().openPath(workspaceId, 'doc', 'src/index.ts', 'index.ts')

    const state = useTabsStore.getState().stateOf(workspaceId)
    const doc = state.tabs.find((tab) => tab.kind === 'doc')
    expect(doc?.pane).toBe('right')
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toContainEqual(doc)
    expect(useWindowStore.getState().rightPanelOpen).toBe(true)
    expect(useWindowStore.getState().rightPanelOpenByWorkspace[workspaceId]).toBe(true)
  })

  it('reuses an already open right panel file instead of adding a duplicate', () => {
    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')
    const first = useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.kind === 'doc')!
    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')

    const docs = useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')
    expect(docs).toHaveLength(1)
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toEqual([first])
    expect(first.pane).toBe('right')
  })

  it('moves a legacy main-pane file into the right panel when reopened', () => {
    const legacyDoc: InnerTab = {
      id: 'legacy-doc',
      kind: 'doc',
      pane: 'main',
      title: 'README.md',
      ref: { path: 'README.md' }
    }
    useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, legacyDoc], activeTabId: chat.id })

    useTabsStore.getState().openPath(workspaceId, 'doc', 'README.md', 'README.md')

    const docs = useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')
    expect(docs).toHaveLength(1)
    expect(docs[0]?.pane).toBe('right')
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toEqual(docs)
  })

  it('keeps at least one chat in the main pane when moving or closing tabs', () => {
    const files: InnerTab = {
      id: 'files',
      kind: 'files',
      pane: 'right',
      title: 'Files',
      ref: { path: '' }
    }
    useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, files], activeTabId: chat.id, rightActiveTabId: files.id })
    const dock = useTabsStore.getState().dockOf(workspaceId)
    const mainGroup = dock.root.type === 'split' && dock.root.first.type === 'group' ? dock.root.first.id : null
    const rightGroup = dock.root.type === 'split' && dock.root.second.type === 'group' ? dock.root.second.id : null
    expect(mainGroup).not.toBeNull()
    expect(rightGroup).not.toBeNull()

    useTabsStore.getState().moveDockTab(workspaceId, chat.id, mainGroup!, rightGroup!)
    useTabsStore.getState().closeDockTab(workspaceId, mainGroup!, chat.id)

    expect(useTabsStore.getState().tabsOf(workspaceId, 'main')).toEqual([chat])
  })

  it('repairs a persisted layout whose chats are all in the right panel', () => {
    const rightChat: InnerTab = { ...chat, id: 'right-chat', pane: 'right' }
    const files: InnerTab = {
      id: 'files', kind: 'files', pane: 'right', title: 'Files', ref: { path: '' }
    }
    useTabsStore.getState().hydrate(workspaceId, {
      tabs: [rightChat, files], activeTabId: rightChat.id, rightActiveTabId: rightChat.id
    })

    expect(useTabsStore.getState().tabsOf(workspaceId, 'main')).toContainEqual(expect.objectContaining({ id: rightChat.id, pane: 'main' }))
    expect(useTabsStore.getState().tabsOf(workspaceId, 'right')).toContainEqual(files)
  })
})

/**
 * 「谁来打开这个文件」—— `openFile` 的分派。
 *
 * ★ 这条路以前根本不存在:文件树、Markdown 里的链接、对话里的文件引用,三处
 * 各自硬编码 `openPath(..., 'doc', ...)`,于是插件清单里声明的
 * `customEditors[].selector[].filenamePattern` 全仓**没有任何一处读过** ——
 * 双击一个 `.excalidraw` 得到的是一屏原始 JSON。
 */
function drawPlugin(over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'acme.excalidraw',
    status: 'active',
    enabled: true,
    scope: 'global',
    path: '/plugins/acme.excalidraw',
    permissions: { required: [], optional: [], granted: [] },
    diagnostics: [],
    unsupported: [],
    installedAt: 0,
    updatedAt: 0,
    statusBar: [],
    manifest: {
      id: 'acme.excalidraw',
      name: 'excalidraw',
      publisher: 'acme',
      displayName: 'Excalidraw',
      description: '',
      version: '1.0.0',
      categories: [],
      keywords: [],
      engines: '^1.0.0',
      main: './dist/extension.js',
      activationEvents: [],
      permissions: [],
      optionalPermissions: [],
      hostPermissions: [],
      allowedCommands: [],
      dependencies: {},
      contributes: {
        commands: [],
        menus: {},
        customEditors: [{
          viewType: 'excalidraw.editor',
          displayName: '%editor%',
          selector: [{ filenamePattern: '*.excalidraw' }]
        }],
        views: [],
        tools: [],
        cardViews: [],
        keybindings: [],
        skills: [],
        themes: [],
        unsupported: []
      }
    },
    ...over
  }
}

function installPlugins(plugins: InstalledPlugin[]): void {
  usePluginsStore.setState({ catalog: { plugins, hostVersion: '1.0.0' } })
}

describe('openFile · 由插件决定用谁打开', () => {
  beforeEach(() => { installPlugins([]) })

  it('没人认领的后缀退回内置 doc', () => {
    useTabsStore.getState().openFile(workspaceId, 'docs/README.md')

    const tabs = useTabsStore.getState().stateOf(workspaceId).tabs
    const opened = tabs.find((tab) => tab.kind !== 'chat')
    expect(opened?.kind).toBe('doc')
    expect(opened?.title).toBe('README.md')
  })

  it('★ 插件认领的后缀开成 custom 标签,并带上插件身份', () => {
    installPlugins([drawPlugin()])

    useTabsStore.getState().openFile(workspaceId, 'drawings/plan.excalidraw')

    const opened = useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.kind === 'custom')
    expect(opened).toBeDefined()
    // 这三样缺一个,`CustomEditorView` 就会降级成只读预览
    expect(opened?.ref).toEqual({
      pluginId: 'acme.excalidraw',
      viewType: 'excalidraw.editor',
      path: 'drawings/plan.excalidraw'
    })
    expect(opened?.title).toBe('plan.excalidraw')
  })

  it('★ 插件被禁用后重开同一个文件,退回 doc 而且**只有一个标签**', () => {
    installPlugins([drawPlugin()])
    useTabsStore.getState().openFile(workspaceId, 'plan.excalidraw')

    installPlugins([drawPlugin({ enabled: false })])
    useTabsStore.getState().openFile(workspaceId, 'plan.excalidraw')

    // 去重只看 path,不看 kind —— 比上 kind 的话这里会留下两个标签,
    // 两个都指着同一个文件,各自 editing 各自的。
    const fileTabs = useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind !== 'chat')
    expect(fileTabs).toHaveLength(1)
  })

  it('装载失败 / 待批准的插件不接管,直接走 doc', () => {
    for (const status of ['error', 'pending-approval'] as const) {
      useTabsStore.getState().hydrate(workspaceId, { tabs: [chat], activeTabId: chat.id })
      installPlugins([drawPlugin({ status })])

      useTabsStore.getState().openFile(workspaceId, 'plan.excalidraw')

      const opened = useTabsStore.getState().stateOf(workspaceId).tabs.find((tab) => tab.kind !== 'chat')
      expect(opened?.kind, status).toBe('doc')
    }
  })

  it('★ 文件树标签不参与按路径去重 —— 它的 ref.path 是目录根,不是文件', () => {
    const files: InnerTab = {
      id: 'files', kind: 'files', pane: 'right', title: 'Files', ref: { path: 'docs' }
    }
    useTabsStore.getState().hydrate(workspaceId, { tabs: [chat, files], activeTabId: chat.id, rightActiveTabId: files.id })

    useTabsStore.getState().openFile(workspaceId, 'docs')

    // 名字撞上了,但那是个目录标签:必须另开,而不是把文件树认成这个文件
    expect(useTabsStore.getState().stateOf(workspaceId).tabs.filter((tab) => tab.kind === 'doc')).toHaveLength(1)
  })
})
