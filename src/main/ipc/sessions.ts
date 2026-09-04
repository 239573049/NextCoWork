/** 会话实体 IPC：所有读写都经过 state/store，避免 handler 直接写 SQL。 */
import type { Session } from '../../shared/domain/session'
import { runs } from '../kernel/run-registry'
import { windows } from '../window/registry'
import { store } from '../state/store'

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
  if (runs.activeRunIds().some((id) => runs.get(id)?.sessionId === req.sessionId)) {
    throw new Error('有运行中的 Agent，请先停止任务后再删除会话')
  }
  store.deleteSession(req.sessionId)
  changed()
}

export function searchAll(req: { q: string; workspaceId?: string; limit: number }) {
  return store.searchSessions(req.q, req.workspaceId, req.limit)
}
