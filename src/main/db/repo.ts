/**
 * 领域对象的读写。**`state/store.ts` 唯一的后端** —— 那边的访问器逐个转发到这里,
 * 签名一个都没改,所以全应用的调用点一处都不用动。
 *
 * 函数名刻意和 `store` 的访问器一一对应:换实现时能逐行对照,
 * 而不是要先在脑子里做一次映射。
 *
 * ## 一处**行为**上的变化,值得单独说
 *
 * Map 版的 `getWorkspace` 返回的是表里那个**活对象**,改它就等于改了库;
 * 这里返回的是一次 `JSON.parse` 的产物,改它谁也不影响。
 * 方向是安全的(意外的写入变成无效果,而不是意外生效),而且和 `getSettings`
 * 一直以来的 `structuredClone` 语义终于一致了。已核对现有两个调用点
 * (`ipc/workspace.ts` 的 `updateWorkspace` / `listDir`)都是展开取值,不改返回对象。
 */
import type { AgentMessage, ContentPart } from '../../shared/agent/message'
import { parseNcwUrl } from '../../shared/domain/attachment'
import type { McpServerConfig } from '../../shared/domain/mcp'
import { mcpSecretRef } from '../../shared/domain/mcp'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import { normalizeUpstreamProvider } from '../../shared/domain/provider'
import type { SearchProviderConfig, SearchProviderId } from '../../shared/domain/search'
import { defaultProviderConfigs, searchSecretRef } from '../../shared/domain/search'
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/domain/settings'
import type { CleanupPreview, CleanupResult, DataExport, ExportSession, ImportApplyResult } from '../../shared/domain/data'
import type { Session, SessionDetail, SessionListItem, SearchHit } from '../../shared/domain/session'
import type { SessionMode, ThinkingLevel } from '../../shared/agent/run-request'
import type { Workspace } from '../../shared/domain/workspace'
import { fileStats, stmt, tx } from './index'
import { ulid } from '../../shared/util/id'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export { tx } from './index'

/** 列里存的是 JSON 文本;`String()` 是给 `SQLOutputValue` 那个联合类型收窄用的。 */
const parse = <T>(json: unknown): T => JSON.parse(String(json)) as T

// ── settings ────────────────────────────────────────────────────────────────

/**
 * ★ 读出来的值是**合并到 `DEFAULT_SETTINGS` 上**的,不是直接返回。
 *
 * 这样旧版本存下的行缺了新字段时,拿到的是新字段的默认值,而不是 `undefined`
 * 顺着 IPC 流到界面上变成一个空下拉框。下一步就要用到:方案 §7 要把
 * `gateway.failover` 改名成 `routing.failover`,那之后所有已经存在的行都缺 `routing`。
 *
 * `mergeSettings` 是逐字段展开的(还带一张编译期哨兵表),所以它顺带也把
 * **已经删掉的字段**挡在外面 —— 它只认识 `AppSettings` 上真实存在的键。
 */
export function getSettings(): AppSettings {
  const row = stmt('SELECT json FROM settings WHERE id = 1').get()
  if (row === undefined) return structuredClone(DEFAULT_SETTINGS)
  let patch: AppSettingsPatch = {}
  try {
    const value: unknown = JSON.parse(String(row['json']))
    // 设置行是用户本机可编辑的数据。损坏的 JSON、null、数组和标量都
    // 应当回到默认设置，而不是让整个 bootstrap 失败。
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      patch = value as AppSettingsPatch
    }
  } catch (err) {
    console.warn('[db] 设置记录损坏，已回退默认值:', err)
  }
  return mergeSettings(DEFAULT_SETTINGS, patch)
}

export function updateSettings(patch: AppSettingsPatch): AppSettings {
  // 读-改-写要在一个事务里:否则两个 handler 同时改不同字段时,后写的那个
  // 拿的是改之前的快照,会把前一个的改动原样覆盖回去。
  return tx(() => {
    const next = mergeSettings(getSettings(), patch)
    stmt(
      'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json'
    ).run(JSON.stringify(next))
    return next
  })
}

// ── workspaces ──────────────────────────────────────────────────────────────

export function listWorkspaces(): Workspace[] {
  return stmt('SELECT json FROM workspaces ORDER BY last_opened_at DESC')
    .all()
    .map((r) => parse<Workspace>(r['json']))
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = stmt('SELECT json FROM workspaces WHERE id = ?').get(id)
  return row === undefined ? undefined : parse<Workspace>(row['json'])
}

export function putWorkspace(w: Workspace): Workspace {
  stmt(
    `INSERT INTO workspaces (id, last_opened_at, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_opened_at = excluded.last_opened_at, json = excluded.json`
  ).run(w.id, w.lastOpenedAt, JSON.stringify(w))
  return w
}

export function removeWorkspace(id: string): void {
  stmt('DELETE FROM workspaces WHERE id = ?').run(id)
}

// ── sessions / messages / runs ─────────────────────────────────────────────

export interface SessionCreateInput {
  id?: string
  workspaceId: string
  title?: string
  model?: string
  mode?: SessionMode
  thinking?: ThinkingLevel
  rootPathAtCreation?: string
  createdAt?: number
}

function sessionFromRow(row: Record<string, unknown>): Session {
  let parsed: Partial<Session> = {}
  try {
    parsed = parse<Partial<Session>>(row['json'])
  } catch {
    // 旧/损坏的 json 仍可由提列字段恢复，避免整个侧边栏消失。
  }
  return {
    id: String(row['id']),
    workspaceId: String(row['workspace_id']),
    title: String(row['title'] ?? parsed.title ?? '新对话'),
    model: String(row['model'] ?? parsed.model ?? ''),
    mode: (row['mode'] ?? parsed.mode ?? 'normal') as SessionMode,
    thinking: (row['thinking'] ?? parsed.thinking ?? 'auto') as ThinkingLevel,
    rootPathAtCreation: String(row['root_path_at_creation'] ?? parsed.rootPathAtCreation ?? ''),
    // running 永不从磁盘恢复；启动和读取都视为 idle。
    status: 'idle',
    archived: Number(row['archived'] ?? (parsed.archived ? 1 : 0)) !== 0,
    favorited: Number(row['favorited'] ?? (parsed.favorited ? 1 : 0)) !== 0,
    createdAt: Number(row['created_at'] ?? parsed.createdAt ?? Date.now()),
    updatedAt: Number(row['updated_at'] ?? parsed.updatedAt ?? Date.now())
  }
}

function sessionRowJson(s: Session): string {
  return JSON.stringify({ ...s, status: s.status === 'running' ? 'idle' : s.status })
}

/** 创建或补齐一条会话。运行链路和渲染层都可安全调用。 */
export function createSession(input: SessionCreateInput): Session {
  const now = input.createdAt ?? Date.now()
  const session: Session = {
    id: input.id ?? ulid(now),
    workspaceId: input.workspaceId,
    title: input.title?.trim() || '新对话',
    model: input.model ?? '',
    mode: input.mode ?? 'normal',
    thinking: input.thinking ?? 'auto',
    rootPathAtCreation: input.rootPathAtCreation ?? '',
    status: 'idle',
    archived: false,
    favorited: false,
    createdAt: now,
    updatedAt: now
  }
  return putSession(session)
}

/** 不存在时创建，存在时返回现有记录；用于 renderer 先生成 id 的 Tab。 */
export function ensureSession(input: SessionCreateInput): Session {
  if (input.id !== undefined) {
    const existing = getSession(input.id)
    if (existing !== undefined) return existing
  }
  return createSession(input)
}

export function getSession(id: string): Session | undefined {
  const row = stmt('SELECT * FROM sessions WHERE id = ?').get(id)
  return row === undefined ? undefined : sessionFromRow(row as Record<string, unknown>)
}

export function putSession(session: Session): Session {
  const normalized: Session = {
    ...session,
    status: 'idle',
    title: session.title.trim() || '新对话'
  }
  stmt(
    `INSERT INTO sessions
       (id, workspace_id, title, model, mode, thinking, root_path_at_creation, status,
        archived, favorited, created_at, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       title = excluded.title,
       model = excluded.model,
       mode = excluded.mode,
       thinking = excluded.thinking,
       root_path_at_creation = excluded.root_path_at_creation,
       status = 'idle',
       archived = excluded.archived,
       favorited = excluded.favorited,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       json = excluded.json`
  ).run(
    normalized.id,
    normalized.workspaceId,
    normalized.title,
    normalized.model,
    normalized.mode,
    normalized.thinking,
    normalized.rootPathAtCreation,
    normalized.archived ? 1 : 0,
    normalized.favorited ? 1 : 0,
    normalized.createdAt,
    normalized.updatedAt,
    sessionRowJson(normalized)
  )
  return normalized
}

export function listSessions(workspaceId: string, archived?: boolean): SessionListItem[] {
  const rows = archived === undefined
    ? stmt('SELECT id, title, updated_at, archived FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC').all(workspaceId)
    : stmt('SELECT id, title, updated_at, archived FROM sessions WHERE workspace_id = ? AND archived = ? ORDER BY updated_at DESC, id DESC').all(workspaceId, archived ? 1 : 0)
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    const id = String(r['id'])
    return {
      id,
      title: String(r['title']),
      updatedAt: Number(r['updated_at']),
      archived: Number(r['archived']) !== 0,
      favorited: Boolean(Number((getSession(id) as Session | undefined)?.favorited ?? 0)),
      running: false
    }
  })
}

export function getSessionDetail(id: string): SessionDetail | undefined {
  const session = getSession(id)
  if (session === undefined) return undefined
  return { session, messages: getHistory(id) as AgentMessage[] }
}

export function listAllSessionDetails(): ExportSession[] {
  return stmt('SELECT id FROM sessions ORDER BY updated_at DESC, id DESC').all().flatMap((row) => {
    const id = String((row as Record<string, unknown>)['id'])
    const detail = getSessionDetail(id)
    return detail === undefined ? [] : [{ session: detail.session, messages: [...detail.messages] }]
  })
}

export function renameSession(id: string, title: string): void {
  const current = getSession(id)
  if (current === undefined) throw new Error(`会话不存在: ${id}`)
  putSession({ ...current, title: title.trim() || '新对话', updatedAt: Date.now() })
}

export function setSessionArchived(id: string, archived: boolean): void {
  const current = getSession(id)
  if (current === undefined) throw new Error(`会话不存在: ${id}`)
  putSession({ ...current, archived, updatedAt: Date.now() })
}

export function setSessionFavorited(id: string, favorited: boolean): void {
  const current = getSession(id)
  if (current === undefined) throw new Error(`会话不存在: ${id}`)
  putSession({ ...current, favorited, updatedAt: Date.now() })
}

function textForParts(parts: readonly ContentPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'thinking') chunks.push(part.text)
    else if (part.type === 'tool_call') chunks.push(part.name, JSON.stringify(part.input))
    else if (part.type === 'tool_result') chunks.push(part.output.content)
    else if (part.type === 'subagent' && part.summary) chunks.push(part.summary)
    else if (part.type === 'error') chunks.push(part.error.message)
  }
  return chunks.filter(Boolean).join('\n')
}

function upsertFts(session: Session, message: AgentMessage): void {
  stmt('DELETE FROM messages_fts WHERE message_id = ?').run(message.id)
  stmt('INSERT INTO messages_fts (message_id, session_id, title, content) VALUES (?, ?, ?, ?)').run(
    message.id,
    session.id,
    session.title,
    textForParts(message.parts)
  )
}

/**
 * 消息里的图片引用落库。
 *
 * ## 两类 dataRef,两条路
 *
 * - **`ncw://` URL** —— 由本应用的上传服务产出。这类附件**已经有一条 draft 行**了
 *   (上传那一刻就登记了),这里要做的是把它升为 `committed` 并补上
 *   `session_id` / `message_id` —— 那两列有外键,而上传时会话/消息都还不存在。
 *   **绝不能再 INSERT 一条**:同一个文件两条记录,清理时会按其中一条判活、
 *   另一条永远是"文件不存在"的死记录。
 *
 * - **绝对路径** —— Agent 产出的图、历史数据、从别处引用的文件。它们不受
 *   附件服务管理,沿用原来的「按 `messageId:index` 登记一条」的方式。
 *
 * ★ 从 URL 反推主键**不需要知道附件根在哪**:磁盘文件名就是
 * `<attachmentId><ext>`,去掉扩展名就是 id。这让 repo 层不必依赖 `electron`。
 */
interface ManagedAttachmentCandidate {
  row: AttachmentRow
  index: number
}

function attachmentRowsForMessage(messageId: string): AttachmentRow[] {
  return stmt('SELECT * FROM attachments WHERE message_id = ? ORDER BY id').all(messageId).map(toAttachmentRow)
}

/**
 * Attach a managed file to one message without moving an existing reference.
 *
 * Upload de-duplication intentionally returns one id while an attachment is
 * still a draft. Once that draft is committed, a second message may refer to
 * the same URL. The old one-row implementation updated `message_id` in place,
 * silently detaching the first message. Reuse an existing row for this message
 * when possible, claim an uncommitted draft otherwise, and create a stable
 * reference row for every additional message/part.
 */
function commitManagedAttachment(
  candidate: AttachmentRow,
  session: Session,
  message: AgentMessage,
  index: number,
  usedIds: Set<string>,
  currentRows: AttachmentRow[]
): string {
  const reusable = currentRows.find(
    (row) => !usedIds.has(row.id) && row.scope === 'session' && row.ownerId === session.id && row.path === candidate.path
  )
  if (reusable !== undefined) {
    if (reusable.status !== 'committed' || reusable.sessionId !== session.id) {
      stmt(
        `UPDATE attachments SET status = 'committed', session_id = ?, owner_id = ?
         WHERE id = ? AND scope = 'session' AND owner_id = ? AND message_id = ?`
      ).run(session.id, session.id, reusable.id, session.id, message.id)
    }
    usedIds.add(reusable.id)
    return reusable.id
  }

  const canClaimDraft =
    !usedIds.has(candidate.id) &&
    candidate.scope === 'session' &&
    candidate.ownerId === session.id &&
    candidate.status === 'draft' &&
    candidate.sessionId === null &&
    candidate.messageId === null
  if (canClaimDraft) {
    stmt(
      `UPDATE attachments SET status = 'committed', message_id = ?, session_id = ?, owner_id = ?
       WHERE id = ? AND scope = 'session' AND owner_id = ? AND status = 'draft'
         AND message_id IS NULL AND session_id IS NULL`
    ).run(message.id, session.id, session.id, candidate.id, session.id)
    usedIds.add(candidate.id)
    return candidate.id
  }

  // A deterministic id makes message replay idempotent. If a malicious or
  // legacy record already occupies it, include the source id and increment
  // until the existing row is either the same reference or a free key.
  const baseId = `${message.id}:managed:${String(index)}`
  let id = baseId
  let suffix = 0
  while (true) {
    const existing = getAttachmentRow(id)
    if (existing === undefined) break
    if (
      existing.scope === 'session' &&
      existing.ownerId === session.id &&
      existing.messageId === message.id &&
      existing.path === candidate.path
    ) {
      usedIds.add(id)
      return id
    }
    suffix++
    id = `${baseId}:${candidate.id}:${String(suffix)}`
  }

  stmt(
    `INSERT INTO attachments
       (id, session_id, message_id, path, size, checksum, scope, status, owner_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'session', 'committed', ?, ?, ?)`
  ).run(
    id,
    session.id,
    message.id,
    candidate.path,
    candidate.size,
    candidate.checksum,
    session.id,
    candidate.displayName,
    message.createdAt
  )
  usedIds.add(id)
  return id
}

function recordMessageAttachments(session: Session, message: AgentMessage): void {
  const imageParts = message.parts.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image')

  // 受管理的(ncw://)与外部的(绝对路径)分开处理
  const managed: ManagedAttachmentCandidate[] = []
  const external: Array<{ part: Extract<ContentPart, { type: 'image' }>; index: number }> = []
  imageParts.forEach((part, index) => {
    const loc = parseNcwUrl(part.dataRef)
    if (loc === null) {
      external.push({ part, index })
      return
    }

    // A renderer can construct an otherwise valid ncw:// URL for another
    // session. Never let that URL re-home an attachment into this message;
    // theme/export assets likewise do not belong to transcript data.
    if (loc.scope !== 'session' || loc.ownerId !== session.id) return

    const candidateId = attachmentIdOfFileName(loc.fileName)
    const row = getAttachmentRow(candidateId)
    if (
      row !== undefined &&
      row.scope === 'session' &&
      row.ownerId === session.id &&
      basename(row.path) === loc.fileName
    ) {
      managed.push({ row, index })
      return
    }

    // Be tolerant of old/migrated rows whose primary key and file basename
    // diverged. Owner and basename are both required before claiming a row.
    const fallback = findAttachmentByOwnerAndFileName(session.id, loc.fileName)
    if (fallback !== undefined) managed.push({ row: fallback, index })
  })

  const currentRows = attachmentRowsForMessage(message.id)
  const usedIds = new Set<string>()
  const managedIds = managed.map(({ row, index }) =>
    commitManagedAttachment(row, session, message, index, usedIds, currentRows)
  )

  for (const { part, index } of external) {
    const path = part.dataRef
    let size = 0
    let checksum: string | null = null
    try {
      const st = statSync(path)
      if (st.isFile()) {
        size = st.size
        // 附件通常很小，保存校验和能在清理/诊断时区分「同名被替换」；
        // 读取失败时仍保留引用，不能把一条合法消息写入变成失败。
        try { checksum = createHash('sha256').update(readFileSync(path)).digest('hex') } catch { /* 仅缺校验和 */ }
      }
    } catch {
      // 引用可能来自另一台设备；保留记录，清理时会报告文件不存在。
    }
    const id = `${message.id}:${String(index)}`
    stmt(
      `INSERT INTO attachments (id, session_id, message_id, path, size, checksum, scope, status, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'session', 'committed', ?, ?)
       ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id,
         message_id = excluded.message_id, path = excluded.path, size = excluded.size,
         checksum = excluded.checksum, created_at = excluded.created_at`
    ).run(id, session.id, message.id, path, size, checksum, session.id, message.createdAt)
  }

  const externalIds = external.map(({ index }) => `${message.id}:${String(index)}`)
  const keepIds = [...new Set([...managedIds, ...externalIds])]
  if (keepIds.length === 0) {
    stmt('DELETE FROM attachments WHERE message_id = ?').run(message.id)
  } else {
    stmt(`DELETE FROM attachments WHERE message_id = ? AND id NOT IN (${keepIds.map(() => '?').join(',')})`).run(message.id, ...keepIds)
  }
}

/** `01J8X.png` → `01J8X`。磁盘文件名的主干就是附件主键 */
function attachmentIdOfFileName(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i <= 0 ? fileName : fileName.slice(0, i)
}

/** message_commit 的唯一落盘入口；同一 message id 重放时幂等。 */
function writeMessage(session: Session, message: AgentMessage, ordinal: number): void {
  const existing = stmt('SELECT session_id FROM messages WHERE id = ?').get(message.id) as Record<string, unknown> | undefined
  if (existing !== undefined && String(existing['session_id']) !== session.id) {
    throw new Error(`消息 ${message.id} 已属于另一个会话`)
  }
  stmt(
    `INSERT INTO messages (id, session_id, ordinal, role, parts, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET ordinal = excluded.ordinal, parts = excluded.parts, role = excluded.role,
       schema_version = excluded.schema_version, created_at = excluded.created_at`
  ).run(
    message.id,
    session.id,
    ordinal,
    message.role,
    JSON.stringify(message.parts),
    message.schemaVersion,
    message.createdAt
  )
  upsertFts(session, message)
  recordMessageAttachments(session, message)
  putSession({ ...session, updatedAt: Math.max(session.updatedAt, message.createdAt) })
}

export function commitMessage(sessionId: string, message: AgentMessage): void {
  tx(() => {
    const session = getSession(sessionId)
    if (session === undefined) throw new Error(`会话不存在: ${sessionId}`)
    const existing = stmt('SELECT session_id, ordinal FROM messages WHERE id = ?').get(message.id) as Record<string, unknown> | undefined
    if (existing !== undefined && String(existing['session_id']) !== sessionId) {
      throw new Error(`消息 ${message.id} 已属于另一个会话`)
    }
    const ordinal = existing === undefined
      ? Number((stmt('SELECT COALESCE(MAX(ordinal), -1) AS n FROM messages WHERE session_id = ?').get(sessionId) as Record<string, unknown>)['n'] ?? -1) + 1
      : Number(existing['ordinal'])
    writeMessage(session, message, ordinal)
  })
}

export function getHistory(sessionId: string): readonly AgentMessage[] {
  return stmt('SELECT id, role, parts, schema_version, created_at FROM messages WHERE session_id = ? ORDER BY ordinal, id').all(sessionId).map((row) => {
    const r = row as Record<string, unknown>
    const parts: ContentPart[] = (() => {
      try { return parse<ContentPart[]>(r['parts']) } catch { return [] }
    })()
    return {
      id: String(r['id']),
      role: String(r['role']) as AgentMessage['role'],
      parts,
      createdAt: Number(r['created_at']),
      schemaVersion: Number(r['schema_version'] ?? 1) as 1
    }
  })
}

/** 测试/导入用的整段替换；每条消息仍按原顺序和完整 parts 保存。 */
export function replaceHistory(sessionId: string, messages: readonly AgentMessage[]): void {
  tx(() => {
    const session = getSession(sessionId)
    if (session === undefined) throw new Error(`会话不存在: ${sessionId}`)

    // `replaceHistory` is also used after a run to reconcile the renderer's
    // transcript with SQLite.  Deleting all messages first looks simple, but
    // it cascades their managed attachment rows.  The following commit would
    // then only UPDATE a missing row, turning every `ncw://` image into an
    // unreferenced file.  Re-number existing rows into a temporary negative
    // range, upsert the incoming messages in their authoritative order, and
    // remove only messages that disappeared.  Their attachment rows are then
    // safely cascaded by SQLite.
    const ids = new Set<string>()
    for (const message of messages) {
      if (ids.has(message.id)) throw new Error(`消息 ${message.id} 在转录中重复`)
      ids.add(message.id)
      const owner = stmt('SELECT session_id FROM messages WHERE id = ?').get(message.id) as Record<string, unknown> | undefined
      if (owner !== undefined && String(owner['session_id']) !== sessionId) {
        throw new Error(`消息 ${message.id} 已属于另一个会话`)
      }
    }

    stmt('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId)
    stmt('UPDATE messages SET ordinal = -ordinal - 1 WHERE session_id = ?').run(sessionId)
    for (const [ordinal, message] of messages.entries()) writeMessage(session, message, ordinal)

    const existing = stmt('SELECT id FROM messages WHERE session_id = ?').all(sessionId)
    for (const row of existing) {
      const id = String((row as Record<string, unknown>)['id'])
      if (ids.has(id)) continue
      stmt('DELETE FROM messages WHERE id = ?').run(id)
    }

    const current = getSession(sessionId)
    if (current !== undefined) {
      putSession({
        ...current,
        updatedAt: Math.max(current.updatedAt, messages.at(-1)?.createdAt ?? current.updatedAt)
      })
    }
  })
}

export function setRunRecord(id: string, sessionId: string, status: string, startedAt: number, endedAt?: number): void {
  stmt(
    `INSERT INTO runs (id, session_id, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at`
  ).run(id, sessionId, status, startedAt, endedAt ?? null)
}

export function deleteSession(id: string): void {
  tx(() => {
    stmt('DELETE FROM messages_fts WHERE session_id = ?').run(id)
    stmt('DELETE FROM sessions WHERE id = ?').run(id)
    // 草稿附件没有 session_id（外键要求上传时会话可以尚未创建），
    // 因此不能只依赖 CASCADE；owner_id 是它们的会话归属。
    stmt("DELETE FROM attachments WHERE scope = 'session' AND owner_id = ?").run(id)
    removeKv(`session.input.${id}`)
  })
}

export function listCredentials(): Array<{ ref: string; blob: Uint8Array }> {
  return stmt('SELECT ref, blob FROM credentials ORDER BY ref').all().flatMap((row) => {
    const r = row as Record<string, unknown>
    const blob = r['blob']
    return blob instanceof Uint8Array ? [{ ref: String(r['ref']), blob }] : []
  })
}

/** 仅返回数据库中实际存过的搜索配置；不要和目录默认值混用。 */
export function listStoredSearchProviders(): SearchProviderConfig[] {
  return stmt('SELECT json FROM search_providers ORDER BY priority, id')
    .all()
    .map((r) => parse<SearchProviderConfig>(r['json']))
}

/** 返回当前可导出的结构快照；凭证需由 storage handler 另行解密/加密。 */
export function exportDataSnapshot(): Omit<DataExport, 'encryptedCredentials'> {
  const settings = getSettings()
  // 备份目录是设备本地路径，不能随普通导出迁移到另一台机器；频率仍是
  // 用户偏好，可以安全导出。导入时也会保留当前设备的目录。
  settings.data = { ...settings.data, backupDirectory: null }
  return {
    type: 'nextcowork-data-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    workspaces: listWorkspaces(),
    sessions: listAllSessionDetails(),
    providers: listProviders(),
    aliases: listAliases(),
    mcpServers: listMcpServers(),
    // 导出的是实际配置行，不把目录里的默认项伪造成用户配置。
    searchProviders: listStoredSearchProviders(),
    disabledSkillIds: (() => {
      const raw = getKv<unknown>('skills.disabled', [])
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    })()
  }
}

function newerThan(local: { updatedAt?: number } | Workspace | undefined, incoming: { updatedAt?: number } | Workspace): boolean {
  if (local === undefined) return true
  const localAt = (local as { updatedAt?: unknown }).updatedAt
  const incomingAt = (incoming as { updatedAt?: unknown }).updatedAt
  if (typeof localAt !== 'number' || typeof incomingAt !== 'number') return false
  return incomingAt > localAt
}

type VersionDecision = 'new' | 'old' | 'unknown'

/** 对没有时间戳的旧配置，明确返回 unknown（策略是保留本地）。 */
function versionDecision(local: unknown, incoming: unknown): VersionDecision {
  if (local === undefined) return 'new'
  const localAt = typeof local === 'object' && local !== null ? (local as Record<string, unknown>)['updatedAt'] : undefined
  const incomingAt = typeof incoming === 'object' && incoming !== null ? (incoming as Record<string, unknown>)['updatedAt'] : undefined
  if (typeof localAt !== 'number' || !Number.isFinite(localAt) || typeof incomingAt !== 'number' || !Number.isFinite(incomingAt)) return 'unknown'
  return incomingAt > localAt ? 'new' : 'old'
}

/** 在一个 SQLite 事务里逐项合并导入数据。 */
export function mergeDataExport(data: DataExport): ImportApplyResult {
  return tx(() => {
    let imported = 0
    let overwritten = 0
    let skipped = 0
    let workspacesImported = 0
    let sessionsImported = 0
    let messagesImported = 0

    const localSettings = getSettings()
    // 设置没有可靠的 updatedAt，导入文件由用户明确确认，按整块导入。
    updateSettings({
      ...data.settings,
      data: {
        ...data.settings.data,
        // 这个路径只属于当前设备，普通导入不能把另一台机器的路径写进来。
        backupDirectory: localSettings.data.backupDirectory
      }
    })
    const settingsImported = JSON.stringify(localSettings) !== JSON.stringify(getSettings())

    for (const w of data.workspaces) {
      const local = getWorkspace(w.id)
      if (local === undefined || newerThan(local, w)) {
        putWorkspace({ ...w, unavailable: !existsSync(w.rootPath) })
        imported++
        workspacesImported++
        if (local !== undefined) overwritten++
      } else skipped++
    }
    for (const p of data.providers) {
      const local = listProviders().find((x) => x.id === p.id)
      const decision = versionDecision(local, p)
      if (decision === 'new') { putProvider(p); imported++; if (local !== undefined) overwritten++ } else skipped++
    }
    for (const a of data.aliases) {
      const local = listAliases().find((x) => x.providerId === a.providerId && x.alias === a.alias)
      if (local === undefined) { putAlias(a); imported++ } else skipped++
    }
    for (const c of data.mcpServers) {
      const local = getMcpServer(c.id)
      const decision = versionDecision(local, c)
      if (decision === 'new') { putMcpServer(c); imported++; if (local !== undefined) overwritten++ } else skipped++
    }
    for (const c of data.searchProviders) {
      const local = listStoredSearchProviders().find((x) => x.id === c.id)
      const decision = versionDecision(local, c)
      if (decision === 'new') { putSearchProvider(c); imported++; if (local !== undefined) overwritten++ } else skipped++
    }
    setKv('skills.disabled', data.disabledSkillIds)

    for (const item of data.sessions) {
      const local = getSession(item.session.id)
      if (local !== undefined && !newerThan(local, item.session)) { skipped++; continue }
      if (local !== undefined) overwritten++
      putSession(item.session)
      replaceHistory(item.session.id, item.messages)
      imported++
      sessionsImported++
      messagesImported += item.messages.length
    }
    return { imported, overwritten, skipped, settingsImported, workspacesImported, sessionsImported, messagesImported }
  })
}

export function referencedAttachmentPaths(): string[] {
  return stmt('SELECT DISTINCT path FROM attachments').all().map((r) => String((r as Record<string, unknown>)['path']))
}

export interface AttachmentReferenceRow {
  id: string
  path: string
  size: number
  sessionId: string | null
  messageId: string | null
  ownerId: string | null
  scope: string
  status: string
}

export function attachmentRows(): AttachmentReferenceRow[] {
  return stmt('SELECT id, path, size, session_id, message_id, owner_id, scope, status FROM attachments').all().map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r['id']),
      path: String(r['path']),
      size: Number(r['size'] ?? 0),
      sessionId: r['session_id'] == null ? null : String(r['session_id']),
      messageId: r['message_id'] == null ? null : String(r['message_id']),
      ownerId: r['owner_id'] == null ? null : String(r['owner_id']),
      scope: String(r['scope'] ?? 'session'),
      status: String(r['status'] ?? 'committed')
    }
  })
}

/** 返回指定会话的附件；包括尚未提交、只用 owner_id 归属的草稿。 */
export function attachmentRowsForSessions(sessionIds: readonly string[]): AttachmentReferenceRow[] {
  if (sessionIds.length === 0) return []
  const wanted = new Set(sessionIds)
  return attachmentRows().filter((row) =>
    row.scope === 'session' &&
    ((row.sessionId !== null && wanted.has(row.sessionId)) ||
      (row.ownerId !== null && wanted.has(row.ownerId)))
  )
}

/** Paths captured before a session cascade removes its attachment rows. */
export function sessionAttachmentPaths(sessionId: string): string[] {
  return attachmentRowsForSessions([sessionId]).map((row) => row.path)
}

/** 当前所有会话附件（调用方负责做路径边界校验）。 */
export function allSessionAttachmentRows(): AttachmentReferenceRow[] {
  return attachmentRows().filter((row) => row.scope === 'session')
}

/** 按会话更新时间取待删 ID，避免 storage 层重复拼接 SQL。 */
export function sessionIdsBefore(cutoff: number): string[] {
  return stmt('SELECT id FROM sessions WHERE updated_at < ?').all(cutoff)
    .map((row) => String((row as Record<string, unknown>)['id']))
}

export function removeAttachmentRow(id: string): void {
  stmt('DELETE FROM attachments WHERE id = ?').run(id)
}

/** Number of attachment rows that still point at a physical path. */
export function attachmentReferenceCount(path: string, excludeId?: string): number {
  const row = excludeId === undefined
    ? stmt('SELECT COUNT(*) AS n FROM attachments WHERE path = ?').get(path)
    : stmt('SELECT COUNT(*) AS n FROM attachments WHERE path = ? AND id <> ?').get(path, excludeId)
  return Number((row as Record<string, unknown> | undefined)?.['n'] ?? 0)
}

// ─── 上传附件(scope/status,迁移 5) ──────────────────────────────────────────

export interface AttachmentRow {
  id: string
  scope: string
  ownerId: string | null
  sessionId: string | null
  messageId: string | null
  path: string
  size: number
  checksum: string
  status: string
  /** 用户看到的原始名。迁移 6 之前的行是 null,读的时候退回 basename(path) */
  displayName: string | null
  createdAt: number
}

function toAttachmentRow(row: unknown): AttachmentRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r['id']),
    scope: String(r['scope'] ?? 'session'),
    ownerId: r['owner_id'] == null ? null : String(r['owner_id']),
    sessionId: r['session_id'] == null ? null : String(r['session_id']),
    messageId: r['message_id'] == null ? null : String(r['message_id']),
    path: String(r['path']),
    size: Number(r['size'] ?? 0),
    checksum: String(r['checksum'] ?? ''),
    status: String(r['status'] ?? 'committed'),
    displayName: r['display_name'] == null ? null : String(r['display_name']),
    createdAt: Number(r['created_at'] ?? 0)
  }
}

/**
 * 上传落盘后登记。★ 插入的是 **`draft`** —— 文件已经在磁盘上,但还没进任何消息。
 *
 * ★ **只写 `owner_id`,不写 `session_id`。** 后者上有指向 `sessions` 的外键,
 * 而上传发生在发送**之前** —— 新建对话还没发第一条消息时,`sessions` 表里
 * 没有那一行,写进去直接 FOREIGN KEY constraint failed。
 * `session_id` 由 `commitAttachmentsByPath` 在消息提交时补上,那一刻会话必然存在。
 */
export function putDraftAttachment(a: {
  id: string
  scope: string
  ownerId?: string
  path: string
  size: number
  checksum: string
  displayName?: string
  createdAt: number
}): void {
  stmt(
    `INSERT INTO attachments (id, session_id, message_id, path, size, checksum, scope, status, owner_id, display_name, created_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, 'draft', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET path = excluded.path, size = excluded.size`
  ).run(
    a.id,
    a.path,
    a.size,
    a.checksum,
    a.scope,
    a.ownerId ?? null,
    a.displayName ?? null,
    a.createdAt
  )
}

/**
 * 同 scope + 同 owner 内按内容去重。
 *
 * ★ **不做全局去重**:跨会话共用一个物理文件之后,删掉其中一个会话就会
 * 波及另一个仍在引用它的会话。要正确处理就得引用计数,而那点磁盘空间
 * 不值得引入一套引用计数的正确性负担。
 */
export function findAttachmentByChecksum(
  checksum: string,
  scope: string,
  ownerId?: string
): AttachmentRow | undefined {
  const row =
    ownerId === undefined
      ? stmt(
          `SELECT * FROM attachments WHERE checksum = ? AND scope = ? AND owner_id IS NULL LIMIT 1`
        ).get(checksum, scope)
      : stmt(
          `SELECT * FROM attachments WHERE checksum = ? AND scope = ? AND owner_id = ? LIMIT 1`
        ).get(checksum, scope, ownerId)
  return row == null ? undefined : toAttachmentRow(row)
}

export function getAttachmentRow(id: string): AttachmentRow | undefined {
  const row = stmt('SELECT * FROM attachments WHERE id = ?').get(id)
  return row == null ? undefined : toAttachmentRow(row)
}

/**
 * Compatibility lookup for migrated attachment rows whose id no longer
 * matches the basename encoded in an ncw:// URL.  The owner and session scope
 * are part of the predicate; basename alone is never sufficient because two
 * sessions may legitimately contain files with the same name.
 */
export function findAttachmentByOwnerAndFileName(ownerId: string, fileName: string): AttachmentRow | undefined {
  const rows = stmt(
    `SELECT * FROM attachments
       WHERE scope = 'session' AND owner_id = ? AND status IN ('draft', 'committed')
       ORDER BY created_at DESC, id DESC`
  ).all(ownerId)
  for (const row of rows) {
    const parsed = toAttachmentRow(row)
    if (basename(parsed.path) === fileName) return parsed
  }
  return undefined
}

/** 某个会话下所有还没发出去的附件 —— 重启后恢复草稿附件区要用 */
export function listDraftAttachments(sessionId: string): AttachmentRow[] {
  return stmt(
    `SELECT * FROM attachments WHERE owner_id = ? AND status = 'draft' ORDER BY created_at`
  )
    .all(sessionId)
    .map(toAttachmentRow)
}

/**
 * 可回收的草稿附件:`status='draft'` 且已过宽限期。
 *
 * ★ 这就是新的孤儿判据。旧判据是「不在表里就删」,它在附件根下只有会话附件时
 * 是对的;现在根下还有 theme/export 和**尚未发送的草稿**,那条判据会静默删掉它们。
 */
export function listStaleDraftAttachments(cutoff: number): AttachmentRow[] {
  return stmt(`SELECT * FROM attachments WHERE status = 'draft' AND created_at < ?`)
    .all(cutoff)
    .map(toAttachmentRow)
}

/**
 * 消息提交时把草稿升为已提交,并**这时才**填 `session_id` / `message_id` ——
 * 那两列上有外键,而上传发生在会话与消息都还不存在的时候。
 */
export function commitAttachmentsByIds(
  ids: readonly string[],
  messageId: string,
  sessionId: string
): void {
  if (ids.length === 0) return
  tx(() => {
    const currentRows = attachmentRowsForMessage(messageId)
    const usedIds = new Set<string>()
    ids.forEach((id, index) => {
      const row = getAttachmentRow(id)
      if (
        row === undefined ||
        row.scope !== 'session' ||
        row.ownerId !== sessionId
      ) return

      // Keep an already-associated row in place. A row committed to another
      // message is never moved; create a reference below instead.
      const current = currentRows.find(
        (candidate) => !usedIds.has(candidate.id) && candidate.path === row.path
      )
      if (current !== undefined) {
        usedIds.add(current.id)
        return
      }

      if (
        !usedIds.has(row.id) &&
        row.status === 'draft' &&
        row.messageId === null &&
        row.sessionId === null
      ) {
        stmt(
          `UPDATE attachments SET status = 'committed', message_id = ?, session_id = ?, owner_id = ?
           WHERE id = ? AND scope = 'session' AND owner_id = ? AND status = 'draft'
             AND message_id IS NULL AND session_id IS NULL`
        ).run(messageId, sessionId, sessionId, row.id, sessionId)
        usedIds.add(row.id)
        return
      }

      const baseId = `${messageId}:managed:${String(index)}`
      let referenceId = baseId
      let suffix = 0
      while (true) {
        const existing = getAttachmentRow(referenceId)
        if (existing === undefined) break
        if (
          existing.scope === 'session' &&
          existing.ownerId === sessionId &&
          existing.messageId === messageId &&
          existing.path === row.path
        ) {
          usedIds.add(referenceId)
          return
        }
        suffix++
        referenceId = `${baseId}:${row.id}:${String(suffix)}`
      }
      stmt(
        `INSERT INTO attachments
           (id, session_id, message_id, path, size, checksum, scope, status, owner_id, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'session', 'committed', ?, ?, ?)`
      ).run(
        referenceId,
        sessionId,
        messageId,
        row.path,
        row.size,
        row.checksum,
        sessionId,
        row.displayName,
        row.createdAt
      )
      usedIds.add(referenceId)
    })
  })
}

/** 同上,但按磁盘路径定位。测试与迁移用 */
export function commitAttachmentsByPath(
  paths: readonly string[],
  messageId: string,
  sessionId: string
): void {
  if (paths.length === 0) return
  tx(() => {
    const rows = stmt(
      `SELECT * FROM attachments
         WHERE path IN (${paths.map(() => '?').join(',')})
           AND scope = 'session' AND owner_id = ?
         ORDER BY created_at, id`
    ).all(...paths, sessionId).map(toAttachmentRow)
    const currentRows = attachmentRowsForMessage(messageId)
    const usedIds = new Set<string>()
    rows.forEach((row, index) => {
      const current = currentRows.find(
        (candidate) => !usedIds.has(candidate.id) && candidate.path === row.path
      )
      if (current !== undefined) {
        usedIds.add(current.id)
        return
      }
      if (
        row.status === 'draft' &&
        row.messageId === null &&
        row.sessionId === null
      ) {
        stmt(
          `UPDATE attachments SET status = 'committed', message_id = ?, session_id = ?, owner_id = ?
           WHERE id = ? AND scope = 'session' AND owner_id = ? AND status = 'draft'
             AND message_id IS NULL AND session_id IS NULL`
        ).run(messageId, sessionId, sessionId, row.id, sessionId)
        usedIds.add(row.id)
        return
      }
      // A committed row belongs to another message. Reuse the same reference
      // id convention as commitAttachmentsByIds so repeated migrations remain
      // idempotent and the physical file gets reference-counted by path.
      const baseId = `${messageId}:managed:${String(index)}`
      let referenceId = baseId
      let suffix = 0
      while (true) {
        const existing = getAttachmentRow(referenceId)
        if (existing === undefined) break
        if (
          existing.scope === 'session' &&
          existing.ownerId === sessionId &&
          existing.messageId === messageId &&
          existing.path === row.path
        ) {
          usedIds.add(referenceId)
          return
        }
        suffix++
        referenceId = `${baseId}:${row.id}:${String(suffix)}`
      }
      stmt(
        `INSERT INTO attachments
           (id, session_id, message_id, path, size, checksum, scope, status, owner_id, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'session', 'committed', ?, ?, ?)`
      ).run(
        referenceId,
        sessionId,
        messageId,
        row.path,
        row.size,
        row.checksum,
        sessionId,
        row.displayName,
        row.createdAt
      )
      usedIds.add(referenceId)
    })
  })
}

export function searchAll(q: string, workspaceId?: string, limit = 50): SearchHit[] {
  const trimmed = q.trim()
  if (trimmed === '') return []
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
  // 以短语查询避免用户输入的 MATCH 运算符破坏 FTS 语法。
  const phrase = `"${trimmed.replaceAll('"', '""')}"`
  try {
    const rows = workspaceId === undefined
      ? stmt(`SELECT f.session_id, f.message_id, s.workspace_id, s.title, snippet(messages_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet, m.created_at
              FROM messages_fts f JOIN sessions s ON s.id = f.session_id JOIN messages m ON m.id = f.message_id
              WHERE messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`).all(phrase, safeLimit)
      : stmt(`SELECT f.session_id, f.message_id, s.workspace_id, s.title, snippet(messages_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet, m.created_at
              FROM messages_fts f JOIN sessions s ON s.id = f.session_id JOIN messages m ON m.id = f.message_id
              WHERE s.workspace_id = ? AND messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`).all(workspaceId, phrase, safeLimit)
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return { sessionId: String(r['session_id']), workspaceId: String(r['workspace_id']), messageId: String(r['message_id']), title: String(r['title']), snippet: String(r['snippet'] ?? ''), createdAt: Number(r['created_at']) }
    })
  } catch {
    // FTS 对极端 Unicode/旧数据库失败时，退回 LIKE，搜索仍可用。
    const like = `%${trimmed}%`
    const rows = workspaceId === undefined
      ? stmt(`SELECT m.session_id, m.id AS message_id, s.workspace_id, s.title, substr(m.parts, 1, 240) AS snippet, m.created_at
              FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.parts LIKE ? ORDER BY m.created_at DESC LIMIT ?`).all(like, safeLimit)
      : stmt(`SELECT m.session_id, m.id AS message_id, s.workspace_id, s.title, substr(m.parts, 1, 240) AS snippet, m.created_at
              FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.workspace_id = ? AND m.parts LIKE ? ORDER BY m.created_at DESC LIMIT ?`).all(workspaceId, like, safeLimit)
    return rows.map((row) => { const r = row as Record<string, unknown>; return { sessionId: String(r['session_id']), workspaceId: String(r['workspace_id']), messageId: String(r['message_id']), title: String(r['title']), snippet: String(r['snippet'] ?? ''), createdAt: Number(r['created_at']) } })
  }
}

function messageBytes(): { count: number; bytes: number } {
  const rows = stmt('SELECT parts FROM messages').all()
  let bytes = 0
  for (const row of rows) bytes += Buffer.byteLength(String((row as Record<string, unknown>)['parts'] ?? ''), 'utf8')
  return { count: rows.length, bytes }
}

export function deleteAllHistory(): CleanupResult {
  return tx(() => {
    const p = cleanupPreview('history')
    stmt('DELETE FROM messages_fts').run()
    stmt('DELETE FROM sessions').run()
    // committed 行随 sessions 级联；没有 session_id 的会话草稿按 scope
    // 显式删除。主题/导出附件不属于对话历史，必须保留。
    stmt("DELETE FROM attachments WHERE scope = 'session'").run()
    stmt('DELETE FROM runs').run()
    // Drafts and queued inputs are stored in kv because they can exist before
    // a session row is created. Clearing history must remove those otherwise
    // unreachable rows as well; deleting only the relational tables leaves
    // stale text that can reappear when an id is reused.
    stmt("DELETE FROM kv WHERE key LIKE 'session.input.%'").run()
    return { ...p, deleted: p.sessionCount + p.messageCount + p.attachmentCount }
  })
}

/** 测试隔离：只清会话相关表，不触碰设置、供应商和工作区。 */
export function clearSessionDataForTest(): void {
  tx(() => {
    stmt('DELETE FROM messages_fts').run()
    stmt('DELETE FROM runs').run()
    stmt('DELETE FROM attachments').run()
    stmt('DELETE FROM messages').run()
    stmt('DELETE FROM sessions').run()
    stmt("DELETE FROM kv WHERE key LIKE 'session.input.%'").run()
  })
}

export function cleanupPreview(kind: 'attachments' | 'age' | 'history' | 'local-data', cutoff?: number): CleanupPreview {
  if (kind === 'attachments') {
    const rows = stmt(`SELECT id, path, size FROM attachments WHERE message_id IS NULL OR session_id IS NULL`).all()
    return { kind, sessionCount: 0, messageCount: 0, attachmentCount: rows.length, bytes: rows.reduce((n, r) => n + Number((r as Record<string, unknown>)['size'] ?? 0), 0), undeletable: [] }
  }
  if (kind === 'age') {
    const rows = stmt(`SELECT s.id, COUNT(m.id) AS messages
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id WHERE s.updated_at < ? GROUP BY s.id`).all(cutoff ?? 0)
    const ids = rows.map((r) => String((r as Record<string, unknown>)['id']))
    const attachmentRows = attachmentRowsForSessions(ids)
    let messageBytes = 0
    if (ids.length > 0) {
      const parts = stmt(`SELECT parts FROM messages WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      messageBytes = parts.reduce((n, r) => n + Buffer.byteLength(String((r as Record<string, unknown>)['parts'] ?? ''), 'utf8'), 0)
    }
    return { kind, sessionCount: rows.length, messageCount: rows.reduce((n, r) => n + Number((r as Record<string, unknown>)['messages']), 0), attachmentCount: attachmentRows.length, bytes: messageBytes + attachmentRows.reduce((n, row) => n + row.size, 0), undeletable: [] }
  }
  const c = stmt(`SELECT COUNT(*) AS n FROM sessions`).get() as Record<string, unknown>
  const m = messageBytes()
  const attachments = kind === 'history' ? allSessionAttachmentRows() : attachmentRows()
  return { kind, sessionCount: Number(c.n ?? 0), messageCount: m.count, attachmentCount: attachments.length, bytes: m.bytes + attachments.reduce((n, row) => n + row.size, 0), undeletable: [] }
}

export function deleteByAge(cutoff: number): CleanupResult {
  return tx(() => {
    const p = cleanupPreview('age', cutoff)
    const ids = sessionIdsBefore(cutoff)
    for (const id of ids) deleteSession(id)
    return { ...p, deleted: p.sessionCount + p.messageCount + p.attachmentCount }
  })
}

export function storageStats(dataDirectory: string, attachmentDirectory: string, lastBackupAt: number | null): import('../../shared/domain/settings').StorageStats {
  const files = fileStats()
  const c = messageBytes()
  const s = stmt('SELECT COUNT(*) AS n FROM sessions').get() as Record<string, unknown>
  const a = stmt('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM attachments').get() as Record<string, unknown>
  let attachmentBytes = 0
  try {
    // 统计的是附件目录的实际占用，而不是 attachments 表里记录的大小：
    // 表中可能有外部绝对路径或已经丢失的文件，不能把它们冒充本机目录空间。
    // 先 lstat，再递归；符号链接按链接自身的大小计入，绝不跟随到外部目录。
    const walk = (dir: string): number => {
      let dirStat
      try { dirStat = lstatSync(dir) } catch { return 0 }
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return dirStat.size
      let total = 0
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        try {
          const st = lstatSync(p)
          total += st.isDirectory() && !st.isSymbolicLink() ? walk(p) : st.size
        } catch { /* 文件在扫描期间消失 */ }
      }
      return total
    }
    attachmentBytes = walk(attachmentDirectory)
  } catch { /* 目录不存在或不可读 */ }
  return {
    dbBytes: files.dbBytes,
    walBytes: files.walBytes,
    conversationBytes: Number(c.bytes ?? 0),
    attachmentBytes,
    conversationCount: Number(s.n ?? 0),
    messageCount: Number(c.count ?? 0),
    attachmentCount: Number(a.n ?? 0),
    dataDirectory,
    lastBackupAt
  }
}

// ── 上游供应商 / 模型别名 ────────────────────────────────────────────────────

export function listProviders(): UpstreamProvider[] {
  // priority 相同时用 id 兜底,保证顺序是确定的 —— 故障切换按这个顺序挑候选,
  // 「今天先切到 A、明天先切到 B」比切错还难查
  return stmt('SELECT json FROM providers ORDER BY priority, id')
    .all()
    .map((r) => normalizeUpstreamProvider(parse<UpstreamProvider>(r['json'])))
}

export function putProvider(p: UpstreamProvider): UpstreamProvider {
  const normalized = normalizeUpstreamProvider(p)
  stmt(
    `INSERT INTO providers (id, priority, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET priority = excluded.priority, json = excluded.json`
  ).run(normalized.id, normalized.priority, JSON.stringify(normalized))
  return normalized
}

/**
 * 别名**不用**在这里手动删。`model_aliases.provider_id` 上的
 * `ON DELETE CASCADE` 接着(见 `schema.ts`),前提是连接开了 `foreign_keys`
 * —— `index.ts` 的 `openAt()` 用构造参数打开的。
 */
export function removeProvider(id: string): void {
  stmt('DELETE FROM providers WHERE id = ?').run(id)
}

export function listAliases(): ModelAlias[] {
  return stmt('SELECT json FROM model_aliases ORDER BY provider_id, alias')
    .all()
    .map((r) => parse<ModelAlias>(r['json']))
}

export function putAlias(a: ModelAlias): ModelAlias {
  stmt(
    `INSERT INTO model_aliases (provider_id, alias, json) VALUES (?, ?, ?)
     ON CONFLICT (provider_id, alias) DO UPDATE SET json = excluded.json`
  ).run(a.providerId, a.alias, JSON.stringify(a))
  return a
}

export function removeAlias(providerId: string, alias: string): void {
  stmt('DELETE FROM model_aliases WHERE provider_id = ? AND alias = ?').run(providerId, alias)
}

// ── kv ──────────────────────────────────────────────────────────────────────

export function getKv<T>(key: string, fallback: T): T {
  const row = stmt('SELECT json FROM kv WHERE key = ?').get(key)
  if (row === undefined) return fallback
  // `?? fallback` 保住 Map 版的语义:存进去的 null 读出来也是兜底值,
  // 而不是一个会顺着 IPC 流到界面上的 null
  return parse<T>(row['json']) ?? fallback
}

export function setKv(key: string, value: unknown): void {
  // `JSON.stringify(undefined)` 返回的是 undefined 而不是字符串,会撞上 NOT NULL。
  // 归一成 null,读回来正好走上面那条兜底。
  stmt(
    'INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json'
  ).run(key, JSON.stringify(value ?? null))
}

export function removeKv(key: string): void {
  stmt('DELETE FROM kv WHERE key = ?').run(key)
}

// ── MCP 服务器 ──────────────────────────────────────────────────────────────

/**
 * 顺序按 id —— MCP 服务器的顺序**没有语义**(每台带来的工具都平铺进同一个
 * ToolRegistry,不存在「先试这台」),但列表页需要一个稳定顺序,
 * 否则每次读回来行序都可能不同,看起来像在自己跳。
 */
export function listMcpServers(): McpServerConfig[] {
  return stmt('SELECT json FROM mcp_servers ORDER BY id')
    .all()
    .map((r) => parse<McpServerConfig>(r['json']))
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  const row = stmt('SELECT json FROM mcp_servers WHERE id = ?').get(id)
  return row === undefined ? undefined : parse<McpServerConfig>(row['json'])
}

export function putMcpServer(c: McpServerConfig): McpServerConfig {
  stmt(
    `INSERT INTO mcp_servers (id, json) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET json = excluded.json`
  ).run(c.id, JSON.stringify(c))
  return c
}

/**
 * ★ 配置和它的密钥**一起删,在一个事务里**。
 *
 * 只删配置的话,`credentials` 里那行密文会永远留着 —— 而且它是**孤儿**:
 * 键名存在刚被删掉的那条配置里,再没有任何东西知道该怎么清理它。
 * 更糟的是下次建一个同 id 的服务器会**默默继承**上一个的 token,
 * 症状是「我明明没填 Authorization,它却连上了」。
 *
 * 两个 kind 都删,而不是先读出配置再判断该删哪个:少一次读,
 * 而且配置读不出来(行已经不在了)时仍然清得干净。
 */
export function removeMcpServer(id: string): void {
  tx(() => {
    stmt('DELETE FROM mcp_servers WHERE id = ?').run(id)
    stmt('DELETE FROM credentials WHERE ref = ?').run(mcpSecretRef(id, 'env'))
    stmt('DELETE FROM credentials WHERE ref = ?').run(mcpSecretRef(id, 'headers'))
  })
}

// ── 搜索服务 ────────────────────────────────────────────────────────────────

/**
 * ★ 返回的是**目录表里的八家全部**,不是库里存着的那几行。
 *
 * 库里只存「用户动过的那几家」——一家都没配过时表是空的。而设置页要列出八家
 * 供用户挑,`web_search` 也要知道完整的优先级序。让每个调用点各自去和
 * `defaultProviderConfigs()` 做一次左连接,是三份必然会分叉的实现;
 * 收在这里一次做完。
 *
 * 顺序:**按 `priority` 升序**,平局用目录顺序兜底。
 *
 * 平局是真会出现的:界面拖拽走 `reorderProviders`,它把八家整批重编号,
 * 所以正常路径下没有重复。但只写了其中两家(测试、导入、将来某条迁移)之后,
 * 没存过的那几家仍然带着目录序号当 priority,和新编号撞得上。
 * 撞了就用目录顺序兜底 —— 关键是**确定**:「今天先试 A、明天先试 B」
 * 比顺序不合心意难查得多。
 */
export function listSearchProviders(): SearchProviderConfig[] {
  const stored = new Map(
    stmt('SELECT json FROM search_providers')
      .all()
      .map((r) => {
        const c = parse<SearchProviderConfig>(r['json'])
        return [c.id, c] as const
      })
  )
  return defaultProviderConfigs()
    .map((d, catalogIndex) => ({ cfg: stored.get(d.id) ?? d, catalogIndex }))
    .sort((a, b) => a.cfg.priority - b.cfg.priority || a.catalogIndex - b.catalogIndex)
    .map((x) => x.cfg)
}

export function putSearchProvider(c: SearchProviderConfig): SearchProviderConfig {
  stmt(
    `INSERT INTO search_providers (id, priority, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET priority = excluded.priority, json = excluded.json`
  ).run(c.id, c.priority, JSON.stringify(c))
  return c
}

/**
 * 拖拽排序的落点:**整批写,一个事务**。
 *
 * 逐行写的话,中途失败会留下一半新序一半旧序 —— 而 priority 不是描述性的,
 * 它决定调用顺序,两个 0 或者一个空档都会让「先试哪家」变得不确定。
 */
export function putSearchProviders(list: readonly SearchProviderConfig[]): void {
  tx(() => {
    for (const c of list) putSearchProvider(c)
  })
}

/** Key 也一起删,理由同 `removeMcpServer` —— 同 id 重配时不该继承上一次的 Key。 */
export function clearSearchCredential(id: SearchProviderId): void {
  stmt('DELETE FROM credentials WHERE ref = ?').run(searchSecretRef(id))
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * ★ 存取的是**密文字节**,这里不认识明文也不该认识 ——
 * 加解密只在 `main/host/index.ts` 那两个函数之间发生(方案 §9)。
 *
 * 读回来的是 `Uint8Array`,`safeStorage.decryptString` 要 `Buffer`,
 * 转换留给调用方 —— 数据库层不 import electron 的任何东西。
 */
export function getCredential(ref: string): Uint8Array | undefined {
  const row = stmt('SELECT blob FROM credentials WHERE ref = ?').get(ref)
  if (row === undefined) return undefined
  const blob = row['blob']
  return blob instanceof Uint8Array ? blob : undefined
}

export function putCredential(ref: string, blob: Uint8Array): void {
  stmt(
    'INSERT INTO credentials (ref, blob) VALUES (?, ?) ON CONFLICT (ref) DO UPDATE SET blob = excluded.blob'
  ).run(ref, blob)
}

export function removeCredential(ref: string): void {
  stmt('DELETE FROM credentials WHERE ref = ?').run(ref)
}
