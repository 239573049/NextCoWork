/**
 * 导入的 IPC 一侧 —— 薄转发层。
 *
 * ★ 这里**只做参数搬运和权限边界**,一条业务规则都不写。理由和别的 handler
 * 一样:业务逻辑写在这里的话,自动同步那条路径(它不经过 IPC)就会绕过它,
 * 而绕过的方式是静默的。
 */
import { dialog } from 'electron'
import type {
  ImportApplyRequest,
  ImportBatchItemsPage,
  ImportConflictResolution,
  ImportHistoryPage,
  ImportJobStatus,
  ImportPreview,
  ImportPreviewPage,
  ImportPreviewQuery,
  ImportSourceState,
  ImportSyncPatch
} from '../../shared/domain/import'
import type { ImportSourceKind } from '../../shared/domain/import'
import { IMPORT_LIMITS } from '../../shared/domain/import'
import { store } from '../state/store'
import {
  applyImport,
  buildPreview,
  cancelImportJob,
  detectImportSource,
  getImportSourceState,
  importHistory,
  importHistoryItems,
  jobStatusFor,
  previewItems,
  updateImportSync
} from '../imports/service'
import { syncImportSourceNow } from '../imports/sync'
import { IpcError } from './errors'

export function detectImports(req: { sourceKind: ImportSourceKind }): Promise<ImportSourceState> {
  return detectImportSource(undefined, req.sourceKind)
}

/**
 * 让用户自己指定配置目录。★ 路径来自主进程的 `showOpenDialog`,
 * 渲染层永不指定任意路径(方案 §9)。取消时回当前状态,不报错 ——
 * 取消不是失败。
 */
export async function chooseImportSource(req: { sourceKind: ImportSourceKind }): Promise<ImportSourceState> {
  const picked = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  const dir = picked.canceled ? undefined : picked.filePaths[0]
  return detectImportSource(dir, req.sourceKind)
}

export function getImportState(req: { sourceId: string }): ImportSourceState {
  return getImportSourceState(req.sourceId)
}

export function previewImports(req: { sourceId: string; requestId: string }): Promise<ImportPreview> {
  return buildPreview(req.sourceId, req.requestId)
}

export function listPreviewItems(req: ImportPreviewQuery): ImportPreviewPage {
  return previewItems({ ...req, limit: Math.min(req.limit, IMPORT_LIMITS.pageSize) })
}

export function applyImports(req: ImportApplyRequest): Promise<ImportJobStatus> {
  if (req.itemIds.length === 0) throw new IpcError('unknown', '没有选择任何要导入的内容')
  return applyImport(req)
}

export function importJobStatus(req: { sourceId: string }): ImportJobStatus | null {
  return jobStatusFor(req.sourceId)
}

export function cancelImport(req: { jobId: string }): void {
  cancelImportJob(req.jobId)
}

export function listImportHistory(req: { offset: number; limit: number }): ImportHistoryPage {
  return importHistory(req.offset, req.limit)
}

export function listImportHistoryItems(req: {
  batchId: string
  offset: number
  limit: number
}): ImportBatchItemsPage {
  return importHistoryItems(req.batchId, req.offset, req.limit)
}

export function updateImportSyncSettings(req: {
  sourceId: string
  patch: ImportSyncPatch
}): ImportSourceState {
  return updateImportSync(req.sourceId, req.patch)
}

export function syncImportsNow(req: { sourceId: string }): Promise<ImportJobStatus> {
  return syncImportSourceNow(req.sourceId)
}

/**
 * 冲突处置。★ 两种取值都**不覆盖本地**:
 * `keep-local` 解除该项的同步,`save-as` 另存一份新名。
 * 「用源覆盖本地」不在类型里,所以这个函数也没有那条分支。
 */
export function resolveImportConflict(req: ImportConflictResolution): void {
  const kinds = ['session', 'skill', 'agent', 'command', 'instructions', 'mcp', 'provider', 'alias', 'hook'] as const
  for (const kind of kinds) {
    const mapping = store.getImportMapping(req.sourceId, '', kind, req.itemId)
    if (mapping === undefined) continue
    if (req.action === 'keep-local') {
      // 保留本地并**解除该项同步** —— detached 是永久的,不会被下一轮拉回去。
      store.putImportMapping({ ...mapping, syncState: 'detached', updatedAt: Date.now() })
      return
    }
    // save-as 的另存动作由用户在对应功能页完成(技能/命令各有自己的新建入口)。
    // 这里只把该项标成不再跟随,避免下一轮又报同一个冲突。
    store.putImportMapping({ ...mapping, syncState: 'detached', updatedAt: Date.now() })
    return
  }
  throw new IpcError('unknown', `找不到该冲突项: ${req.itemId}`)
}
