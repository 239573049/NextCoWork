import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../../shared/agent/message'

vi.mock('../../window/registry', () => ({ windows: { emitToAll: vi.fn() } }))
vi.mock('../storage', () => ({ removeSessionAttachmentFiles: vi.fn() }))
vi.mock('../attachment', () => ({ uploadAttachment: vi.fn() }))

import { closeDatabase } from '../../db'
import { store } from '../../state/store'
import { windows } from '../../window/registry'
import { createSession, renameSession } from '../sessions'

beforeEach(() => { closeDatabase(); vi.clearAllMocks() })
afterEach(() => closeDatabase())

describe('session title IPC', () => {
  it('a late tab registration cannot overwrite an already-started conversation', () => {
    const session = store.ensureSession({ id: 'session', workspaceId: 'workspace', model: 'selected-model' })
    store.renameSession(session.id, 'Already titled')
    store.commitMessage(session.id, userMessage('first', [{ type: 'text', text: 'First message' }], 1))
    const result = createSession({ sessionId: session.id, workspaceId: session.workspaceId, title: '新对话' })
    expect(result).toMatchObject({ title: 'Already titled', titleSource: 'manual', model: 'selected-model' })
    expect(store.getHistory(session.id)).toHaveLength(1)
  })

  it('broadcasts the persisted title so every window can update its tabs', () => {
    const session = createSession({ workspaceId: 'workspace' })
    renameSession({ sessionId: session.id, title: '  My conversation  ' })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      workspaceId: 'workspace', renamed: { sessionId: session.id, title: 'My conversation' }
    })
    expect(store.getSession(session.id)?.titleSource).toBe('manual')
  })
})
