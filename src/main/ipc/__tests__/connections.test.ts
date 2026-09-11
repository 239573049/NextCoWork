import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'
import { createWorkspacePaths } from '../../environment/paths'
import type { WindowContext } from '../../window/registry'
import { cancelConnectionRequest, commitWorkspaceActivation, connectForBrowse, closeBrowse, prepareWorkspace } from '../connections'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), acquire: vi.fn(), retain: vi.fn(), get: vi.fn(), connect: vi.fn(), putWorkspace: vi.fn() }))
vi.mock('electron', () => ({ app: {}, dialog: {} }))
vi.mock('../../runtime', () => ({ getEnvironments: () => ({ ...mocks, status: () => ({ phase: 'ready' }) }), getHost: vi.fn(), installEnvironmentInteraction: vi.fn() }))
vi.mock('../../state/store', () => ({ store: { getWorkspace: (id: string) => ({ id, environment: { kind: 'connection', connectionId: 'server' } }), putWorkspace: mocks.putWorkspace } }))
vi.mock('../../window/registry', () => ({ windows: {} }))

let nextOwner = 0
function fixture() {
  const sender = Object.assign(new EventEmitter(), { id: ++nextOwner })
  const ctx = { id: sender.id, sender } as WindowContext
  const environment = { ...localEnvironment(nodeHost(), '/workspace'), key: 'remote:1', remote: true, close: async () => {} }
  environment.fs.realpath = async (path) => path
  environment.fs.stat = async () => ({ isDir: true, isFile: false, isSymbolicLink: false, mode: 0o755, mtimeMs: 0, size: 0 })
  environment.fs.readDir = async () => []
  const release = vi.fn()
  mocks.prepare.mockResolvedValue(environment)
  mocks.connect.mockResolvedValue(environment)
  mocks.get.mockReturnValue(environment)
  mocks.acquire.mockReturnValue({ environment, release })
  mocks.retain.mockReturnValue({ environment, release })
  return { ctx, sender, environment, release }
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('SSH activation and browsing leases', () => {
  it('returns server-native Windows volumes and breadcrumbs', async () => {
    const state = fixture()
    state.environment.facts = { ...state.environment.facts, os: 'win32', home: 'C:\\Users\\remote' }
    state.environment.path = createWorkspacePaths(state.environment.fs, 'win32')
    const command = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(['C:\\', 'D:\\', 'invalid']), stderr: '' }))
    state.environment.spawn = command
    const directory = await connectForBrowse({ id: 'server', requestId: 'windows-browse', allowLocalCommands: true }, state.ctx)
    expect(directory.roots).toEqual(['C:\\', 'D:\\'])
    expect(directory.breadcrumbs.map((entry) => entry.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\remote'])
    expect(command).toHaveBeenCalledOnce()
    state.sender.emit('destroyed')
  })

  it('cancels a completed prepare without leaving an activation grant', async () => {
    const state = fixture()
    const requestId = 'cancel-activation'
    const ready = await prepareWorkspace({ workspaceId: 'remote', requestId }, state.ctx)
    cancelConnectionRequest(requestId, state.ctx)
    expect(state.release).toHaveBeenCalledTimes(1)
    expect(() => commitWorkspaceActivation({ ticket: ready.ticket, requestId }, state.ctx)).toThrow('approval-expired')
    state.sender.emit('destroyed')
    expect(state.release).toHaveBeenCalledTimes(1)
  })
  it('expires unused tickets and retains committed tickets until window destruction', async () => {
    vi.useFakeTimers()
    const state = fixture()
    const requestId = 'expire-activation'
    const ready = await prepareWorkspace({ workspaceId: 'remote', requestId }, state.ctx)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.release).toHaveBeenCalledTimes(1)
    expect(() => commitWorkspaceActivation({ ticket: ready.ticket, requestId }, state.ctx)).toThrow('approval-expired')
    const next = await prepareWorkspace({ workspaceId: 'remote', requestId: 'valid-activation' }, state.ctx)
    commitWorkspaceActivation({ ticket: next.ticket, requestId: 'valid-activation' }, state.ctx)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.release).toHaveBeenCalledTimes(1)
    state.sender.emit('destroyed')
    expect(state.release).toHaveBeenCalledTimes(2)
  })
  it('holds browsing connections until close or expiry', async () => {
    vi.useFakeTimers()
    const state = fixture()
    const first = await connectForBrowse({ id: 'server', requestId: 'browse-first', allowLocalCommands: true }, state.ctx)
    expect(mocks.retain).toHaveBeenCalledTimes(1)
    closeBrowse(first.browseId, state.ctx)
    expect(state.release).toHaveBeenCalledTimes(1)
    await connectForBrowse({ id: 'server', requestId: 'browse-second', allowLocalCommands: true }, state.ctx)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(state.release).toHaveBeenCalledTimes(2)
    state.sender.emit('destroyed')
  })
})