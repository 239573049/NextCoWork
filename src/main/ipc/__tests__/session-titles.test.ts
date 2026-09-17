import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../../shared/agent/message'

vi.mock('../../window/registry', () => ({ windows: { emitToAll: vi.fn() } }))
vi.mock('../storage', () => ({ removeSessionAttachmentFiles: vi.fn(() => ({ deleted: 0, undeletable: [] })) }))
vi.mock('../attachment', () => ({ uploadAttachment: vi.fn() }))

import { closeDatabase } from '../../db'
import { putSession } from '../../db/repo'
import { runs } from '../../kernel/run-registry'
import { store } from '../../state/store'
import { windows } from '../../window/registry'
import { createSession, deleteSession, renameSession, replaceHistory } from '../sessions'
import { removeSessionAttachmentFiles } from '../storage'

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
      kind: 'metadata', sessionIds: [session.id],
      workspaceId: 'workspace', renamed: { sessionId: session.id, title: 'My conversation' }
    })
    expect(store.getSession(session.id)?.titleSource).toBe('manual')
  })

  it('scopes transcript edits and reports the actual deleted subtree', () => {
    store.createSession({ id: 'parent', workspaceId: 'workspace', title: 'Parent' })
    store.createSession({ id: 'child', workspaceId: 'workspace', parentSessionId: 'parent' })
    store.createSession({ id: 'other', workspaceId: 'workspace', title: 'Other' })
    replaceHistory({ sessionId: 'parent', messages: [] })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      kind: 'history', sessionIds: ['parent'], workspaceId: 'workspace'
    })
    deleteSession({ sessionId: 'parent' })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      kind: 'deleted', sessionIds: ['parent', 'child'], workspaceId: 'workspace',
      replacement: { workspaceId: 'workspace', id: 'other', title: 'Other' }
    })
    expect(store.getSession('child')).toBeUndefined()
    expect(store.getSession('other')).toBeDefined()
  })

  it.each([['first', 'middle'], ['middle', 'last'], ['last', 'middle']])('selects the adjacent replacement when deleting %s', (deleted, replacement) => {
    for (const [index, id] of ['first', 'middle', 'last'].entries()) {
      const session = store.createSession({ id, workspaceId: 'workspace', title: id })
      putSession({ ...session, updatedAt: 3 - index })
    }
    deleteSession({ sessionId: deleted })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      kind: 'deleted', workspaceId: 'workspace', sessionIds: [deleted],
      replacement: { workspaceId: 'workspace', id: replacement, title: replacement }
    })
  })

  it('does not invent a replacement when no conversations remain', () => {
    store.createSession({ id: 'last', workspaceId: 'workspace' })
    deleteSession({ sessionId: 'last' })
    expect(windows.emitToAll).toHaveBeenLastCalledWith('sessions:changed', {
      kind: 'deleted', workspaceId: 'workspace', sessionIds: ['last']
    })
  })

  it('does not broadcast deletion or remove files if the database delete fails', () => {
    store.createSession({ id: 'retained', workspaceId: 'workspace' })
    const remove = vi.spyOn(store, 'deleteSession').mockImplementation(() => { throw new Error('database unavailable') })
    try {
      expect(() => deleteSession({ sessionId: 'retained' })).toThrow('database unavailable')
      expect(windows.emitToAll).not.toHaveBeenCalled()
      expect(removeSessionAttachmentFiles).not.toHaveBeenCalled()
      expect(store.getSession('retained')).toBeDefined()
    } finally {
      remove.mockRestore()
    }
  })

  it('blocks deletion only for a run inside the deleted subtree, not for unrelated runs', () => {
    store.createSession({ id: 'retained', workspaceId: 'workspace' })
    store.createSession({ id: 'busy', workspaceId: 'workspace' })
    store.createSession({ id: 'busy-child', workspaceId: 'workspace', parentSessionId: 'busy' })
    const active = vi.spyOn(runs, 'activeRunIds').mockReturnValue(['run-1'])
    const get = vi.spyOn(runs, 'get').mockReturnValue({ sessionId: 'busy' } as never)
    try {
      // 无关会话在跑 —— 不再全局禁止删除
      expect(() => deleteSession({ sessionId: 'retained' })).not.toThrow()
      expect(store.getSession('retained')).toBeUndefined()
      // 被删会话自己在跑 —— 拦下
      expect(() => deleteSession({ sessionId: 'busy' })).toThrow('Agent')
      expect(store.getSession('busy')).toBeDefined()
      expect(windows.emitToAll).not.toHaveBeenCalledWith('sessions:changed', expect.objectContaining({ kind: 'deleted', sessionIds: expect.arrayContaining(['busy']) }))
      expect(removeSessionAttachmentFiles).toHaveBeenCalledTimes(1)
      get.mockReturnValue({ sessionId: 'busy-child' } as never)
      // run 落在被删会话的子代理转录上 —— 同样拦下(级联会连它一起删)
      expect(() => deleteSession({ sessionId: 'busy' })).toThrow('Agent')
      expect(store.getSession('busy-child')).toBeDefined()
    } finally {
      get.mockRestore()
      active.mockRestore()
    }
  })
})
