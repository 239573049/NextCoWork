import { beforeEach, describe, expect, it, vi } from 'vitest'

const persisted = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../../state/store', () => ({
  store: {
    getKv: vi.fn((key: string, fallback: unknown) => persisted.get(key) ?? fallback),
    setKv: vi.fn((key: string, value: unknown) => persisted.set(key, value))
  }
}))

import { BrowserManager } from '../manager'

beforeEach(() => persisted.clear())

describe('BrowserManager · workspace and run isolation', () => {
  it('标签只出现在所属工作区的目录里', () => {
    const manager = new BrowserManager()
    const a = manager.open({ workspaceId: 'workspace-a', source: 'user', url: 'https://a.example.com' })
    const b = manager.open({ workspaceId: 'workspace-b', source: 'user', url: 'https://b.example.com' })

    expect(manager.list('workspace-a').map((tab) => tab.id)).toEqual([a.id])
    expect(manager.list('workspace-b').map((tab) => tab.id)).toEqual([b.id])
  })

  it('Agent 必须同时匹配工作区和 run 才能导航或关闭标签', () => {
    const manager = new BrowserManager()
    const tab = manager.open({
      workspaceId: 'workspace-a',
      source: 'agent',
      ownerRunId: 'run-a',
      url: 'https://example.com'
    })

    expect(() => manager.navigate(tab.id, 'https://example.org', {
      workspaceId: 'workspace-b',
      runId: 'run-a'
    })).toThrow('当前 Agent')
    expect(() => manager.close(tab.id, {
      workspaceId: 'workspace-a',
      runId: 'run-b'
    })).toThrow('当前 Agent')

    expect(manager.navigate(tab.id, 'https://example.org', {
      workspaceId: 'workspace-a',
      runId: 'run-a'
    }).url).toBe('https://example.org/')
    manager.close(tab.id, { workspaceId: 'workspace-a', runId: 'run-a' })
    expect(manager.list('workspace-a')).toEqual([])
  })

  it('用户标签用 clientTabId 幂等注册，避免事件与 invoke 竞态产生副本', () => {
    const manager = new BrowserManager()
    const first = manager.open({
      workspaceId: 'workspace-a',
      source: 'user',
      clientTabId: 'renderer-tab-1',
      url: 'https://example.com'
    })
    const second = manager.open({
      workspaceId: 'workspace-a',
      source: 'user',
      clientTabId: 'renderer-tab-1',
      url: 'https://example.com'
    })

    expect(second.id).toBe(first.id)
    expect(manager.list('workspace-a')).toHaveLength(1)
  })
})

describe('BrowserManager · Profiles', () => {
  it('总会提供不可删除的默认浏览器', () => {
    const manager = new BrowserManager()
    const profile = manager.listProfiles()[0]

    expect(profile).toMatchObject({ id: 'default', isDefault: true })
    expect(() => manager.deleteProfile('default')).toThrow('默认浏览器不能删除')
  })

  it('自定义 Profile 可删除，并关闭所有工作区中使用它的标签', () => {
    const manager = new BrowserManager()
    const profile = manager.createProfile('Store A', ['EXAMPLE.COM', 'example.com'])
    manager.open({
      workspaceId: 'workspace-a',
      source: 'user',
      profileId: profile.id,
      url: 'https://example.com'
    })
    manager.open({
      workspaceId: 'workspace-b',
      source: 'user',
      profileId: profile.id,
      url: 'https://example.org'
    })

    expect(profile.domains).toEqual(['example.com'])
    manager.deleteProfile(profile.id)

    expect(manager.listProfiles().map((item) => item.id)).toEqual(['default'])
    expect(manager.list('workspace-a')).toEqual([])
    expect(manager.list('workspace-b')).toEqual([])
  })
})
