/** 会话实体 IPC：所有读写都经过 state/store，避免 handler 直接写 SQL。 */
import type { Session } from '../../shared/domain/session'
import { runs } from '../kernel/run-registry'
import { windows } from '../window/registry'
import { store } from '../state/store'
import { removeSessionAttachmentFiles } from './storage'

function changed(workspaceId?: string): void {
  windows.emitToAll('sessions:changed', workspaceId === undefined ? {} : { workspaceId })
}

export function listSessions(req: { workspaceId: string; archived?: boolean }) {
  const activeSessionIds = new Set(
    runs.activeRunIds().map((id) => runs.get(id)?.sessionId).filter((id): id is string => id !== undefined)
  )
  return store.listSessions(req.workspaceId, req.archived).map((item) => ({
    ...item,
    running: activeSessionIds.has(item.id)
  }))
}

export function getSession(req: { sessionId: string }) {
  const detail = store.getSessionDetail(req.sessionId)
  if (detail === undefined) throw new Error(`会话不存在: ${req.sessionId}`)
  return detail
}

export function createSession(req: { workspaceId: string; title?: string; sessionId?: string }): Session {
  const ws = store.getWorkspace(req.workspaceId)
  const session = store.createSession({
    id: req.sessionId,
    workspaceId: req.workspaceId,
    title: req.title,
    rootPathAtCreation: ws?.rootPath ?? ''
  })
  changed(req.workspaceId)
  return session
}

export function renameSession(req: { sessionId: string; title: string }): void {
  store.renameSession(req.sessionId, req.title)
  changed()
}

export function setArchived(req: { sessionId: string; archived: boolean }): void {
  store.setSessionArchived(req.sessionId, req.archived)
  changed()
}

export function setFavorited(req: { sessionId: string; favorited: boolean }): void {
  store.setSessionFavorited(req.sessionId, req.favorited)
  changed()
}

export function deleteSession(req: { sessionId: string }): void {
  // Deleting one session while another run is still writing can race the
  // shared database snapshot/attachment cleanup (and makes a later restore or
  // clear-history operation ambiguous). Treat session deletion as the same
  // high-risk operation as the bulk data actions: any active Agent blocks it.
  if (runs.activeRunIds().length > 0) {
    throw new Error('有运行中的 Agent，请先停止任务后再删除会话')
  }
  // Capture paths before the database cascade removes their rows.  The
  // storage helper re-checks remaining references after deletion, so a file
  // shared by an older/migrated record is never removed prematurely.
  const attachmentPaths = requireSessionAttachmentPaths(req.sessionId)
  store.deleteSession(req.sessionId)
  const physical = removeSessionAttachmentFiles(attachmentPaths)
  if (physical.undeletable.length > 0) {
    console.warn('[sessions] 会话附件未能全部删除:', physical.undeletable)
  }
  changed()
}

function requireSessionAttachmentPaths(sessionId: string): string[] {
  // Keep SQL out of the handler; the store/repository owns the attachment
  // shape and this small accessor is exposed through the storage boundary.
  return store.sessionAttachmentPaths(sessionId)
}

export function searchAll(req: { q: string; workspaceId?: string; limit: number }) {
  return store.searchSessions(req.q, req.workspaceId, req.limit)
}
