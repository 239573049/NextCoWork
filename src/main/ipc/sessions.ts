/** 会话实体 IPC：所有读写都经过 state/store，避免 handler 直接写 SQL。 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Session } from '../../shared/domain/session'
import type { AgentMessage } from '../../shared/agent/message'
import { mimeOfExt, parseNcwUrl } from '../../shared/domain/attachment'
import { ulid } from '../../shared/util/id'
import { runs } from '../kernel/run-registry'
import { windows } from '../window/registry'
import { store } from '../state/store'
import { removeSessionAttachmentFiles } from './storage'
import { uploadAttachment } from './attachment'

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

/** Replace a session transcript after an intentional user edit. */
export function replaceHistory(req: { sessionId: string; messages: AgentMessage[] }): void {
  if (runs.activeRunIds().some((id) => runs.get(id)?.sessionId === req.sessionId)) {
    throw new Error('有运行中的 Agent，请先停止任务后再编辑消息')
  }
  store.replaceHistory(req.sessionId, req.messages)
  const session = store.getSession(req.sessionId)
  changed(session?.workspaceId)
}

export function createSession(req: { workspaceId: string; title?: string; sessionId?: string }): Session {
  const ws = store.getWorkspace(req.workspaceId)
  const session = store.ensureSession({
    id: req.sessionId,
    workspaceId: req.workspaceId,
    title: req.title,
    rootPathAtCreation: ws?.rootPath ?? ''
  })
  changed(req.workspaceId)
  return session
}

/** Clone a transcript into a new session, including managed image attachments. */
export function duplicateSession(req: { sessionId: string; title: string }): Session {
  const source = store.getSessionDetail(req.sessionId)
  if (source === undefined) throw new Error(`会话不存在: ${req.sessionId}`)
  const sourceSession = source.session
  const sessionId = ulid()
  const session = store.createSession({
    id: sessionId,
    workspaceId: sourceSession.workspaceId,
    title: req.title,
    model: sourceSession.model,
    mode: sourceSession.mode,
    thinking: sourceSession.thinking,
    rootPathAtCreation: sourceSession.rootPathAtCreation
  })
  try {
    const messages = source.messages.map((message) => ({
      ...message,
      id: ulid(message.createdAt),
      parts: message.parts.map((part) => {
        if (part.type !== 'image') return part
        const locator = parseNcwUrl(part.dataRef)
        if (locator?.scope !== 'session' || locator.ownerId !== req.sessionId) return part
        const row = store.getAttachmentRowByOwnerAndFileName(req.sessionId, locator.fileName)
        if (row === undefined) return part
        const bytes = new Uint8Array(readFileSync(row.path))
        const copied = uploadAttachment({
          scope: 'session',
          ownerId: sessionId,
          displayName: row.displayName ?? basename(row.path),
          mime: mimeOfExt(row.path),
          bytes: bytes as Uint8Array<ArrayBuffer>
        })
        return { ...part, dataRef: copied.url }
      })
    }))
    store.replaceHistory(sessionId, messages)
  } catch (error) {
    const paths = store.sessionAttachmentPaths(sessionId)
    store.deleteSession(sessionId)
    removeSessionAttachmentFiles(paths)
    throw error
  }
  changed(sourceSession.workspaceId)
  return session
}

export function renameSession(req: { sessionId: string; title: string }): void {
  store.renameSession(req.sessionId, req.title)
  const session = store.getSession(req.sessionId)!
  windows.emitToAll('sessions:changed', {
    workspaceId: session.workspaceId, renamed: { sessionId: session.id, title: session.title }
  })
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
