import type { WorkspaceFile, WorkspaceFileMutationRequest, WorkspaceFileMutationResult, WorkspaceFileWriteRequest, WorkspaceRecoveryListing } from '../../../shared/domain/workspace-file'
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
 * 打开一条**文件引用**之前的预检：`null` = 打得开。
 *
 * 需求：点开 Markdown 链接 / 消息里的 `file_ref` / 行内 `@` 引用之前先问一句
 * 「它还打得开吗」—— 打不开就**别在右侧工作台开一个只会显示错误的 Tab**，
 * 那个 Tab 还占着一个位置、要用户自己去关。引用是**发送那一刻的快照**，
 * 文件后来被删掉、改名是常态。
 *
 * ★ 判定方式是**真读一次**，而不是单独 stat 一遍：一条引用能不能打开取决于
 * `workspace:readFile` 那一整套判定（存在、是普通文件、不是软链、能解码、没超上限），
 * 而 stat 只回答其中一问 —— 于是「预检说能开」和「打开是空的」会分叉。
 * 代价是多读一次内容（引用到的多是几十 KB 的源码）。如果这条开销哪天显出来
 * （工作区挂在 SSH 上、引用的是十几兆的图片），正确的做法是给主进程加一条只做
 * stat 的频道，**不要**在这里按扩展名加特判。
 *
 * 返回的是**一个 i18n key**而不是译好的句子：三个调用点（Markdown 链接、
 * `file_ref`、`@` 引用）分处三个组件，各自拼一句话的话，同一个「文件不存在」
 * 迟早会有三种说法，而且新码加进 `workspaceFileErrorKey` 时总有一处忘了跟。
 */
export async function workspaceFileOpenFailure(workspaceId: string, path: string): Promise<TranslationKey | null> {
  try {
    await readWorkspaceFile(workspaceId, path)
    return null
  } catch (error) {
    return workspaceFileErrorKey(error)
  }
}

/**
 * 可恢复的删除项。★ 从**服务器上的索引**读,不从任何客户端状态读 —— 刷新、切子树根、
 * 重连、重启应用之后它都还在,而组件 state 三种都活不过。
 */
export function listWorkspaceRecovery(workspaceId: string): Promise<WorkspaceRecoveryListing> {
  return invoke('workspace:listRecovery', { workspaceId })
}

// 返回类型随契约放宽为 WorkspaceFile:base64(图片)支线返回 image 形状。
// 存量文本调用方只读 revision / content,不受影响。
export async function writeWorkspaceFile(req: WorkspaceFileWriteRequest): Promise<WorkspaceFile> {
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
