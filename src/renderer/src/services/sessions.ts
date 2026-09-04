import type { Session, SessionDetail, SessionListItem, SearchHit } from '../../../shared/domain/session'
import { invoke } from './ipc'

export function listSessions(workspaceId: string, archived?: boolean): Promise<SessionListItem[]> {
  return invoke('sessions:list', archived === undefined ? { workspaceId } : { workspaceId, archived })
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  return invoke('sessions:get', { sessionId })
}

export function createSession(workspaceId: string, title?: string, sessionId?: string): Promise<Session> {
  return invoke('sessions:create', { workspaceId, ...(title === undefined ? {} : { title }), ...(sessionId === undefined ? {} : { sessionId }) })
}

export function duplicateSession(sessionId: string, title: string): Promise<Session> {
  return invoke('sessions:duplicate', { sessionId, title })
}

export function renameSession(sessionId: string, title: string): Promise<void> {
  return invoke('sessions:rename', { sessionId, title })
}

export function setArchived(sessionId: string, archived: boolean): Promise<void> {
  return invoke('sessions:setArchived', { sessionId, archived })
}

export function setFavorited(sessionId: string, favorited: boolean): Promise<void> {
  return invoke('sessions:setFavorited', { sessionId, favorited })
}

export function deleteSession(sessionId: string): Promise<void> {
  return invoke('sessions:delete', { sessionId })
}

export function searchAll(q: string, workspaceId?: string, limit = 50): Promise<SearchHit[]> {
  return invoke('conversations:searchAll', workspaceId === undefined ? { q, limit } : { q, workspaceId, limit })
}
