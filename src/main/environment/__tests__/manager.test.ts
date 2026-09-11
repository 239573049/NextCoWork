import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../../../shared/domain/environment'
import type { Workspace } from '../../../shared/domain/workspace'
import { nodeHost } from '../../kernel/host'
import type { EnvironmentConnection, WorkspaceEnvironment } from '../contract'
import { createWorkspacePaths } from '../paths'
import { EnvironmentManager } from '../manager'

function fixture() {
  const workspaces = new Map<string, Workspace>(['alpha', 'beta'].map((id) => [id, {
    id, name: id, rootPath: '/same/path', environment: { kind: 'connection', connectionId: id }, lastOpenedAt: 0
  } as Workspace]))
  const profiles = new Map<string, ConnectionProfile>(['alpha', 'beta'].map((id) => [id, {
    id, name: id, kind: 'ssh', target: { kind: 'config', host: id }, platform: 'auto', enabled: true,
    revision: 1, createdAt: 0, updatedAt: 0
  }]))
  const local = vi.fn((): WorkspaceEnvironment => { throw new Error('Must not touch local filesystem') })
  const unused = async (): Promise<never> => { throw new Error('Unexpected test operation') }
  const connect = vi.fn(async (profile: ConnectionProfile, context: Parameters<ConstructorParameters<typeof EnvironmentManager>[0]['connect']>[1]): Promise<EnvironmentConnection> => {
    const fs = { ...nodeHost().fs, realpath: async (path: string) => path,
      stat: async () => ({ isDir: true, isFile: false, isSymbolicLink: false, size: 0, mode: 0o755, mtimeMs: 0 }),
      readFile: async () => { context.assertCurrent(); return profile.id }, lstat: unused,
      readBytes: unused, writeBytes: unused, copyFile: unused, mkdir: unused, rename: unused, unlink: unused, rmdir: unused }
    return { key: profile.id, generation: context.generation, remote: true, description: profile.id, fs,
      platform: { os: 'linux', shell: '/bin/sh', osVersion: 'test' }, path: createWorkspacePaths(fs, 'linux'),
      assertReady: context.assertCurrent, close: async () => {}, spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      facts: { os: 'linux', shell: '/bin/sh', osVersion: 'test', home: '/home', hostname: profile.id, username: 'user' },
      openProcess: unused, openTerminal: unused
    }
  })
  const manager = new EnvironmentManager({ workspace: (id) => workspaces.get(id), profile: (id) => profiles.get(id), local, connect })
  const context = { senderId: 1, signal: new AbortController().signal }
  return { manager, context, workspaces, profiles, local, connect }
}

describe('workspace environment manager', () => {
  it('keeps identical paths on two servers isolated across active runs', async () => {
    const { manager, context, local } = fixture()
    await manager.prepare('alpha', context)
    const lease = manager.acquire('alpha')
    await manager.prepare('beta', context)
    expect(await lease.environment.fs.readFile('/same/path/file')).toBe('alpha')
    expect(await manager.get('beta').fs.readFile('/same/path/file')).toBe('beta')
    expect(local).not.toHaveBeenCalled()
    lease.release()
    lease.release()
    await manager.shutdown()
  })
  it('requires an explicit connection and never falls back for broken bindings', async () => {
    const { manager, context, workspaces, local } = fixture()
    expect(() => manager.get('alpha')).toThrow('disconnected')
    workspaces.set('alpha', { ...workspaces.get('alpha')!, environment: { kind: 'connection', connectionId: 'missing' } })
    await expect(manager.prepare('alpha', context)).rejects.toThrow('unbound')
    expect(local).not.toHaveBeenCalled()
  })
  it('invalidates old leases on a profile revision change', async () => {
    const { manager, context, profiles } = fixture()
    await manager.prepare('alpha', context)
    const old = manager.acquire('alpha')
    profiles.set('alpha', { ...profiles.get('alpha')!, revision: 2 })
    await expect(old.environment.fs.readFile('/same/path/file')).rejects.toThrow('disconnected')
    await manager.prepare('alpha', context)
    expect(manager.get('alpha').generation).not.toBe(old.environment.generation)
    await expect(old.environment.fs.readFile('/same/path/file')).rejects.toThrow('disconnected')
    await manager.shutdown()
  })
  it('shares a single connection attempt without sharing workspace roots', async () => {
    const { manager, context, connect, workspaces } = fixture()
    workspaces.set('beta', { ...workspaces.get('beta')!, rootPath: '/another', environment: { kind: 'connection', connectionId: 'alpha' } })
    const [alpha, beta] = await Promise.all([manager.prepare('alpha', context), manager.prepare('beta', context)])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(alpha.rootPath).toBe('/same/path')
    expect(beta.rootPath).toBe('/another')
    await manager.shutdown()
  })
  it('retains a fixed generation for children and reclaims only unreferenced connections', async () => {
    vi.useFakeTimers()
    const { manager, context } = fixture()
    try {
      await manager.prepare('alpha', context)
      const parent = manager.acquire('alpha')
      const child = manager.retain(parent.environment)
      parent.release()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(manager.get('alpha').key).toBe(child.environment.key)
      child.release()
      child.release()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(() => manager.get('alpha')).toThrow('disconnected')
      expect(() => manager.retain(parent.environment)).toThrow('disconnected')
    } finally { await manager.shutdown(); vi.useRealTimers() }
  })
})