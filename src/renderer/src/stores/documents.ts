import { create } from 'zustand'
import type { WorkspaceFile, WorkspaceFileMutationRequest } from '../../../shared/domain/workspace-file'
import type { TranslationKey } from '../i18n'
import { readWorkspaceFile, workspaceFileErrorKey, writeWorkspaceFile } from '../services/workspace-files'

export interface DocumentDraft {
  workspaceId: string
  path: string
  file?: WorkspaceFile
  draft: string
  base: string
  bom: string
  lineEnding: string
  lineEndings: string[]
  loading: boolean
  saving: boolean
  error?: TranslationKey
  mode: 'preview' | 'source'
}

interface Confirmation {
  keys: string[]
  resolve: (proceed: boolean) => void
}

interface DocumentsState {
  entries: Record<string, DocumentDraft>
  confirmation: Confirmation | null
  load: (workspaceId: string, path: string, force?: boolean) => Promise<void>
  edit: (workspaceId: string, path: string, content: string) => void
  setMode: (workspaceId: string, path: string, mode: DocumentDraft['mode']) => void
  save: (workspaceId: string, path: string) => Promise<boolean>
  discard: (keys: readonly string[]) => void
  release: (workspaceId: string, path?: string) => void
  applyMutation: (req: WorkspaceFileMutationRequest) => void
}

export const documentKey = (workspaceId: string, path: string): string => JSON.stringify([workspaceId, path])
export const isDocumentDirty = (entry: DocumentDraft): boolean => entry.draft !== entry.base
export const isWithinPath = (path: string, parent?: string): boolean => parent === undefined || path === parent || path.startsWith(`${parent}/`)

export function editableText(content: string): { text: string; bom: string; lineEnding: string; lineEndings: string[] } {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lineEndings = content.match(/\r\n|\r|\n/g) ?? []
  return { text: content.slice(bom.length).replace(/\r\n?/g, '\n'), bom, lineEnding: lineEndings[0] ?? '\n', lineEndings }
}

export function serializeDraft(entry: DocumentDraft): string {
  if (entry.file?.kind === 'text' && !isDocumentDirty(entry)) return entry.file.content
  let line = 0
  return entry.bom + entry.draft.replace(/\n/g, () => entry.lineEndings[line++] ?? entry.lineEnding)
}

/** Preserve delimiters outside the changed span, including mixed CRLF/LF files. */
function editedLineEndings(entry: DocumentDraft, next: string): string[] {
  let start = 0
  while (start < entry.draft.length && start < next.length && entry.draft[start] === next[start]) start++
  let oldEnd = entry.draft.length
  let newEnd = next.length
  while (oldEnd > start && newEnd > start && entry.draft[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
  const count = (value: string): number => value.match(/\n/g)?.length ?? 0
  const before = count(entry.draft.slice(0, start))
  const removed = count(entry.draft.slice(start, oldEnd))
  const inserted = count(next.slice(start, newEnd))
  return [
    ...entry.lineEndings.slice(0, before),
    ...Array.from({ length: inserted }, (_, i) => i < removed ? entry.lineEndings[before + i] ?? entry.lineEnding : entry.lineEnding),
    ...entry.lineEndings.slice(before + removed)
  ]
}

const saves = new Map<string, Promise<boolean>>()

export const useDocumentsStore = create<DocumentsState>((set, get) => {
  const patch = (key: string, value: Partial<DocumentDraft>): void => {
    const entry = get().entries[key]
    if (entry) set({ entries: { ...get().entries, [key]: { ...entry, ...value } } })
  }

  return {
    entries: {},
    confirmation: null,
    async load(workspaceId, path, force = false) {
      const key = documentKey(workspaceId, path)
      const previous = get().entries[key]
      if (previous && (!force || previous.loading || previous.saving || isDocumentDirty(previous))) return
      // The object identity is a request token: late reads cannot revive a closed or moved file.
      const pending: DocumentDraft = { workspaceId, path, draft: '', base: '', bom: '', lineEnding: '\n', lineEndings: [], loading: true, saving: false, mode: previous?.mode ?? (/\.md(?:own|x)?$|\.markdown$/i.test(path) ? 'preview' : 'source') }
      set({ entries: { ...get().entries, [key]: pending } })
      try {
        const file = await readWorkspaceFile(workspaceId, path)
        if (get().entries[key] !== pending) return
        const parsed = editableText(file.kind === 'text' ? file.content : '')
        patch(key, { file, draft: parsed.text, base: parsed.text, bom: parsed.bom, lineEnding: parsed.lineEnding, lineEndings: parsed.lineEndings, loading: false })
      } catch (error) {
        if (get().entries[key] === pending) patch(key, { loading: false, error: workspaceFileErrorKey(error) })
      }
    },
    edit(workspaceId, path, content) {
      const key = documentKey(workspaceId, path)
      const entry = get().entries[key]
      if (entry) patch(key, { draft: content, lineEndings: editedLineEndings(entry, content) })
    },
    setMode(workspaceId, path, mode) {
      patch(documentKey(workspaceId, path), { mode })
    },
    save(workspaceId, path) {
      const key = documentKey(workspaceId, path)
      const inFlight = saves.get(key)
      if (inFlight) return inFlight
      const entry = get().entries[key]
      if (!entry || entry.file?.kind !== 'text' || entry.loading) return Promise.resolve(false)
      if (!isDocumentDirty(entry)) return Promise.resolve(true)
      const revision = entry.file.revision
      patch(key, { saving: true, error: undefined })
      const promise = (async (): Promise<boolean> => {
        try {
          const file = await writeWorkspaceFile({ workspaceId, path, content: serializeDraft(entry), revision })
          // Keep any edits typed while the request was in flight.
          patch(key, { file, base: entry.draft, saving: false })
          return true
        } catch (error) {
          patch(key, { saving: false, error: workspaceFileErrorKey(error) })
          return false
        } finally {
          saves.delete(key)
        }
      })()
      saves.set(key, promise)
      return promise
    },
    discard(keys) {
      const entries = { ...get().entries }
      for (const key of keys) {
        const entry = entries[key]
        if (entry && !entry.saving) entries[key] = { ...entry, draft: entry.base, lineEndings: editableText(entry.file?.kind === 'text' ? entry.file.content : '').lineEndings, error: undefined }
      }
      set({ entries })
    },
    release(workspaceId, path) {
      const entries = { ...get().entries }
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.workspaceId === workspaceId && isWithinPath(entry.path, path) && !entry.saving) delete entries[key]
      }
      set({ entries })
    },
    applyMutation(req) {
      if (!['rename', 'move', 'delete'].includes(req.operation)) return
      const entries = { ...get().entries }
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.workspaceId !== req.workspaceId || !isWithinPath(entry.path, req.path)) continue
        delete entries[key]
        if (req.operation !== 'delete' && req.destination && !entry.loading) {
          const path = req.destination + entry.path.slice(req.path.length)
          entries[documentKey(req.workspaceId, path)] = { ...entry, path, file: entry.file ? { ...entry.file, path } : undefined }
        }
      }
      set({ entries })
    }
  }
})

/** Drafts survive tab/workspace switches. Only destructive navigation asks. */
export async function confirmDocumentChanges(workspaceId?: string, path?: string): Promise<boolean> {
  const matches = (entry: DocumentDraft): boolean => (workspaceId === undefined || entry.workspaceId === workspaceId) && isWithinPath(entry.path, path)
  const pending = Object.entries(useDocumentsStore.getState().entries).filter(([, entry]) => matches(entry) && entry.saving)
  await Promise.all(pending.map(([key]) => saves.get(key)))
  const keys = Object.entries(useDocumentsStore.getState().entries).filter(([, entry]) => matches(entry) && isDocumentDirty(entry)).map(([key]) => key)
  if (keys.length === 0) return true
  if (useDocumentsStore.getState().confirmation) return false
  return new Promise((resolve) => useDocumentsStore.setState({ confirmation: { keys, resolve } }))
}
