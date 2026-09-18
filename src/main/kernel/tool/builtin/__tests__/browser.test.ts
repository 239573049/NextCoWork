import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../../../shared/domain/workspace'
import { browserManager } from '../../../../browser/manager'
import {
  installBrowserAutomationBridge,
  type BrowserAutomationBridge,
  type BrowserPageSnapshot
} from '../../../../browser/runtime'
import { store } from '../../../../state/store'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { browserClickTool, browserScreenshotTool, browserSnapshotTool } from '../browser'

const opened: string[] = []
let snapshot: BrowserPageSnapshot
let bridge: BrowserAutomationBridge

beforeEach(() => {
  vi.spyOn(store, 'getWorkspace').mockReturnValue({
    id: 'workspace-a',
    name: 'local',
    rootPath: '/tmp/workspace-a',
    environment: { kind: 'local' },
    settings: DEFAULT_WORKSPACE_SETTINGS,
    createdAt: 1,
    lastOpenedAt: 1
  })
  snapshot = {
    tree: '- heading "Example" [ref=e1]\n- button "Continue" [ref=e2]',
    title: 'Example',
    url: 'https://example.com/',
    snapshotId: 'snapshot-1',
    viewport: { width: 1280, height: 720 },
    truncated: false
  }
  bridge = {
    bindIab: vi.fn(async () => ({ width: 1280, height: 720 })),
    openHeadless: vi.fn(async () => ({ width: 1280, height: 720 })),
    waitFor: vi.fn(async () => undefined),
    info: vi.fn(() => ({ bound: true, backend: 'iab' as const, viewport: { width: 1280, height: 720 } })),
    navigate: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => snapshot),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    cuaClick: vi.fn(async () => undefined),
    cuaDrag: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png' as const,
      width: 1280,
      height: 720,
      viewport: { width: 1280, height: 720 }
    })),
    release: vi.fn(async () => undefined),
    clearProfile: vi.fn(async () => undefined),
    reconcile: vi.fn(),
    setCuaListener: vi.fn(),
    shutdown: vi.fn(async () => undefined)
  }
  installBrowserAutomationBridge(bridge)
})

afterEach(() => {
  installBrowserAutomationBridge(null)
  for (const id of opened.splice(0)) {
    if (browserManager.get(id) !== undefined) browserManager.close(id)
  }
  vi.restoreAllMocks()
})

function openAgentTab(runId = 'run-a') {
  const tab = browserManager.open({
    workspaceId: 'workspace-a',
    source: 'agent',
    ownerRunId: runId,
    profileId: 'default',
    url: 'https://example.com/'
  })
  opened.push(tab.id)
  return tab
}

function ctx(runId = 'run-a'): ToolContext {
  return {
    workspaceId: 'workspace-a',
    workspaceRoot: '/tmp/workspace-a',
    signal: new AbortController().signal,
    permissionMode: 'full',
    depth: 0,
    callId: 'call-1',
    runId,
    host: nodeHost(),
    emit: () => undefined
  }
}

describe('live browser tools', () => {
  it('从已绑定页面返回带 ref 的真实快照', async () => {
    const tab = openAgentTab()

    const result = await browserSnapshotTool.execute({ tabId: tab.id }, ctx())

    expect(result.isError).toBe(false)
    expect(result.output.content).toContain('Page: Example')
    expect(result.output.content).toContain('[ref=e2]')
    expect(bridge.snapshot).toHaveBeenCalledWith(tab.id)
  })

  it('把 ref 点击委托给同一页面并拒绝另一个 run', async () => {
    const tab = openAgentTab()

    const accepted = await browserClickTool.execute({ tabId: tab.id, ref: 'e2' }, ctx())
    const rejected = await browserClickTool.execute({ tabId: tab.id, ref: 'e2' }, ctx('run-b'))

    expect(accepted.isError).toBe(false)
    expect(bridge.click).toHaveBeenCalledWith(tab.id, 'e2', {})
    expect(rejected.isError).toBe(true)
    expect(rejected.output.content).toContain('opened or claimed')
  })

  it('把截图作为模型可见的图片结果返回', async () => {
    const tab = openAgentTab()

    const result = await browserScreenshotTool.execute({ tabId: tab.id }, ctx())

    expect(result.isError).toBe(false)
    expect(result.output.images).toEqual([{
      mime: 'image/png',
      dataRef: 'data:image/png;base64,AQID'
    }])
  })
})
