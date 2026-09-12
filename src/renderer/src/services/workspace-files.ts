import type { WorkspaceFile, WorkspaceFileMutationRequest, WorkspaceFileMutationResult, WorkspaceFileWriteRequest, WorkspaceRecoveryListing, WorkspaceTextFile } from '../../../shared/domain/workspace-file'
import { WORKSPACE_FILE_ERROR_PREFIX } from '../../../shared/domain/workspace-file'
import type { TranslationKey } from '../i18n'
import { useDocumentsStore } from '../stores/documents'
import { useTabsStore } from '../stores/tabs'
import { useWindowStore } from '../stores/window'
import { AgentErrorException, invoke } from './ipc'

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

/**
 * 可恢复的删除项。★ 从**服务器上的索引**读,不从任何客户端状态读 —— 刷新、切子树根、
 * 重连、重启应用之后它都还在,而组件 state 三种都活不过。
 */
export function listWorkspaceRecovery(workspaceId: string): Promise<WorkspaceRecoveryListing> {
  return invoke('workspace:listRecovery', { workspaceId })
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

export async function revealWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  const result = await invoke('workspace:revealFile', { workspaceId, path })
  if (result?.remote) {
    const window = useWindowStore.getState()
    if (window.activeWorkspaceId !== workspaceId || window.pendingActivation !== null) return
    useTabsStore.getState().open(workspaceId, 'files', 'right', { path: result.parent, title: result.name, selectedPath: result.path })
    window.setRightPanelForWorkspace(workspaceId, true)
  }
}

/** Never show raw filesystem/IPC errors as untranslated UI copy. */
export function workspaceFileErrorKey(error: unknown): TranslationKey {
  if (error instanceof AgentErrorException && error.error.environmentCode) return `environment.error.${error.error.environmentCode}`
  const message = error instanceof Error ? error.message : ''
  const code = message.startsWith(WORKSPACE_FILE_ERROR_PREFIX) ? message.slice(WORKSPACE_FILE_ERROR_PREFIX.length) : 'io'
  const known = ['not-found', 'exists', 'invalid-path', 'symlink', 'permission', 'conflict', 'too-large', 'not-file', 'invalid-encoding', 'unsupported', 'workspace-unavailable']
  return `document.error.${known.includes(code) ? code : 'io'}`
}

/**
 * 「结果未知」——连接在**请求已经发出之后**断的,操作可能已经在服务器上完成了。
 *
 * ★ 它和其它失败在界面上的后果完全不同。别的错(`exists`、`invalid-path`、`conflict`)
 * 都意味着服务器上什么都没变,面板照原样显示就是对的;而 `result-unknown` 之后,
 * 面板上那份列表已经**可能**是假的 —— rename 也许成功了,文件树里却还挂着旧名字。
 * 提示语写的是「请先检查服务器状态」,而用户唯一用来检查的就是这个面板。
 *
 * 所以调用方必须重新去读一次服务器,不能拿本地状态当结论。注意重读**不是重试** ——
 * 它不重放那个可能已经生效的写操作,只是把「我不知道」如实画出来(断着的时候
 * 重读会失败,那一行就显示读取失败 + 可重试,而已经画出来的内容原样留着)。
 */
export function isResultUnknown(error: unknown): boolean {
  return error instanceof AgentErrorException && error.error.environmentCode === 'result-unknown'
}
