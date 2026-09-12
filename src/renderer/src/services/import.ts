/**
 * 导入的渲染层 service —— 和 `services/data.ts` 同构的薄包装。
 *
 * ★ 一条规矩:这里**不缓存任何状态**。导入作业跑在主进程里,渲染层手上那份
 * 随时可能过期;缓存的失效时机恰好是「作业刚推进一步」,而那正是界面要重画的
 * 那一刻。所有状态都靠 `imports:changed` 事件触发重新拉取。
 */
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
} from '../../../shared/domain/import'
import type { ImportSourceKind } from '../../../shared/domain/import'
import type { Unsubscribe } from '../../../shared/ipc/contract'
import { invoke, on } from './ipc'

export function detect(sourceKind: ImportSourceKind = 'claude-code'): Promise<ImportSourceState> {
  return invoke('imports:detect', { sourceKind })
}

/** 弹系统目录选择器。★ 取消时返回当前状态,不抛错 —— 取消不是失败。 */
export function chooseSource(sourceKind: ImportSourceKind = 'claude-code'): Promise<ImportSourceState> {
  return invoke('imports:chooseSource', { sourceKind })
}

export function getState(sourceId: string): Promise<ImportSourceState> {
  return invoke('imports:getState', { sourceId })
}

export function preview(sourceId: string, requestId: string): Promise<ImportPreview> {
  return invoke('imports:preview', { sourceId, requestId })
}

export function previewItems(query: ImportPreviewQuery): Promise<ImportPreviewPage> {
  return invoke('imports:previewItems', query)
}

export function apply(request: ImportApplyRequest): Promise<ImportJobStatus> {
  return invoke('imports:apply', request)
}

export function status(sourceId: string): Promise<ImportJobStatus | null> {
  return invoke('imports:status', { sourceId })
}

export function cancel(jobId: string): Promise<void> {
  return invoke('imports:cancel', { jobId })
}

export function history(offset: number, limit: number): Promise<ImportHistoryPage> {
  return invoke('imports:history', { offset, limit })
}

export function historyItems(batchId: string, offset: number, limit: number): Promise<ImportBatchItemsPage> {
  return invoke('imports:historyItems', { batchId, offset, limit })
}

export function updateSync(sourceId: string, patch: ImportSyncPatch): Promise<ImportSourceState> {
  return invoke('imports:updateSync', { sourceId, patch })
}

export function syncNow(sourceId: string): Promise<ImportJobStatus> {
  return invoke('imports:syncNow', { sourceId })
}

export function resolveConflict(request: ImportConflictResolution): Promise<void> {
  return invoke('imports:resolveConflict', request)
}

/**
 * 订阅导入状态变化。
 *
 * ★ 回调里**只该触发一次重新拉取**,不要试图从 payload 里拼状态 ——
 * 事件是限频合并过的,两次 seq 之间可能发生了很多变化。
 */
export function onChanged(cb: (payload: { sourceId: string; jobId?: string; seq: number }) => void): Unsubscribe {
  return on('imports:changed', cb)
}
