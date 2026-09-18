import type {
  ReviewChangeSet,
  ReviewFileDiff,
  ReviewMutationResult
} from '../../../shared/domain/review'
import { invoke } from './ipc'

/** 某一轮(顶层 run)的改动集摘要;这一轮没改过文件时为 null。 */
export function getReviewChangeSet(runId: string): Promise<ReviewChangeSet | null> {
  return invoke('review:getChangeSet', { runId })
}

/** 单文件的 before/after 全文,diff 预览用。 */
export function getReviewFileDiff(runId: string, path: string): Promise<ReviewFileDiff | null> {
  return invoke('review:getFileDiff', { runId, path })
}

/** 撤销前的比对:返回磁盘现状已与记录不符的文件路径。 */
export function precheckReviewUndo(runId: string): Promise<{ conflicts: string[] }> {
  return invoke('review:precheckUndo', { runId })
}

/** 撤销整轮改动。有冲突且未 force 时,冲突文件在结果里标 conflict、不回写。 */
export function undoReviewChangeSet(runId: string, force = false): Promise<ReviewMutationResult> {
  return invoke('review:undo', { runId, force })
}

/** 恢复(redo)整轮改动。 */
export function redoReviewChangeSet(runId: string): Promise<ReviewMutationResult> {
  return invoke('review:redo', { runId })
}
