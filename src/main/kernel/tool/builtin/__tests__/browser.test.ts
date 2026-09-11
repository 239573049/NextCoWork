import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../../../shared/domain/workspace'
import { store } from '../../../../state/store'
import { browserPartition } from '../../../../../shared/domain/browser'
import { browserManager } from '../../../../browser/manager'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { browserSnapshotTool } from '../browser'

vi.mock('node:dns', () => ({
  promises: {
    lookup: (): Promise<Array<{ address: string }>> =>
      Promise.resolve([{ address: '93.184.216.34' }])
  }
}))

const opened: string[] = []

beforeEach(() => {
  vi.spyOn(store, 'getWorkspace').mockReturnValue({ id: 'workspace-a', name: 'local', rootPath: '/tmp/workspace-a', environment: { kind: 'local' }, settings: DEFAULT_WORKSPACE_SETTINGS, createdAt: 1, lastOpenedAt: 1 })
})

afterEach(() => {
  for (const id of opened.splice(0)) {
    if (browserManager.get(id) !== undefined) browserManager.close(id)
  }
  vi.restoreAllMocks()
})

function openAgentTab(url = 'https://example.com/') {
  const tab = browserManager.open({
    workspaceId: 'workspace-a',
    source: 'agent',
    ownerRunId: 'run-a',
    profileId: 'default',
    url
  })
  opened.push(tab.id)
  return tab
}

function ctx(browserFetch: NonNullable<ToolContext['host']['browserFetch']>): ToolContext {
  return {
    workspaceId: 'workspace-a',
    workspaceRoot: '/tmp/workspace-a',
    signal: new AbortController().signal,
    permissionMode: 'full',
    depth: 0,
    callId: 'call-1',
    runId: 'run-a',
    host: nodeHost({
      fetch: vi.fn(() => Promise.reject(new Error('default fetch must not be used'))),
      browserFetch
    }),
    emit: () => undefined
  }
}

describe('browser_snapshot', () => {
  it('通过工作区/Profile 对应的隔离会话读取页面', async () => {
    const tab = openAgentTab()
    const browserFetch = vi.fn(async () => new Response('<title>Example</title><p>Hello</p>', {
      headers: { 'content-type': 'text/html' }
    }))

    const result = await browserSnapshotTool.execute({ tabId: tab.id }, ctx(browserFetch))

    expect(result.isError).toBe(false)
    expect(result.output.content).toContain('Hello')
    expect(browserFetch).toHaveBeenCalledWith(
      browserPartition('workspace-a', 'default'),
      'https://example.com/',
      expect.objectContaining({ redirect: 'manual', credentials: 'include' })
    )
  })

  it('每一跳重定向都重新经过 SSRF 筛查', async () => {
    const tab = openAgentTab()
    const browserFetch = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/private', 'content-type': 'text/html' }
    }))

    const result = await browserSnapshotTool.execute({ tabId: tab.id }, ctx(browserFetch))

    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('private-network')
    expect(browserFetch).toHaveBeenCalledTimes(1)
  })

  it('在下载正文前拒绝声明过大的页面', async () => {
    const tab = openAgentTab()
    const browserFetch = vi.fn(async () => new Response('ignored', {
      headers: {
        'content-type': 'text/plain',
        'content-length': '1000001'
      }
    }))

    const result = await browserSnapshotTool.execute({ tabId: tab.id }, ctx(browserFetch))

    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('larger than 1000000 bytes')
  })
})
