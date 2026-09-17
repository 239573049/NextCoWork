import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../window/registry', () => ({ windows: { emitToAll: vi.fn() } }))
vi.mock('../storage', () => ({ removeSessionAttachmentFiles: vi.fn(() => ({ deleted: 0, undeletable: [] })) }))
vi.mock('../attachment', () => ({ uploadAttachment: vi.fn() }))

import { closeDatabase } from '../../db'
import { putSession } from '../../db/repo'
import { store } from '../../state/store'
import { windows } from '../../window/registry'
import { setModel } from '../sessions'

beforeEach(() => { closeDatabase(); vi.clearAllMocks() })
afterEach(() => closeDatabase())

describe('per-session model memory', () => {
  it('remembers the pick on one conversation without touching another', () => {
    store.createSession({ id: 'a', workspaceId: 'workspace', model: 'sol', modelProviderId: 'routinai' })
    store.createSession({ id: 'b', workspaceId: 'workspace', model: 'claude', modelProviderId: 'anthropic' })
    setModel({ sessionId: 'a', model: 'gpt', modelProviderId: 'openai' })
    expect(store.getSession('a')).toMatchObject({ model: 'gpt', modelProviderId: 'openai' })
    expect(store.getSession('b')).toMatchObject({ model: 'claude', modelProviderId: 'anthropic' })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      kind: 'metadata', sessionIds: ['a'], workspaceId: 'workspace'
    })
  })

  it('clears the provider when the new alias comes without one', () => {
    store.createSession({ id: 'a', workspaceId: 'workspace', model: 'sol', modelProviderId: 'routinai' })
    setModel({ sessionId: 'a', model: 'sol' })
    expect(store.getSession('a')?.modelProviderId).toBeUndefined()
  })

  it('leaves the recency order alone: picking a model is not conversation activity', () => {
    const session = store.createSession({ id: 'a', workspaceId: 'workspace', model: 'sol' })
    putSession({ ...session, updatedAt: 1_000 })
    setModel({ sessionId: 'a', model: 'gpt', modelProviderId: 'openai' })
    expect(store.getSession('a')?.updatedAt).toBe(1_000)
  })

  it('stays silent for an unchanged pick and for a session that does not exist', () => {
    store.createSession({ id: 'a', workspaceId: 'workspace', model: 'sol', modelProviderId: 'routinai' })
    setModel({ sessionId: 'a', model: 'sol', modelProviderId: 'routinai' })
    setModel({ sessionId: 'missing', model: 'gpt' })
    expect(windows.emitToAll).not.toHaveBeenCalled()
  })
})
