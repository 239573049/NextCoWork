import type { WorkspaceFile, WorkspaceFileMutationRequest, WorkspaceFileMutationResult, WorkspaceFileWriteRequest, WorkspaceTextFile } from '../../../shared/domain/workspace-file'
import { WORKSPACE_FILE_ERROR_PREFIX } from '../../../shared/domain/workspace-file'
import type { TranslationKey } from '../i18n'
import { useDocumentsStore } from '../stores/documents'
import { useTabsStore } from '../stores/tabs'
import { invoke } from './ipc'

export interface WorkspaceFilesChanged extends WorkspaceFileMutationResult {
  workspaceId: string
  operation: WorkspaceFileMutationRequest['operation'] | 'save'
}

function announce(detail: WorkspaceFilesChanged): void {
  window.dispatchEvent(new CustomEvent('workspace-files-changed', { detail }))
}

export function readWorkspaceFile(workspaceId: string, path: string): Promise<WorkspaceFile> {
  return invoke('workspace:readFile', { workspaceId, path })
}

export async function writeWorkspaceFile(req: WorkspaceFileWriteRequest): Promise<WorkspaceTextFile> {
  const result = await invoke('workspace:writeFile', req)
  announce({ workspaceId: req.workspaceId, path: req.path, operation: 'save' })
  return result
}

export async function mutateWorkspaceFile(req: WorkspaceFileMutationRequest): Promise<WorkspaceFileMutationResult> {
  const result = await invoke('workspace:mutateFile', req)
  const change = { ...req, ...result }
  useDocumentsStore.getState().applyMutation(change)
  useTabsStore.getState().applyFileMutation(change)
  announce(change)
  return result
}

export function revealWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  return invoke('workspace:revealFile', { workspaceId, path })
}

/** Never show raw filesystem/IPC errors as untranslated UI copy. */
export function workspaceFileErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : ''
  const code = message.startsWith(WORKSPACE_FILE_ERROR_PREFIX) ? message.slice(WORKSPACE_FILE_ERROR_PREFIX.length) : 'io'
  const known = ['not-found', 'exists', 'invalid-path', 'symlink', 'permission', 'conflict', 'too-large', 'not-file', 'invalid-encoding', 'unsupported', 'workspace-unavailable']
  return `document.error.${known.includes(code) ? code : 'io'}`
}
