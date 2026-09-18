import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserPartition } from '../../../shared/domain/browser'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../shared/domain/workspace'

const electron = vi.hoisted(() => {
  const contents = new Map<number, unknown>()
  const sessions = new Map<string, object>()
  return {
    contents,
    sessions,
    app: { getPath: vi.fn(() => '/tmp/nextcowork-browser-test') },
    nativeImage: { createFromBuffer: vi.fn() },
    session: {
      fromPartition: vi.fn((partition: string) => {
        const existing = sessions.get(partition)
        if (existing !== undefined) return existing
        const next = { partition }
        sessions.set(partition, next)
        return next
      })
    },
    webContents: { fromId: vi.fn((id: number) => contents.get(id)) }
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  nativeImage: electron.nativeImage,
  session: electron.session,
  webContents: electron.webContents
}))

import { BrowserBindings } from '../bindings'
import { browserManager } from '../manager'
import { store } from '../../state/store'

const opened: string[] = []

function fakeContents(id: number, partition: string) {
  const events = new EventEmitter()
  let attached = false
  const contents = {
    id,
    session: electron.session.fromPartition(partition),
    debugger: {
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      isAttached: vi.fn(() => attached),
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 11 }
        if (method === 'Runtime.evaluate') return {
          result: { value: { width: 1200, height: 700 } }
        }
        return {}
      })
    },
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => 'https://example.com/'),
    getTitle: vi.fn(() => 'Example'),
    loadURL: vi.fn(async () => undefined),
    capturePage: vi.fn(),
    on: events.on.bind(events),
    once: events.once.bind(events),
    emit: events.emit.bind(events)
  }
  electron.contents.set(id, contents)
  return contents
}

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
})

afterEach(() => {
  for (const id of opened.splice(0)) {
    if (browserManager.get(id) !== undefined) browserManager.close(id)
  }
  electron.contents.clear()
  electron.sessions.clear()
  vi.restoreAllMocks()
})

describe('BrowserBindings', () => {
  it('只接受与 workspace/Profile 分区匹配的 webview', async () => {
    const tab = browserManager.open({
      workspaceId: 'workspace-a',
      source: 'user',
      profileId: 'default',
      url: 'https://example.com/'
    })
    opened.push(tab.id)
    fakeContents(7, browserPartition('workspace-a', 'other'))
    const bindings = new BrowserBindings('/tmp/nextcowork-browser-test', console)

    await expect(bindings.bindIab({
      workspaceId: 'workspace-a',
      tabId: tab.id,
      webContentsId: 7
    })).rejects.toThrow('会话分区不匹配')
  })

  it('绑定后记录 viewport，guest 销毁时立即失效', async () => {
    const tab = browserManager.open({
      workspaceId: 'workspace-a',
      source: 'user',
      profileId: 'default',
      url: 'https://example.com/'
    })
    opened.push(tab.id)
    const contents = fakeContents(8, browserPartition('workspace-a', 'default'))
    const bindings = new BrowserBindings('/tmp/nextcowork-browser-test', console)

    await expect(bindings.bindIab({
      workspaceId: 'workspace-a',
      tabId: tab.id,
      webContentsId: 8
    })).resolves.toEqual({ width: 1200, height: 700 })
    expect(bindings.info(tab.id)).toMatchObject({ bound: true, viewport: { width: 1200, height: 700 } })

    contents.emit('destroyed')
    expect(bindings.info(tab.id)).toMatchObject({ bound: false })
  })
})
