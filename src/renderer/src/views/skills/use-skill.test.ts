import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  draft: 'Existing draft',
  activeKind: 'chat',
  setDraft: vi.fn(),
  openWorkspace: vi.fn(),
  newChat: vi.fn()
}))

vi.mock('../../stores/session', () => ({
  sessionStore: () => ({ getState: () => ({ draft: state.draft, setDraft: state.setDraft }) })
}))
vi.mock('../../stores/window', () => ({ useWindowStore: { getState: () => ({ openWorkspace: state.openWorkspace, activeWorkspaceId: 'workspace', pendingActivation: null, activeStandaloneFeature: null }) } }))
vi.mock('../../stores/tabs', () => ({ useTabsStore: { getState: () => ({
  stateOf: () => ({ activeTabId: 'chat', tabs: [{ id: 'chat', kind: state.activeKind, ref: { sessionId: null } }] }),
  newChat: (workspaceId: string) => { state.newChat(workspaceId); state.activeKind = 'chat' }
}) } }))

import { useSkillInWorkspace } from './use-skill'

beforeEach(() => {
  vi.clearAllMocks()
  state.draft = 'Existing draft'
  state.activeKind = 'chat'
  state.openWorkspace.mockResolvedValue(true)
})

describe('useSkillInWorkspace', () => {
  it('persists a Skill tag only after returning to the verified workspace', async () => {
    await useSkillInWorkspace('workspace', 'algorithmic-art')
    expect(state.setDraft).toHaveBeenCalledWith('Existing draft <skill name="algorithmic-art" /> ')
    expect(state.setDraft.mock.invocationCallOrder[0]).toBeGreaterThan(state.openWorkspace.mock.invocationCallOrder[0]!)
    expect(state.newChat).not.toHaveBeenCalled()
  })

  it('opens a chat when the workspace currently shows a non-chat tab', async () => {
    state.activeKind = 'terminal'
    await useSkillInWorkspace('workspace', 'skill-name')
    expect(state.newChat).toHaveBeenCalledWith('workspace')
    expect(state.setDraft).toHaveBeenCalled()
  })

  it('does not use a display name as a protocol identifier', async () => {
    await useSkillInWorkspace('workspace', 'Algorithmic Art')
    expect(state.setDraft).not.toHaveBeenCalled()
    expect(state.openWorkspace).not.toHaveBeenCalled()
  })

  it('leaves the draft and tabs unchanged when workspace verification fails', async () => {
    state.openWorkspace.mockResolvedValue(false)
    expect(await useSkillInWorkspace('workspace', 'skill-name')).toBe(false)
    expect(state.setDraft).not.toHaveBeenCalled()
    expect(state.newChat).not.toHaveBeenCalled()
  })
})
