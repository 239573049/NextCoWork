/** 文件工作台只接受工作区相对路径；不会向渲染层返回磁盘绝对路径。 */
export interface WorkspaceFileRequest {
  workspaceId: string
  path: string
}

interface WorkspaceFileBase {
  path: string
  size: number
  /** 当前文件字节的摘要；保存必须带回它以防覆盖外部修改。 */
  revision: string
}

export interface WorkspaceTextFile extends WorkspaceFileBase {
  kind: 'text'
  /** UTF-8 原文，保留 BOM 和原始换行。 */
  content: string
}

export type WorkspaceFile =
  | WorkspaceTextFile
  | (WorkspaceFileBase & { kind: 'image'; mime: string; dataUrl: string })
  | (WorkspaceFileBase & { kind: 'binary'; reason: 'unsupported' | 'too-large' | 'encoding' })

export interface WorkspaceFileWriteRequest extends WorkspaceFileRequest {
  content: string
  revision: string
}

export type WorkspaceFileOperation =
  | 'create-file'
  | 'create-directory'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete'

export interface WorkspaceFileMutationRequest extends WorkspaceFileRequest {
  operation: WorkspaceFileOperation
  /** rename/move/copy 的完整工作区相对目标路径；始终拒绝覆盖。 */
  destination?: string
}

export interface WorkspaceFileMutationResult {
  path: string
  destination?: string
}

/** 作为 IpcResult.error.message 的机器标识传输，UI 通过 i18n 映射。 */
export const WORKSPACE_FILE_ERROR_PREFIX = 'workspace_file:'
export type WorkspaceFileErrorCode =
  | 'not-found'
  | 'exists'
  | 'invalid-path'
  | 'symlink'
  | 'permission'
  | 'conflict'
  | 'too-large'
  | 'not-file'
  | 'invalid-encoding'
  | 'unsupported'
  | 'io'
  | 'workspace-unavailable'

export const WORKSPACE_TEXT_LIMIT = 2 * 1024 * 1024
export const WORKSPACE_IMAGE_LIMIT = 16 * 1024 * 1024
