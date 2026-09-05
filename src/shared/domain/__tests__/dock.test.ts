import { describe, expect, it } from 'vitest'
import type { InnerTab } from '../tab'
import { closeTab, createInitialDock, moveTab, normalizeDockState, reorderTab, resizeSplit, splitGroup } from '../dock'

const chat = (id: string, pane?: 'main' | 'bottom' | 'right'): InnerTab => ({
  id,
  kind: 'chat',
  ...(pane === undefined ? {} : { pane }),
  title: id,
  ref: { sessionId: id }
})

describe('Dock layout', () => {
  it('migrates legacy panes into a nested layout', () => {
    const state = createInitialDock([chat('main'), chat('bottom', 'bottom'), chat('right', 'right')])
    expect(state.root.type).toBe('split')
    expect(state.activeGroupId).not.toBeNull()
  })

  it('splits a group in the requested direction', () => {
    const state = createInitialDock([chat('main')])
    const groupId = state.activeGroupId as string
    const next = splitGroup(state, groupId, 'right')
    expect(next.root.type).toBe('split')
    expect(next.root.type === 'split' && next.root.direction).toBe('horizontal')
    expect(next.activeGroupId).not.toBe(groupId)
  })

  it('moves a tab across groups and activates the target', () => {
    const state = createInitialDock([chat('a'), chat('b')])
    const groupId = state.activeGroupId as string
    const split = splitGroup(state, groupId, 'right')
    const target = split.activeGroupId as string
    const next = moveTab(split, 'a', groupId, target)
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'b'])
    expect(next.activeGroupId).toBe(target)
  })

  it('closes an empty group and collapses its parent', () => {
    const state = createInitialDock([chat('a')])
    const split = splitGroup(state, state.activeGroupId as string, 'down', ['b'])
    const target = split.activeGroupId as string
    const next = closeTab(split, target, 'b')
    expect(next.root.type).toBe('group')
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a'])
  })

  it('clamps split ratios and repairs invalid active ids', () => {
    const state = createInitialDock([chat('a')])
    const split = splitGroup(state, state.activeGroupId as string, 'right')
    const splitId = split.root.type === 'split' ? split.root.id : ''
    const resized = resizeSplit(split, splitId, 99)
    expect(resized.root.type === 'split' && resized.root.ratio).toBe(0.85)
    const repaired = normalizeDockState({ ...resized, activeGroupId: 'missing' }, resized.tabs)
    expect(repaired.activeGroupId).not.toBe('missing')
  })

  it('keeps Dock tab order independent from the global tab array', () => {
    const state = createInitialDock([chat('a'), chat('b'), chat('c')])
    const groupId = state.activeGroupId as string
    const next = reorderTab(state, groupId, 0, 2)
    expect(next.root.type === 'group' && next.root.tabIds).toEqual(['b', 'c', 'a'])
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
  })

  it('reveals a destination group and updates the legacy pane hint when moving a tab', () => {
    const state = createInitialDock([chat('a'), chat('b')])
    const source = state.activeGroupId as string
    const split = splitGroup(state, source, 'right')
    const target = split.activeGroupId as string
    const next = moveTab(split, 'a', source, target)
    expect(next.root.type).toBe('split')
    expect(next.root.type === 'split' && next.root.second.type === 'group' && next.root.second.hidden).toBe(false)
    expect(next.tabs.find((tab) => tab.id === 'a')?.pane).toBe('main')
  })

  it('drops empty placeholder groups from old persisted layouts', () => {
    const state = createInitialDock([chat('a')])
    const split = splitGroup(state, state.activeGroupId as string, 'right')
    const repaired = normalizeDockState({ ...split, revision: undefined }, split.tabs)
    expect(repaired.root.type).toBe('group')
    expect(repaired.tabs.map((tab) => tab.id)).toEqual(['a'])
  })

  it('pins one workspace-files tab to the outer-right group and removes duplicates', () => {
    const files = { id: 'files-1', kind: 'files' as const, pane: 'right' as const, title: 'Files', ref: { path: '' } }
    const duplicate = { ...files, id: 'files-2' }
    const chatTab = chat('chat')
    const state = createInitialDock([chatTab, files, duplicate])
    const repaired = normalizeDockState(state, [chatTab, files, duplicate])
    expect(repaired.tabs.filter((tab) => tab.kind === 'files')).toHaveLength(1)
    expect(repaired.root.type).toBe('split')
    if (repaired.root.type === 'split') {
      expect(repaired.root.second.type === 'group' && repaired.root.second.pinned).toBe('right')
      expect(repaired.root.second.type === 'group' && repaired.root.second.tabIds).toEqual(['files-1'])
    }
  })

  it('keeps an existing files group and does not leave an empty sibling', () => {
    const chatTab = chat('chat')
    const files: InnerTab = { id: 'files', kind: 'files', pane: 'right', title: 'Files', ref: { path: '' } }
    const state = createInitialDock([chatTab])
    const split = splitGroup(state, state.activeGroupId as string, 'right', [files.id])
    const repaired = normalizeDockState({ ...split, tabs: [chatTab, files] }, [chatTab, files])
    expect(repaired.root.type).toBe('split')
    if (repaired.root.type === 'split') {
      expect(repaired.root.first.type === 'group' && repaired.root.first.tabIds).toEqual(['chat'])
      expect(repaired.root.second.type === 'group' && repaired.root.second.tabIds).toEqual(['files'])
      expect(repaired.root.second.type === 'group' && repaired.root.second.pinned).toBe('right')
    }
  })

  it('allows ordinary tabs to join the pinned files group', () => {
    const chatTab = chat('chat')
    const preview: InnerTab = { id: 'preview', kind: 'preview', pane: 'main', title: 'CHANGELOG.md', ref: { path: 'CHANGELOG.md' } }
    const files: InnerTab = { id: 'files', kind: 'files', pane: 'right', title: 'Files', ref: { path: '' } }
    const state = createInitialDock([chatTab, preview, files])
    const mainGroup = state.root.type === 'split' ? state.root.first : state.root
    const filesGroup = state.root.type === 'split' ? state.root.second : state.root
    expect(mainGroup.type).toBe('group')
    expect(filesGroup.type).toBe('group')
    if (mainGroup.type !== 'group' || filesGroup.type !== 'group') return
    const moved = moveTab(state, preview.id, mainGroup.id, filesGroup.id)
    const target = moved.root.type === 'split' ? moved.root.second : moved.root
    expect(target.type === 'group' && target.pinned).toBe('right')
    expect(target.type === 'group' && target.tabIds).toContain(preview.id)
  })
})
