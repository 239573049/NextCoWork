/**
 * 「改动审查」的主进程 handler —— 回复底部审查卡、右侧 `changes` tab、撤销/恢复。
 *
 * 读:直接转 `store` 的改动集访问器(schema 第 23 条)。
 * 写(撤销/恢复):走 `workspace:*` 的文档函数,它们天然覆盖本地与远程(SSH),
 *   并带 revision 乐观锁 —— 回写时用**当前磁盘的 revision**,并发冲突由底层再挡一道。
 *
 * ★ 撤销前先比对:磁盘现状的 sha256 必须等于记录里「改动后」的 hash;不等说明这个
 *   文件在那之后又被改过(后续任务块或用户手改),此时非 force 的撤销把它标 conflict
 *   跳过,由 UI 提示用户确认后再带 force 重发。
 */
import { createHash } from 'node:crypto'
import type {
  ReviewChangeSet,
  ReviewFileDiff,
  ReviewFileResult,
  ReviewMutationResult
} from '../../shared/domain/review'
import type { FileSnapshotRecord } from '../db/repo'
import { store } from '../state/store'
import { mutateWorkspaceDocument, readWorkspaceDocument, writeWorkspaceDocument } from './workspace-files'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function getReviewChangeSet(req: { runId: string }): ReviewChangeSet | null {
  return store.getFileChangeSet(req.runId) ?? null
}

export function getReviewFileDiff(req: { runId: string; path: string }): ReviewFileDiff | null {
  return store.getFileSnapshotDiff(req.runId, req.path) ?? null
}

/** 读一个工作区文本文件的当前内容与 revision;不存在 / 非文本返回 undefined。 */
async function readText(
  workspaceId: string,
  path: string
): Promise<{ content: string; revision: string } | undefined> {
  try {
    const file = await readWorkspaceDocument({ workspaceId, path })
    return file.kind === 'text' ? { content: file.content, revision: file.revision } : undefined
  } catch {
    return undefined
  }
}

/** 撤销/恢复某个文件时,磁盘现状是否与「我们要从中离开的那个状态」不符。 */
function isConflict(
  direction: 'undo' | 'redo',
  snap: FileSnapshotRecord,
  current: { content: string } | undefined
): boolean {
  if (direction === 'undo') {
    // 撤销:磁盘现状应当 == 改动后(after)
    if (current === undefined) return true
    return sha256(current.content) !== snap.afterHash
  }
  // 恢复:磁盘现状应当 == 改动前(before);新建文件的 before 是「不存在」
  if (snap.before === null) return current !== undefined
  if (current === undefined) return true
  return sha256(current.content) !== snap.beforeHash
}

/** 把一个文件恢复成目标内容;null = 让它不存在(删除,走废纸篓)。 */
async function restoreFile(workspaceId: string, path: string, content: string | null): Promise<void> {
  if (content === null) {
    try {
      await mutateWorkspaceDocument({ workspaceId, path, operation: 'delete' })
    } catch {
      // 已经不在了,当作成功。
    }
    return
  }
  let current = await readText(workspaceId, path)
  if (current === undefined) {
    // 文件缺失(如恢复一个之前撤销掉的新建文件)—— 先建空文件拿到 revision 再写。
    await mutateWorkspaceDocument({ workspaceId, path, operation: 'create-file' })
    current = await readText(workspaceId, path)
    if (current === undefined) throw new Error(`无法创建文件:${path}`)
  }
  await writeWorkspaceDocument({ workspaceId, path, content, revision: current.revision })
}

async function applyChangeSet(
  runId: string,
  direction: 'undo' | 'redo',
  force: boolean
): Promise<ReviewMutationResult> {
  const set = store.getFileChangeSet(runId)
  if (set === undefined) return { runId, state: 'applied', files: [] }

  const snaps = store.listFileSnapshots(runId)
  const files: ReviewFileResult[] = []
  for (const snap of snaps) {
    if (snap.oversize) {
      files.push({ path: snap.path, status: 'skipped', reason: 'oversize' })
      continue
    }
    if (!snap.inWorkspace) {
      files.push({ path: snap.path, status: 'skipped', reason: 'outside-workspace' })
      continue
    }
    const current = await readText(set.workspaceId, snap.path)
    if (!force && isConflict(direction, snap, current)) {
      files.push({ path: snap.path, status: 'conflict' })
      continue
    }
    try {
      // 撤销回到 before(新建文件的 before 为 null → 删除);恢复回到 after。
      await restoreFile(set.workspaceId, snap.path, direction === 'undo' ? snap.before : snap.after)
      files.push({ path: snap.path, status: 'ok' })
    } catch (error) {
      files.push({ path: snap.path, status: 'error', reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const nextState = direction === 'undo' ? 'reverted' : 'applied'
  const changed = files.some((f) => f.status === 'ok')
  if (changed) store.setChangeSetState(runId, nextState, Date.now())
  return { runId, state: changed ? nextState : set.state, files }
}

/** 撤销前的比对:返回磁盘现状已与记录不符的文件路径,供 UI 提示确认。 */
export async function precheckReviewUndo(req: { runId: string }): Promise<{ conflicts: string[] }> {
  const set = store.getFileChangeSet(req.runId)
  if (set === undefined) return { conflicts: [] }
  const conflicts: string[] = []
  for (const snap of store.listFileSnapshots(req.runId)) {
    if (snap.oversize || !snap.inWorkspace) continue
    const current = await readText(set.workspaceId, snap.path)
    if (isConflict('undo', snap, current)) conflicts.push(snap.path)
  }
  return { conflicts }
}

export function undoReviewChangeSet(req: { runId: string; force?: boolean }): Promise<ReviewMutationResult> {
  return applyChangeSet(req.runId, 'undo', req.force === true)
}

export function redoReviewChangeSet(req: { runId: string }): Promise<ReviewMutationResult> {
  // 恢复只在「已撤销」态下由 UI 提供;磁盘此刻应当是 before,直接回写 after。
  return applyChangeSet(req.runId, 'redo', true)
}
