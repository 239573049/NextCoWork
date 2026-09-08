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
import type { TokenUsage } from '../../shared/agent/stream'
import type { ContextCheckpoint, ContextSearchHit, ContextCheckpointSource } from '../../shared/agent/context-management'
import { parseNcwUrl } from '../../shared/domain/attachment'
import type { McpServerConfig } from '../../shared/domain/mcp'
import { mcpSecretRef } from '../../shared/domain/mcp'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import { normalizeUpstreamProvider, providerCredentialRef } from '../../shared/domain/provider'
import type { ModelCatalogDefinition } from '../../shared/domain/model-catalog'
import { isModelCatalogDefinition } from '../../shared/domain/model-catalog'
import type { SearchProviderConfig, SearchProviderId } from '../../shared/domain/search'
import { defaultProviderConfigs, searchSecretRef } from '../../shared/domain/search'
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/domain/settings'
import { dataMergeDecision, type CleanupPreview, type CleanupResult, type DataExport, type ExportSession, type ImportApplyResult } from '../../shared/domain/data'
import type { Session, SessionDetail, SessionListItem, SearchHit } from '../../shared/domain/session'
import { isDefaultSessionTitle } from '../../shared/domain/session'
import type { SessionMode, ThinkingLevel } from '../../shared/agent/run-request'
import type { Workspace } from '../../shared/domain/workspace'
import type {
  UsageAttemptRecord,
  UsageCostTotal,
  UsageDimensionStat,
  UsageRequestLogsPage,
  UsageRequestLogsQuery,
  UsageSummary,
  UsageWindow
} from '../../shared/domain/usage'
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
  /** 非空 = 这是一次子代理 run 的转录,不进任何面向用户的枚举。见 `Session.parentSessionId`。 */
  parentSessionId?: string
  title?: string
  model?: string
  modelProviderId?: string
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
    /*
      ★ 只认真列,不走 `parsed` 兜底。json 里那份是 `sessionRowJson` 顺手写进去的
      副本,而列是过滤和级联唯一读的地方 —— 两者不一致时必须以列为准,
      否则一条 json 损坏的行会重新出现在侧边栏里。
    */
    ...(row['parent_session_id'] === null || row['parent_session_id'] === undefined
      ? {} : { parentSessionId: String(row['parent_session_id']) }),
    title: String(row['title'] ?? parsed.title ?? '新对话'),
    ...(parsed.titleSource === 'default' || parsed.titleSource === 'generated' || parsed.titleSource === 'manual'
      ? { titleSource: parsed.titleSource } : {}),
    model: String(row['model'] ?? parsed.model ?? ''),
    /*
      ★ 只活在 json 里,**没有提列** —— 照 `titleSource` 的先例。
      提列的判据是「要不要被 WHERE / ORDER BY / 级联删除读到」,而这个字段
      一样都不沾(用量统计走 `usage_records` 自己的 provider_id 真列)。
      为它加一列只会多制造一对「列和 json 可能不一致」,而上面那段注释
      正说明了这种不一致要用硬规则去压。
    */
    ...(typeof parsed.modelProviderId === 'string' ? { modelProviderId: parsed.modelProviderId } : {}),
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
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    title: input.title?.trim() || '新对话',
    titleSource: isDefaultSessionTitle(input.title ?? '') ? 'default' : 'manual',
    model: input.model ?? '',
    ...(input.modelProviderId === undefined ? {} : { modelProviderId: input.modelProviderId }),
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
    if (existing !== undefined) {
      /*
        ★ 唯一一处「命中已有行还要写」的例外:这一行是在加上
        `parent_session_id` 之前建的(或者由一份旧存档导入),而它决定这条转录
        进不进侧边栏。不补的话,一条续跑的子代理会话会永远留在列表里,
        且没有任何入口能修正它。其余字段照旧不覆盖 —— 用户改过的标题归用户。
      */
      if (input.parentSessionId !== undefined && existing.parentSessionId === undefined) {
        return putSession({ ...existing, parentSessionId: input.parentSessionId })
      }
      return existing
    }
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
    /*
      ★ 自环护栏。`parent_session_id = id` 会让 `sessionSubtreeIds` 的递归 CTE
      在这一行上原地打转 —— `UNION` 去重能终止它,但整条级联删除会静默地
      只删这一行。畸形导入和将来某个写错的派生都从这里挡掉。
    */
    ...(session.parentSessionId === session.id ? { parentSessionId: undefined } : {}),
    status: 'idle',
    title: session.title.trim() || '新对话'
  }
  stmt(
    `INSERT INTO sessions
       (id, workspace_id, parent_session_id, title, model, mode, thinking, root_path_at_creation, status,
        archived, favorited, created_at, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       parent_session_id = excluded.parent_session_id,
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
    normalized.parentSessionId ?? null,
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
  // Message bodies are indexed separately in FTS5. Keep the denormalized
  // title column in sync when a session is renamed (or imported) so searches
  // by conversation title do not continue returning the old title until the
  // next message is committed.
  stmt('UPDATE messages_fts SET title = ? WHERE session_id = ?').run(normalized.title, normalized.id)
  return normalized
}

/**
 * 侧边栏的那张列表。
 *
 * ★ `parent_session_id IS NULL` 是**子代理转录的过滤口**:它们的行确实在表里
 * (外键要求如此),但它们不是用户的对话 —— 少了这个条件,每派一个子代理
 * 侧边栏就多一条永远叫「新对话」的条目(标题生成只对 depth 0 触发)。
 */
export function listSessions(workspaceId: string, archived?: boolean): SessionListItem[] {
  const rows = archived === undefined
    ? stmt('SELECT id, title, updated_at, archived FROM sessions WHERE workspace_id = ? AND parent_session_id IS NULL ORDER BY updated_at DESC, id DESC').all(workspaceId)
    : stmt('SELECT id, title, updated_at, archived FROM sessions WHERE workspace_id = ? AND parent_session_id IS NULL AND archived = ? ORDER BY updated_at DESC, id DESC').all(workspaceId, archived ? 1 : 0)
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
  return {
    session,
    messages: getHistory(id) as AgentMessage[],
    contextCheckpoints: listContextCheckpoints(id),
    messageRuns: messageRunsOf(id),
    runUsage: runUsageOf(id)
  }
}

/**
 * 消息 → 产出它的 run。第 12 条迁移之前的消息没有归属,直接不出现在这张表里
 * (而不是给一个占位 id ——「不知道」和「属于某个 run」在界面上是两件事:
 * 前者不显示用量,后者会去查一个查不到的 run 然后显示 0 token)。
 */
export function messageRunsOf(sessionId: string): Record<string, string> {
  const runs: Record<string, string> = {}
  for (const row of stmt('SELECT id, run_id FROM messages WHERE session_id = ? AND run_id IS NOT NULL').all(sessionId)) {
    const r = row as Record<string, unknown>
    runs[String(r['id'])] = String(r['run_id'])
  }
  return runs
}

/**
 * 一条会话里每个 run 的累计用量,直接从落盘的 `usage_records` 聚合。
 *
 * ★ **失败的尝试也算进来。** 一次被限流打回的请求照样把 prompt 发上去了、
 * 照样计了费;把它们排除掉,界面上的数字就会比账单小,而差额没有任何地方交代。
 * 这也和 `usageSummary` 的口径一致 —— 两处报同一笔账,不能一处含重试一处不含。
 *
 * ★ 思考 Token 用 `COALESCE(...,0)` 求和是安全的:它是 `outputTokens` 的子集,
 * 只用于展示,不参与任何合计。拿不到独立计数的供应商聚出来就是 0,
 * 而 0 在这里的含义正是「没有单独报」—— 展示层照样不显示它。
 */
export function runUsageOf(sessionId: string): Record<string, TokenUsage> {
  const usage: Record<string, TokenUsage> = {}
  const rows = stmt(
    `SELECT run_id,
            SUM(input_tokens)          AS input_tokens,
            SUM(output_tokens)         AS output_tokens,
            SUM(cache_read_tokens)     AS cache_read_tokens,
            SUM(cache_write_tokens)    AS cache_write_tokens,
            SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
            SUM(COALESCE(thinking_tokens, 0)) AS thinking_tokens
       FROM usage_records
      WHERE session_id = ?
      GROUP BY run_id`
  ).all(sessionId)
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const reasoning = Number(r['thinking_tokens'] ?? 0)
    usage[String(r['run_id'])] = {
      inputTokens: Number(r['input_tokens'] ?? 0),
      outputTokens: Number(r['output_tokens'] ?? 0),
      cacheReadInputTokens: Number(r['cache_read_tokens'] ?? 0),
      cacheCreationInputTokens: Number(r['cache_write_tokens'] ?? 0),
      cacheCreation1hInputTokens: Number(r['cache_write_1h_tokens'] ?? 0),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {})
    }
  }
  return usage
}

/**
 * 库里**全部**会话,子代理转录也算。
 *
 * ★ 这里**不能**加 `parent_session_id IS NULL`。它服务的是备份 manifest
 * (`ipc/storage.ts` 的 `createBackup`),而 `validateBackupDatabase` 是拿
 * **裸** `SELECT COUNT(*) FROM sessions` 跟 manifest 对账的 —— 两边不等就
 * `manifest count mismatch`,后果是**每一个新建的备份都恢复不了**。
 * 「导出给人看的那份」用下面那个函数。
 */
export function listAllSessionDetails(): ExportSession[] {
  return sessionDetailsOf(stmt('SELECT id FROM sessions ORDER BY updated_at DESC, id DESC').all())
}

/** 数据导出用:只给顶层对话。子代理转录是父对话的实现细节,导出它没有意义。 */
export function listExportableSessionDetails(): ExportSession[] {
  return sessionDetailsOf(
    stmt('SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY updated_at DESC, id DESC').all()
  )
}

function sessionDetailsOf(rows: readonly unknown[]): ExportSession[] {
  return rows.flatMap((row) => {
    const id = String((row as Record<string, unknown>)['id'])
    const detail = getSessionDetail(id)
    return detail === undefined ? [] : [{
      session: detail.session,
      messages: [...detail.messages],
      contextCheckpoints: [...(detail.contextCheckpoints ?? [])]
    }]
  })
}

function parseContextCheckpoint(row: Record<string, unknown>): ContextCheckpoint {
  let searchHits: ContextSearchHit[] | undefined
  try {
    const parsed: unknown = row['search_hits'] === null || row['search_hits'] === undefined
      ? undefined
      : JSON.parse(String(row['search_hits']))
    if (Array.isArray(parsed)) searchHits = parsed as ContextSearchHit[]
  } catch {
    searchHits = undefined
  }
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    windowIndex: Number(row['window_index']),
    note: String(row['note'] ?? ''),
    source: String(row['source']) as ContextCheckpointSource,
    ...(row['covered_from_message_id'] == null ? {} : { coveredFromMessageId: String(row['covered_from_message_id']) }),
    ...(row['covered_through_message_id'] == null ? {} : { coveredThroughMessageId: String(row['covered_through_message_id']) }),
    ...(row['input_tokens_before'] == null ? {} : { inputTokensBefore: Number(row['input_tokens_before']) }),
    ...(row['input_tokens_after'] == null ? {} : { inputTokensAfter: Number(row['input_tokens_after']) }),
    ...(searchHits === undefined ? {} : { searchHits }),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    revision: Number(row['revision'] ?? 1)
  }
}

export function listContextCheckpoints(sessionId: string): ContextCheckpoint[] {
  return stmt('SELECT * FROM context_checkpoints WHERE session_id = ? ORDER BY window_index, id')
    .all(sessionId)
    .map((row) => parseContextCheckpoint(row as Record<string, unknown>))
}

export function getContextCheckpoint(id: string): ContextCheckpoint | undefined {
  const row = stmt('SELECT * FROM context_checkpoints WHERE id = ?').get(id)
  return row === undefined ? undefined : parseContextCheckpoint(row as Record<string, unknown>)
}

export function upsertContextCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
  tx(() => {
    stmt(
      `INSERT INTO context_checkpoints
       (id, session_id, window_index, note, source, covered_from_message_id, covered_through_message_id,
        input_tokens_before, input_tokens_after, search_hits, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET note = excluded.note, source = excluded.source,
         covered_from_message_id = excluded.covered_from_message_id,
         covered_through_message_id = excluded.covered_through_message_id,
         input_tokens_before = excluded.input_tokens_before,
         input_tokens_after = excluded.input_tokens_after,
         search_hits = excluded.search_hits, updated_at = excluded.updated_at,
         revision = excluded.revision`
    ).run(
      checkpoint.id,
      checkpoint.sessionId,
      checkpoint.windowIndex,
      checkpoint.note,
      checkpoint.source,
      checkpoint.coveredFromMessageId ?? null,
      checkpoint.coveredThroughMessageId ?? null,
      checkpoint.inputTokensBefore ?? null,
      checkpoint.inputTokensAfter ?? null,
      checkpoint.searchHits === undefined ? null : JSON.stringify(checkpoint.searchHits),
      checkpoint.createdAt,
      checkpoint.updatedAt,
      checkpoint.revision
    )
  })
  return checkpoint
}

export function updateContextCheckpoint(id: string, note: string, revision: number, now: number): ContextCheckpoint {
  const current = getContextCheckpoint(id)
  if (current === undefined) throw new Error(`上下文检查点不存在: ${id}`)
  if (current.revision !== revision) throw new Error('上下文检查点已被其它窗口更新，请重新加载后再保存')
  const next = { ...current, note, updatedAt: now, revision: revision + 1 }
  return upsertContextCheckpoint(next)
}

export function renameSession(id: string, title: string): void {
  const current = getSession(id)
  if (current === undefined) throw new Error(`会话不存在: ${id}`)
  putSession({ ...current, title: title.trim() || '新对话', titleSource: 'manual', updatedAt: Date.now() })
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

/**
 * message_commit 的唯一落盘入口；同一 message id 重放时幂等。
 *
 * ★ `run_id` 用 `COALESCE(excluded.run_id, messages.run_id)` 合并,不能直接
 * `= excluded.run_id`。`replaceHistory` 会把整段历史原样重写一遍(编辑消息、
 * 与渲染层对账都走它),而它手上只有 `AgentMessage`,没有 run 归属 ——
 * 直接赋值的话,用户改一个错别字就会把这条会话**所有**历史轮次的用量读数抹成空。
 */
function writeMessage(session: Session, message: AgentMessage, ordinal: number, runId?: string): void {
  const existing = stmt('SELECT session_id FROM messages WHERE id = ?').get(message.id) as Record<string, unknown> | undefined
  if (existing !== undefined && String(existing['session_id']) !== session.id) {
    throw new Error(`消息 ${message.id} 已属于另一个会话`)
  }
  stmt(
    `INSERT INTO messages (id, session_id, ordinal, role, parts, schema_version, created_at, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET ordinal = excluded.ordinal, parts = excluded.parts, role = excluded.role,
       schema_version = excluded.schema_version, created_at = excluded.created_at,
       run_id = COALESCE(excluded.run_id, messages.run_id)`
  ).run(
    message.id,
    session.id,
    ordinal,
    message.role,
    JSON.stringify(message.parts),
    message.schemaVersion,
    message.createdAt,
    runId ?? null
  )
  upsertFts(session, message)
  recordMessageAttachments(session, message)
  putSession({ ...session, updatedAt: Math.max(session.updatedAt, message.createdAt) })
}

export function commitMessage(sessionId: string, message: AgentMessage, runId?: string): void {
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
    writeMessage(session, message, ordinal, runId)
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

/**
 * 一条会话 + 它派生出来的全部子代理转录(任意深度),root 在前。
 *
 * ★ 固定 SQL、单 root,多 root 由调用方在 JS 里循环。动态 `IN (?,?,…)` 会给
 * **每一种长度**在 `db/index.ts` 的 prepared 缓存里留一条永不失效的语句。
 *
 * ★ `UNION` 而不是 `UNION ALL`:畸形数据造出的环会被去重终止,而 `UNION ALL`
 * 会把同步的 `DatabaseSync` 转死 —— 也就是把整个主进程转死。
 * `putSession` 里那道自环护栏是第一层,这是第二层。
 */
export function sessionSubtreeIds(rootId: string): string[] {
  return stmt(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM sessions WHERE id = ?
       UNION
       SELECT s.id FROM sessions s JOIN subtree t ON s.parent_session_id = t.id
     )
     SELECT id FROM subtree`
  ).all(rootId).map((row) => String((row as Record<string, unknown>)['id']))
}

/**
 * 删一条会话,连同它派生出来的全部子代理转录。返回真正删掉的那些 id。
 *
 * ★ 级联写在 repo 而不是 `state/store.ts`:`deleteByAge` 和 `deleteAllHistory`
 * 都是在**这个文件内部**调 `deleteSession` 的,级联放外面等于让那两条路径
 * 继续留下子转录 —— 而子转录在过滤之后是**不朽的**:没有任何枚举看得见它,
 * 也没有任何清理路径遍历得到它。
 */
export function deleteSession(id: string): string[] {
  return tx(() => {
    const ids = sessionSubtreeIds(id)
    // 先叶后根。sessions 之间没有真外键(理由见 schema.ts 第 10 条),
    // 顺序其实无所谓;保持和 CASCADE 同向,便于将来真加外键时不用重排。
    for (const sid of [...ids].reverse()) {
      stmt('DELETE FROM messages_fts WHERE session_id = ?').run(sid)
      stmt('DELETE FROM sessions WHERE id = ?').run(sid)
      // 草稿附件没有 session_id（外键要求上传时会话可以尚未创建），
      // 因此不能只依赖 CASCADE；owner_id 是它们的会话归属。
      stmt("DELETE FROM attachments WHERE scope = 'session' AND owner_id = ?").run(sid)
      removeKv(`session.input.${sid}`)
    }
    return ids
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
    sessions: listExportableSessionDetails(),
    providers: listProviders().filter((p) => p.id !== 'nextcowork'),
    aliases: listAliases().filter((a) => a.providerId !== 'nextcowork'),
    mcpServers: listMcpServers(),
    // 导出的是实际配置行，不把目录里的默认项伪造成用户配置。
    searchProviders: listStoredSearchProviders(),
    disabledSkillIds: (() => {
      const raw = getKv<unknown>('skills.disabled', [])
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    })()
  }
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
      const decision = dataMergeDecision(local, w)
      if (decision !== 'skip') {
        putWorkspace({ ...w, unavailable: !existsSync(w.rootPath) })
        imported++
        workspacesImported++
        if (decision === 'overwrite') overwritten++
      } else skipped++
    }
    for (const p of data.providers) {
      if (p.id === 'nextcowork') continue
      const local = listProviders().find((x) => x.id === p.id)
      const decision = dataMergeDecision(local, p)
      if (decision !== 'skip') {
        // `credentialRef` is not trusted import data. Preserve a legacy ref
        // already owned by this local provider; otherwise derive the same ref
        // as the provider IPC write boundary.
        putProvider({
          ...p,
          credentialRef: local?.credentialRef ?? providerCredentialRef(p.id)
        })
        imported++
        if (decision === 'overwrite') overwritten++
      } else skipped++
    }
    for (const a of data.aliases) {
      if (a.providerId === 'nextcowork') continue
      const local = listAliases().find((x) => x.providerId === a.providerId && x.alias === a.alias)
      const decision = dataMergeDecision(local, a)
      if (decision !== 'skip') { putAlias(a); imported++; if (decision === 'overwrite') overwritten++ } else skipped++
    }
    for (const c of data.mcpServers) {
      const local = getMcpServer(c.id)
      const decision = dataMergeDecision(local, c)
      if (decision !== 'skip') { putMcpServer(c); imported++; if (decision === 'overwrite') overwritten++ } else skipped++
    }
    for (const c of data.searchProviders) {
      const local = listStoredSearchProviders().find((x) => x.id === c.id)
      const decision = dataMergeDecision(local, c)
      if (decision !== 'skip') { putSearchProvider(c); imported++; if (decision === 'overwrite') overwritten++ } else skipped++
    }
    setKv('skills.disabled', data.disabledSkillIds)

    for (const item of data.sessions) {
      /*
        ★ 子代理转录一律丢弃,不计进 imported/skipped —— 它们不是用户实体。

        新导出根本不含它们(`listExportableSessionDetails`),这一条挡的是**旧文件**:
        那时候子会话既没有 `parentSessionId`、又确实被导了出去,原样写回库
        就等于用一次导入把「侧边栏里一堆新对话」这个 bug 完整还原。
        父转录里的子代理收据只带 `childRunId`(进程内路由键,重启即失效),
        不引用会话 id,所以丢掉它们不会在任何地方留下悬空引用。
      */
      if (item.session.parentSessionId !== undefined || item.session.id.includes(':sub:')) continue
      const local = getSession(item.session.id)
      const decision = dataMergeDecision(local, item.session)
      if (decision === 'skip') { skipped++; continue }
      if (decision === 'overwrite') overwritten++
      putSession(item.session)
      replaceHistory(item.session.id, item.messages)
      // 检查点与会话历史一起导入；旧导出没有该字段时按空数组处理。
      for (const checkpoint of item.contextCheckpoints ?? []) {
        upsertContextCheckpoint(checkpoint)
      }
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

/**
 * 返回指定会话的附件；包括尚未提交、只用 owner_id 归属的草稿。
 *
 * ★ 展开子代理转录,而且是在**这里**展开,不在调用方。
 * `deleteSession` 是级联的,所以「会消失的附件」天然包含子会话那部分;
 * 而 `cleanupPreview` 算字节数、`storage.ts` 的 `withActualAttachmentBytes`
 * 换算真实大小、`sessionAttachmentPaths` 抢在级联之前记路径 —— 这三处**必须**
 * 用同一个集合,否则预览的数字和实际删掉的量对不上,或者磁盘上留下永久孤儿文件。
 * 收在这个函数里,四个调用点一行都不用改,也不会有人漏掉其中一个。
 */
export function attachmentRowsForSessions(sessionIds: readonly string[]): AttachmentReferenceRow[] {
  if (sessionIds.length === 0) return []
  /*
    ★ 传进来的 id **原样保留**,不能只用子树查询的结果:草稿附件可以早于
    `sessions` 行存在(用户新建对话、传了图、还没点发送),那种 id 在表里查不到,
    而它正是这个函数最要紧的一类归属。子树只负责**多**认一些,不负责筛。
  */
  const wanted = new Set([...sessionIds, ...sessionIds.flatMap((id) => sessionSubtreeIds(id))])
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

/**
 * 按会话更新时间取待删 ID，避免 storage 层重复拼接 SQL。
 *
 * ★ 只取顶层。子代理转录不是「一条对话」,不该出现在「删除 N 天前的会话」
 * 那个数字里 —— 它们由 `deleteSession` 跟着父一起走。
 */
export function sessionIdsBefore(cutoff: number): string[] {
  return stmt('SELECT id FROM sessions WHERE updated_at < ? AND parent_session_id IS NULL').all(cutoff)
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
  // 四条 SQL 都带 `s.parent_session_id IS NULL`:子代理转录不是用户的对话,
  // 搜出来只会给出一条点不开、也没有上下文的命中。FTS 与 LIKE 兜底都要,
  // 漏掉兜底那条的话,这个泄漏会在旧库/极端 Unicode 上悄悄复活。
  const phrase = `"${trimmed.replaceAll('"', '""')}"`
  try {
    const rows = workspaceId === undefined
      ? stmt(`SELECT f.session_id, f.message_id, s.workspace_id, s.title, snippet(messages_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet, m.created_at
              FROM messages_fts f JOIN sessions s ON s.id = f.session_id JOIN messages m ON m.id = f.message_id
              WHERE s.parent_session_id IS NULL AND messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`).all(phrase, safeLimit)
      : stmt(`SELECT f.session_id, f.message_id, s.workspace_id, s.title, snippet(messages_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet, m.created_at
              FROM messages_fts f JOIN sessions s ON s.id = f.session_id JOIN messages m ON m.id = f.message_id
              WHERE s.workspace_id = ? AND s.parent_session_id IS NULL AND messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`).all(workspaceId, phrase, safeLimit)
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return { sessionId: String(r['session_id']), workspaceId: String(r['workspace_id']), messageId: String(r['message_id']), title: String(r['title']), snippet: String(r['snippet'] ?? ''), createdAt: Number(r['created_at']) }
    })
  } catch {
    // FTS 对极端 Unicode/旧数据库失败时，退回 LIKE，搜索仍可用。
    const like = `%${trimmed}%`
    const rows = workspaceId === undefined
      ? stmt(`SELECT m.session_id, m.id AS message_id, s.workspace_id, s.title, substr(m.parts, 1, 240) AS snippet, m.created_at
              FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.parent_session_id IS NULL AND m.parts LIKE ? ORDER BY m.created_at DESC LIMIT ?`).all(like, safeLimit)
      : stmt(`SELECT m.session_id, m.id AS message_id, s.workspace_id, s.title, substr(m.parts, 1, 240) AS snippet, m.created_at
              FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.workspace_id = ? AND s.parent_session_id IS NULL AND m.parts LIKE ? ORDER BY m.created_at DESC LIMIT ?`).all(workspaceId, like, safeLimit)
    return rows.map((row) => { const r = row as Record<string, unknown>; return { sessionId: String(r['session_id']), workspaceId: String(r['workspace_id']), messageId: String(r['message_id']), title: String(r['title']), snippet: String(r['snippet'] ?? ''), createdAt: Number(r['created_at']) } })
  }
}

/** 为上下文窗口提供当前会话范围的历史检索，复用 messages_fts，避免跨任务串入。 */
export function searchSessionHistory(sessionId: string, q: string, limit = 5): ContextSearchHit[] {
  const trimmed = q.trim()
  if (trimmed === '') return []
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit)))
  const phrase = `"${trimmed.replaceAll('"', '""')}"`
  try {
    const rows = stmt(`SELECT f.message_id, m.role, m.created_at,
              snippet(messages_fts, 3, '', '', '…', 10) AS snippet
              FROM messages_fts f JOIN messages m ON m.id = f.message_id
              WHERE f.session_id = ? AND messages_fts MATCH ?
              ORDER BY m.created_at DESC LIMIT ?`).all(sessionId, phrase, safeLimit)
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return {
        messageId: String(r['message_id']),
        role: String(r['role']) as ContextSearchHit['role'],
        createdAt: Number(r['created_at']),
        snippet: String(r['snippet'] ?? '').slice(0, 600)
      }
    })
  } catch {
    const like = `%${trimmed}%`
    const rows = stmt(`SELECT id AS message_id, role, created_at, substr(parts, 1, 600) AS snippet
              FROM messages WHERE session_id = ? AND parts LIKE ?
              ORDER BY created_at DESC LIMIT ?`).all(sessionId, like, safeLimit)
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return {
        messageId: String(r['message_id']),
        role: String(r['role']) as ContextSearchHit['role'],
        createdAt: Number(r['created_at']),
        snippet: String(r['snippet'] ?? '').slice(0, 600)
      }
    })
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
    /*
      ★ 两个集合,不是一个:

      `sessionCount` 数**顶层** —— 确认框里那句话是「将删除 N 条对话」,
      而子代理转录不是一条对话,算进去就是虚报。
      `messageCount` / `bytes` 数**整棵子树** —— 这些是真正会消失的字节。
      漏掉子会话的消息,预览数字就和 `deleteByAge` 实际删掉的量对不上,
      而那个差额没有任何地方会解释。
    */
    const topIds = sessionIdsBefore(cutoff ?? 0)
    const ids = topIds.flatMap((id) => sessionSubtreeIds(id))
    // attachmentRowsForSessions 内部也会展开子树;传顶层即可,而且必须和
    // storage.ts 的 withActualAttachmentBytes 走同一个函数(见那边的注释)。
    const attachmentRows = attachmentRowsForSessions(topIds)
    let messageCount = 0
    let messageBytes = 0
    for (const id of ids) {
      for (const row of stmt('SELECT parts FROM messages WHERE session_id = ?').all(id)) {
        messageCount += 1
        messageBytes += Buffer.byteLength(String((row as Record<string, unknown>)['parts'] ?? ''), 'utf8')
      }
    }
    return { kind, sessionCount: topIds.length, messageCount, attachmentCount: attachmentRows.length, bytes: messageBytes + attachmentRows.reduce((n, row) => n + row.size, 0), undeletable: [] }
  }
  // 只有 sessionCount 过滤:清历史确实会连子转录一起删掉,所以字节数照全量算。
  const c = stmt(`SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL`).get() as Record<string, unknown>
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
  // 「本机有几条对话」数的是顶层;子代理转录占的字节仍然照实计入下面的 messageBytes()。
  const s = stmt('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL').get() as Record<string, unknown>
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

// ── User model catalogue ───────────────────────────────────────────────────

/**
 * Only user-created definitions are persisted. Built-in definitions ship in
 * source control and must not be copied into SQLite: otherwise an application
 * upgrade could never add or correct a built-in row for an existing user.
 */
const USER_MODEL_CATALOG_KEY = 'model-catalog.custom'

export function listUserModelCatalog(): ModelCatalogDefinition[] {
  const raw = getKv<unknown>(USER_MODEL_CATALOG_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw.filter(isModelCatalogDefinition)
}

export function putUserModelCatalog(model: ModelCatalogDefinition): ModelCatalogDefinition {
  if (!isModelCatalogDefinition(model)) throw new Error('自定义模型目录记录格式无效。')
  return tx(() => {
    const rows = listUserModelCatalog()
    const key = model.id.trim().toLowerCase()
    const index = rows.findIndex((row) => row.id.trim().toLowerCase() === key)
    if (index === -1) rows.push(model)
    else rows[index] = model
    setKv(USER_MODEL_CATALOG_KEY, rows)
    return model
  })
}

export function removeUserModelCatalog(id: string): void {
  tx(() => {
    const rows = listUserModelCatalog()
    const key = id.trim().toLowerCase()
    const next = rows.filter((row) => row.id.trim().toLowerCase() !== key)
    if (next.length === rows.length) return
    setKv(USER_MODEL_CATALOG_KEY, next)
  })
}

// ── usage records ──────────────────────────────────────────────────────────

const asNullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

function usageRecordFromRow(row: Record<string, unknown>): UsageAttemptRecord {
  return {
    id: String(row['id']),
    at: Number(row['at']),
    runId: String(row['run_id']),
    workspaceId: String(row['workspace_id'] ?? ''),
    sessionId: String(row['session_id'] ?? ''),
    attempt: Number(row['attempt'] ?? 1),
    providerId: String(row['provider_id']),
    providerName: String(row['provider_name'] || row['provider_id']),
    protocol: String(row['protocol'] ?? 'unknown') as UsageAttemptRecord['protocol'],
    endpoint: String(row['endpoint'] ?? ''),
    alias: String(row['alias']),
    upstreamModel: String(row['upstream_model']),
    responseModel: asNullableString(row['response_model']),
    inputTokens: Number(row['input_tokens'] ?? 0),
    outputTokens: Number(row['output_tokens'] ?? 0),
    cacheReadTokens: Number(row['cache_read_tokens'] ?? 0),
    cacheWriteTokens: Number(row['cache_write_tokens'] ?? 0),
    cacheWrite1hTokens: Number(row['cache_write_1h_tokens'] ?? 0),
    thinkingTokens:
      row['thinking_tokens'] === null || row['thinking_tokens'] === undefined
        ? null
        : Number(row['thinking_tokens']),
    thinkingTokensEstimated: Number(row['thinking_tokens_estimated'] ?? 0) !== 0,
    latencyMs: Number(row['latency_ms']),
    timeToFirstTokenMs:
      row['time_to_first_token_ms'] === null || row['time_to_first_token_ms'] === undefined
        ? null
        : Number(row['time_to_first_token_ms']),
    ok: Number(row['ok']) !== 0,
    httpStatus:
      row['http_status'] === null || row['http_status'] === undefined
        ? null
        : Number(row['http_status']),
    errorKind: asNullableString(row['error_kind']) as UsageAttemptRecord['errorKind'],
    errorMessage: asNullableString(row['error_message']),
    stopReason: asNullableString(row['stop_reason']) as UsageAttemptRecord['stopReason'],
    costMicros:
      row['cost_micros'] === null || row['cost_micros'] === undefined
        ? null
        : Number(row['cost_micros']),
    currency: asNullableString(row['currency']) as UsageAttemptRecord['currency'],
    pricingTier:
      row['pricing_tier'] === null || row['pricing_tier'] === undefined
        ? null
        : Number(row['pricing_tier']),
    pricingWindow: asNullableString(row['pricing_window']),
    toolCalls: Number(row['tool_calls'] ?? 0),
    toolErrors: Number(row['tool_errors'] ?? 0)
  }
}

/**
 * The initial write boundary for one upstream-attempt ledger row. Token,
 * routing, latency, and pricing fields are frozen here. Tool execution happens
 * after the upstream stream closes, so only its two outcome counters are
 * finalized later by `updateUsageToolsForRun`.
 */
export function recordUsageAttempt(record: UsageAttemptRecord): void {
  stmt(
    `INSERT INTO usage_records
       (id, at, run_id, workspace_id, session_id, attempt,
        provider_id, provider_name, protocol, endpoint, alias, upstream_model, response_model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_1h_tokens, thinking_tokens, thinking_tokens_estimated,
        latency_ms, time_to_first_token_ms, ok, http_status, error_kind, error_message,
        stop_reason, cost_micros, currency, pricing_tier, pricing_window, tool_calls, tool_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.at,
    record.runId,
    record.workspaceId,
    record.sessionId,
    record.attempt,
    record.providerId,
    record.providerName,
    record.protocol,
    record.endpoint,
    record.alias,
    record.upstreamModel,
    record.responseModel,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
    record.cacheWrite1hTokens,
    record.thinkingTokens,
    record.thinkingTokensEstimated ? 1 : 0,
    record.latencyMs,
    record.timeToFirstTokenMs,
    record.ok ? 1 : 0,
    record.httpStatus,
    record.errorKind,
    record.errorMessage,
    record.stopReason,
    record.costMicros,
    record.currency,
    record.pricingTier,
    record.pricingWindow,
    record.toolCalls,
    record.toolErrors
  )
}

/**
 * Attach post-response tool outcomes to the successful tool-use attempt that
 * produced them. Retries share a run id, while only the winning attempt can
 * reach tool execution; restricting by stop_reason keeps a later final text
 * turn from receiving counters that belong to an earlier tool-use turn.
 */
export function updateUsageToolsForRun(
  runId: string,
  toolCalls: number,
  toolErrors: number
): boolean {
  const result = stmt(
    `UPDATE usage_records
        SET tool_calls = ?, tool_errors = ?
      WHERE id = (
        SELECT id
          FROM usage_records
         WHERE run_id = ? AND ok = 1 AND stop_reason = 'tool_use'
         ORDER BY at DESC, id DESC
         LIMIT 1
      )`
  ).run(toolCalls, toolErrors, runId)
  return Number(result.changes) > 0
}

function usageWindowWhere(window: UsageWindow): { sql: string; params: number[] } {
  const clauses = ['at < ?']
  const params = [window.to]
  if (window.from !== undefined) {
    clauses.unshift('at >= ?')
    params.unshift(window.from)
  }
  return { sql: clauses.join(' AND '), params }
}

function usageCosts(window: UsageWindow): UsageCostTotal[] {
  const where = usageWindowWhere(window)
  return stmt(
    `SELECT currency, SUM(cost_micros) AS micros
       FROM usage_records
      WHERE ${where.sql} AND cost_micros IS NOT NULL AND currency IS NOT NULL
      GROUP BY currency
      ORDER BY currency`
  )
    .all(...where.params)
    .map((row) => ({
      currency: String(row['currency']) as UsageCostTotal['currency'],
      micros: Number(row['micros'] ?? 0)
    }))
}

export function getUsageSummary(window: UsageWindow): UsageSummary {
  const where = usageWindowWhere(window)
  const row = stmt(
    `SELECT
       COUNT(*) AS request_count,
       COALESCE(SUM(ok), 0) AS success_count,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
       COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
       COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
       COALESCE(SUM(CASE WHEN thinking_tokens_estimated <> 0 THEN 1 ELSE 0 END), 0)
         AS estimated_thinking_request_count,
       AVG(latency_ms) AS average_latency_ms,
       AVG(time_to_first_token_ms) AS average_ttft_ms,
       COALESCE(SUM(tool_calls), 0) AS tool_calls,
       COALESCE(SUM(tool_errors), 0) AS tool_errors
     FROM usage_records
     WHERE ${where.sql}`
  ).get(...where.params) ?? {}

  const requestCount = Number(row['request_count'] ?? 0)
  const successCount = Number(row['success_count'] ?? 0)
  const inputTokens = Number(row['input_tokens'] ?? 0)
  const outputTokens = Number(row['output_tokens'] ?? 0)
  const cacheReadTokens = Number(row['cache_read_tokens'] ?? 0)
  const cacheWriteTokens = Number(row['cache_write_tokens'] ?? 0)
  const cacheDenominator = inputTokens + cacheReadTokens

  return {
    requestCount,
    successCount,
    failedCount: requestCount - successCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: Number(row['cache_write_1h_tokens'] ?? 0),
    thinkingTokens: Number(row['thinking_tokens'] ?? 0),
    estimatedThinkingRequestCount: Number(row['estimated_thinking_request_count'] ?? 0),
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheHitRate: cacheDenominator === 0 ? null : cacheReadTokens / cacheDenominator,
    averageLatencyMs:
      row['average_latency_ms'] === null || row['average_latency_ms'] === undefined
        ? null
        : Number(row['average_latency_ms']),
    averageTimeToFirstTokenMs:
      row['average_ttft_ms'] === null || row['average_ttft_ms'] === undefined
        ? null
        : Number(row['average_ttft_ms']),
    toolCalls: Number(row['tool_calls'] ?? 0),
    toolErrors: Number(row['tool_errors'] ?? 0),
    costs: usageCosts(window)
  }
}

function usageLogWhere(query: UsageRequestLogsQuery): {
  sql: string
  params: Array<string | number>
} {
  const window = usageWindowWhere(query)
  const clauses = [window.sql]
  const params: Array<string | number> = [...window.params]
  const search = query.query?.trim()
  if (search) {
    clauses.push(
      `instr(lower(provider_name || ' ' || provider_id || ' ' || alias || ' ' || upstream_model || ' ' || run_id), lower(?)) > 0`
    )
    params.push(search)
  }
  if (query.status === 'success') clauses.push('ok = 1')
  else if (query.status === 'failed') clauses.push('ok = 0')
  return { sql: clauses.join(' AND '), params }
}

export function getUsageRequestLogs(query: UsageRequestLogsQuery): UsageRequestLogsPage {
  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)))
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const where = usageLogWhere(query)
  const total = Number(
    stmt(`SELECT COUNT(*) AS count FROM usage_records WHERE ${where.sql}`)
      .get(...where.params)?.['count'] ?? 0
  )
  const items = stmt(
    `SELECT * FROM usage_records
      WHERE ${where.sql}
      ORDER BY at DESC, id DESC
      LIMIT ? OFFSET ?`
  )
    .all(...where.params, limit, offset)
    .map(usageRecordFromRow)
  return { items, total, offset, limit }
}

type UsageDimension = 'provider' | 'model'

function getUsageDimensionStats(
  window: UsageWindow,
  dimension: UsageDimension
): UsageDimensionStat[] {
  const where = usageWindowWhere(window)
  const idColumn = dimension === 'provider' ? 'provider_id' : 'upstream_model'
  const labelExpression =
    dimension === 'provider'
      ? `COALESCE(NULLIF(MAX(provider_name), ''), provider_id)`
      : 'upstream_model'
  const rows = stmt(
    `SELECT
       ${idColumn} AS dimension_id,
       ${labelExpression} AS dimension_label,
       COUNT(*) AS request_count,
       COALESCE(SUM(ok), 0) AS success_count,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
       COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
       AVG(latency_ms) AS average_latency_ms,
       AVG(time_to_first_token_ms) AS average_ttft_ms,
       COALESCE(SUM(tool_calls), 0) AS tool_calls,
       COALESCE(SUM(tool_errors), 0) AS tool_errors
     FROM usage_records
     WHERE ${where.sql}
     GROUP BY ${idColumn}
     ORDER BY request_count DESC, dimension_label
     LIMIT 200`
  ).all(...where.params)

  const stats = new Map<string, UsageDimensionStat>()
  for (const row of rows) {
    const id = String(row['dimension_id'])
    stats.set(id, {
      id,
      label: String(row['dimension_label']),
      requestCount: Number(row['request_count'] ?? 0),
      successCount: Number(row['success_count'] ?? 0),
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      cacheReadTokens: Number(row['cache_read_tokens'] ?? 0),
      cacheWriteTokens: Number(row['cache_write_tokens'] ?? 0),
      thinkingTokens: Number(row['thinking_tokens'] ?? 0),
      averageLatencyMs:
        row['average_latency_ms'] === null || row['average_latency_ms'] === undefined
          ? null
          : Number(row['average_latency_ms']),
      averageTimeToFirstTokenMs:
        row['average_ttft_ms'] === null || row['average_ttft_ms'] === undefined
          ? null
          : Number(row['average_ttft_ms']),
      toolCalls: Number(row['tool_calls'] ?? 0),
      toolErrors: Number(row['tool_errors'] ?? 0),
      costs: []
    })
  }

  const costRows = stmt(
    `SELECT ${idColumn} AS dimension_id, currency, SUM(cost_micros) AS micros
       FROM usage_records
      WHERE ${where.sql} AND cost_micros IS NOT NULL AND currency IS NOT NULL
      GROUP BY ${idColumn}, currency
      ORDER BY ${idColumn}, currency`
  ).all(...where.params)
  for (const row of costRows) {
    const target = stats.get(String(row['dimension_id']))
    if (target === undefined) continue
    target.costs.push({
      currency: String(row['currency']) as UsageCostTotal['currency'],
      micros: Number(row['micros'] ?? 0)
    })
  }
  return [...stats.values()]
}

export function getUsageProviderStats(window: UsageWindow): UsageDimensionStat[] {
  return getUsageDimensionStats(window, 'provider')
}

export function getUsageModelStats(window: UsageWindow): UsageDimensionStat[] {
  return getUsageDimensionStats(window, 'model')
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
