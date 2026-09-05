import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFile } from '../../../../shared/domain/workspace-file'

vi.mock('../../services/workspace-files', () => ({
  readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn(),
  workspaceFileErrorKey: () => 'document.error.conflict'
}))
import { readWorkspaceFile, writeWorkspaceFile } from '../../services/workspace-files'
import { confirmDocumentChanges, documentKey, isDocumentDirty, serializeDraft, useDocumentsStore } from '../documents'

const key = documentKey('w', 'note.md')
const textFile = (content = 'original', revision = 'r1'): WorkspaceFile => ({ kind: 'text', path: 'note.md', size: content.length, content, revision })
const entry = () => useDocumentsStore.getState().entries[key]!

beforeEach(() => {
  vi.clearAllMocks()
  useDocumentsStore.setState({ entries: {}, confirmation: null })
  vi.mocked(readWorkspaceFile).mockResolvedValue(textFile())
})

describe('document drafts', () => {
  it('keeps unsaved edits across tab remounts and isolates workspaces', async () => {
    await useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().edit('w', 'note.md', 'draft')
    await useDocumentsStore.getState().load('w', 'note.md')
    await useDocumentsStore.getState().load('other', 'note.md')
    expect(entry().draft).toBe('draft')
    expect(useDocumentsStore.getState().entries[documentKey('other', 'note.md')]?.draft).toBe('original')
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2)
  })

  it('preserves BOM and CRLF when editing and saves with a revision', async () => {
    vi.mocked(readWorkspaceFile).mockResolvedValue(textFile('\uFEFFfirst\r\nsecond\r\n'))
    vi.mocked(writeWorkspaceFile).mockResolvedValue({ kind: 'text', path: 'note.md', size: 24, content: '\uFEFFfirst\r\nchanged\r\n', revision: 'r2' })
    await useDocumentsStore.getState().load('w', 'note.md')
    expect(entry().draft).toBe('first\nsecond\n')
    useDocumentsStore.getState().edit('w', 'note.md', 'first\nchanged\n')
    expect(await useDocumentsStore.getState().save('w', 'note.md')).toBe(true)
    expect(writeWorkspaceFile).toHaveBeenCalledWith({ workspaceId: 'w', path: 'note.md', content: '\uFEFFfirst\r\nchanged\r\n', revision: 'r1' })
    expect(isDocumentDirty(entry())).toBe(false)
  })

  it('returns exact original bytes for an unchanged mixed-newline draft', async () => {
    const content = '\uFEFFfirst\r\nsecond\nthird\r'
    vi.mocked(readWorkspaceFile).mockResolvedValue(textFile(content))
    await useDocumentsStore.getState().load('w', 'note.md')
    expect(serializeDraft(entry())).toBe(content)
    useDocumentsStore.getState().edit('w', 'note.md', 'changed\nsecond\nthird\n')
    expect(serializeDraft(entry())).toBe('\uFEFFchanged\r\nsecond\nthird\r')
  })

  it('deduplicates saves and preserves edits typed while saving', async () => {
    let complete!: (value: Awaited<ReturnType<typeof writeWorkspaceFile>>) => void
    vi.mocked(writeWorkspaceFile).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    await useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().edit('w', 'note.md', 'first draft')
    const saving = useDocumentsStore.getState().save('w', 'note.md')
    const duplicate = useDocumentsStore.getState().save('w', 'note.md')
    useDocumentsStore.getState().edit('w', 'note.md', 'newer draft')
    complete({ kind: 'text', path: 'note.md', size: 11, content: 'first draft', revision: 'r2' })
    await Promise.all([saving, duplicate])
    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(entry().draft).toBe('newer draft')
    expect(entry().base).toBe('first draft')
    expect(entry().file?.revision).toBe('r2')
    expect(isDocumentDirty(entry())).toBe(true)
  })

  it('retains draft and revision after an external modification conflict', async () => {
    await useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().edit('w', 'note.md', 'precious draft')
    vi.mocked(writeWorkspaceFile).mockRejectedValue(new Error('workspace_file:conflict'))
    expect(await useDocumentsStore.getState().save('w', 'note.md')).toBe(false)
    expect(entry().draft).toBe('precious draft')
    expect(entry().file?.revision).toBe('r1')
    expect(entry().error).toBe('document.error.conflict')
  })

  it('does not revive a document from a late read after closing it', async () => {
    let complete!: (value: WorkspaceFile) => void
    vi.mocked(readWorkspaceFile).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const loading = useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().release('w', 'note.md')
    complete(textFile())
    await loading
    expect(entry()).toBeUndefined()
  })

  it('guards only the affected subtree and supports cancel', async () => {
    await useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().edit('w', 'note.md', 'draft')
    expect(await confirmDocumentChanges('w', 'notes')).toBe(true)
    const result = confirmDocumentChanges('w')
    await Promise.resolve()
    const confirmation = useDocumentsStore.getState().confirmation!
    expect(confirmation.keys).toEqual([key])
    confirmation.resolve(false)
    useDocumentsStore.setState({ confirmation: null })
    expect(await result).toBe(false)
    expect(entry().draft).toBe('draft')
  })

  it('restarts a pending read after moving its path', async () => {
    let complete!: (value: WorkspaceFile) => void
    vi.mocked(readWorkspaceFile).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const loading = useDocumentsStore.getState().load('w', 'note.md')
    useDocumentsStore.getState().applyMutation({ workspaceId: 'w', path: 'note.md', destination: 'renamed.md', operation: 'rename' })
    await useDocumentsStore.getState().load('w', 'renamed.md')
    complete(textFile())
    await loading
    expect(entry()).toBeUndefined()
    expect(useDocumentsStore.getState().entries[documentKey('w', 'renamed.md')]?.loading).toBe(false)
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2)
  })

  it('renames directory drafts by path boundary and removes deleted descendants', async () => {
    await useDocumentsStore.getState().load('w', 'folder/a.md')
    await useDocumentsStore.getState().load('w', 'folder-extra/a.md')
    useDocumentsStore.getState().applyMutation({ workspaceId: 'w', path: 'folder', destination: 'moved', operation: 'move' })
    expect(useDocumentsStore.getState().entries[documentKey('w', 'moved/a.md')]?.path).toBe('moved/a.md')
    expect(useDocumentsStore.getState().entries[documentKey('w', 'folder-extra/a.md')]).toBeDefined()
    useDocumentsStore.getState().applyMutation({ workspaceId: 'w', path: 'moved', operation: 'delete' })
    expect(useDocumentsStore.getState().entries[documentKey('w', 'moved/a.md')]).toBeUndefined()
  })
})
