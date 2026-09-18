/** 只读 OpenCoWork 适配器。输入只有:data.db(SQLite)、ai-provider/*.json、mcp-servers.json、hooks.json、agents|commands/*.md、~/.agents/skills。 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { IMPORT_LIMITS, type ImportDiagnostic, type ImportSourceAvailability } from '../../shared/domain/import'
import { protocolFromProviderType, type OpencoworkProviderConfig } from './opencowork-provider'
import type { OpencoworkHookEntry } from './opencowork-hooks'

type Json = Record<string, unknown>
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'bigint' ? Number(value) : 0)
const CONFIG_MAX_BYTES = 4 * 1024 * 1024

export interface OpencoworkSource {
  sourceId: string
  /** `~/.open-cowork`(或用户手选的目录)。 */
  configDir: string
  origin: 'auto' | 'user-picked'
  availability: ImportSourceAvailability
  diagnostics: ImportDiagnostic[]
}

/** 一条会话的元数据(不含正文)。 */
export interface OpencoworkSessionMeta {
  id: string
  title: string
  /** ★ 项目路径的唯一可信来源,与 OpenCode 的 `directory` 同一个角色。 */
  workingFolder: string
  providerId?: string
  modelId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface OpencoworkRawMessage {
  id: string
  role: string
  /** 已 `JSON.parse` 过的 `content` 列:`string | ContentBlock[]`。 */
  content: unknown
  createdAt: number
}
export interface OpencoworkRawSession {
  session: OpencoworkSessionMeta
  messages: OpencoworkRawMessage[]
}

// ═══════════════════════════════════════════════════════════════
// 探测与路径收口
// ═══════════════════════════════════════════════════════════════

export async function detectOpencoworkSource(pickedDir?: string): Promise<OpencoworkSource> {
  const dir = pickedDir || join(homedir(), '.open-cowork')
  const origin = pickedDir ? 'user-picked' : 'auto'
  try {
    const dataDir = await realpath(resolve(dir))
    if (!(await stat(dataDir)).isDirectory()) throw new Error('not-found')
    const dbPath = await resolveWithin(dataDir, 'data.db')
    if (!dbPath || !(await stat(dbPath)).isFile()) throw new Error('not-found')
    return { sourceId: `opencowork-${digest(['opencowork', dataDir]).slice(0, 16)}`, configDir: dataDir, origin, availability: 'detected', diagnostics: [] }
  } catch (error) {
    const denied = ['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))
    return { sourceId: '', configDir: '', origin, availability: denied ? 'denied' : 'not-found', diagnostics: [{ code: denied ? 'source.denied' : 'source.not-found', detail: dir }] }
  }
}

/** 把 `parts` 解析相对到已授权的根,绝对/越界段一律拒绝。 */
export async function resolveWithin(root: string, ...parts: string[]): Promise<string | null> {
  try {
    const [target, realRoot] = await Promise.all([realpath(resolve(root, ...parts)), realpath(root)])
    return target === realRoot || target.startsWith(realRoot + sep) ? target : null
  } catch {
    return null
  }
}

async function readTextBounded(path: string, max = CONFIG_MAX_BYTES): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > max) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════
// SQLite 只读读取
// ═══════════════════════════════════════════════════════════════

/** ★ 只读打开。不跑任何 PRAGMA,源库一字节不动。 */
function openDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, 'data.db'), { readOnly: true })
}

function toSessionMeta(row: Json): OpencoworkSessionMeta {
  return {
    id: string(row['id']) ?? '',
    title: string(row['title']) ?? '',
    workingFolder: string(row['working_folder']) ?? '',
    ...(string(row['provider_id']) ? { providerId: string(row['provider_id']) } : {}),
    ...(string(row['model_id']) ? { modelId: string(row['model_id']) } : {}),
    createdAt: number(row['created_at']),
    updatedAt: number(row['updated_at']),
    messageCount: number(row['message_count'])
  }
}

export async function listOpencoworkSessions(dataDir: string, diagnostics: ImportDiagnostic[] = []): Promise<OpencoworkSessionMeta[]> {
  let db: DatabaseSync | null = null
  try {
    db = openDb(dataDir)
    const rows = db
      .prepare(
        `SELECT id, title, working_folder, provider_id, model_id, created_at, updated_at, message_count
         FROM sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(IMPORT_LIMITS.maxSessionsPerScan) as Json[]
    return rows.map(toSessionMeta).filter((s) => s.id !== '')
  } catch {
    diagnostics.push({ code: 'source.unreadable', detail: join(dataDir, 'data.db') })
    return []
  } finally {
    db?.close()
  }
}

export async function readOpencoworkSession(dataDir: string, sessionId: string): Promise<OpencoworkRawSession | null> {
  let db: DatabaseSync | null = null
  try {
    db = openDb(dataDir)
    const s = db
      .prepare('SELECT id, title, working_folder, provider_id, model_id, created_at, updated_at, message_count FROM sessions WHERE id = ?')
      .get(sessionId) as Json | undefined
    if (!s) return null
    const rows = db
      .prepare('SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY sort_order, id LIMIT ?')
      .all(sessionId, IMPORT_LIMITS.maxMessagesPerSession) as Json[]
    const messages: OpencoworkRawMessage[] = rows
      .map((row) => {
        let content: unknown = null
        try {
          content = JSON.parse(string(row['content']) ?? 'null')
        } catch {
          /* 解析不出来的行直接丢,不猜内容 */
        }
        return { id: string(row['id']) ?? '', role: string(row['role']) ?? '', content, createdAt: number(row['created_at']) }
      })
      .filter((m): m is OpencoworkRawMessage => m.id !== '' && m.content !== null)
    return { session: toSessionMeta(s), messages }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

// ═══════════════════════════════════════════════════════════════
// provider / mcp / 资产 / hook
// ═══════════════════════════════════════════════════════════════

/**
 * 读 `ai-provider/index.json` 取 provider id 列表;缺失时退化成直接扫目录里
 * 的 `provider-*.json`(镜像 OpenCoWork 自己 `ai-provider-store.ts` 的
 * `readSplitProviderStore` 两级 fallback)。**不读 `apiKey` 的值**,只记
 * 「是否非空」。
 */
export async function listOpencoworkProviders(dataDir: string): Promise<OpencoworkProviderConfig[]> {
  const dir = await resolveWithin(dataDir, 'ai-provider')
  if (!dir) return []

  let ids: string[] | null = null
  const indexPath = await resolveWithin(dir, 'index.json')
  if (indexPath) {
    const text = await readTextBounded(indexPath)
    if (text !== null) {
      try {
        const parsed = record(JSON.parse(text))
        if (Array.isArray(parsed['providerIds'])) {
          ids = parsed['providerIds'].filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        }
      } catch {
        /* 索引损坏就退化成目录扫描 */
      }
    }
  }
  if (ids === null) {
    const names = await readdir(dir).catch(() => [] as string[])
    ids = names
      .filter((name) => name.startsWith('provider-') && name.endsWith('.json'))
      .map((name) => {
        try {
          return decodeURIComponent(name.slice('provider-'.length, -'.json'.length))
        } catch {
          return ''
        }
      })
      .filter((id) => id !== '')
  }

  const out: OpencoworkProviderConfig[] = []
  const seen = new Set<string>()
  for (const rawId of ids) {
    const id = rawId.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const filePath = await resolveWithin(dir, `provider-${encodeURIComponent(id)}.json`)
    if (!filePath) continue
    const text = await readTextBounded(filePath)
    if (text === null) continue
    let raw: Json
    try {
      raw = record(JSON.parse(text))
    } catch {
      continue
    }
    if (string(raw['id']) !== id) continue

    const type = string(raw['type'])
    const protocol = protocolFromProviderType(type)
    const diagnostics: ImportDiagnostic[] = []
    const hasLocalKey = typeof raw['apiKey'] === 'string' && raw['apiKey'] !== ''
    if (hasLocalKey) diagnostics.push({ code: 'provider.needs-credentials' })
    if (protocol === null) diagnostics.push({ code: 'provider.needs-manual-setup', detail: type ?? 'type' })

    const models = Array.isArray(raw['models'])
      ? raw['models'].map((m) => string(record(m)['id'])).filter((m): m is string => m !== undefined)
      : []
    const rawUrl = string(raw['baseUrl']) ?? ''
    let baseUrl = ''
    try {
      const url = new URL(rawUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      if (url.username || url.password || url.search || url.hash) diagnostics.push({ code: 'provider.needs-manual-setup', detail: 'base_url' })
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      baseUrl = url.href
    } catch {
      diagnostics.push({ code: 'provider.needs-manual-setup', detail: 'base_url' })
    }
    const defaultModel = string(raw['defaultModel']) ?? models[0]
    if (defaultModel) diagnostics.push({ code: 'model.metadata-incomplete' })
    const normalized = {
      id,
      sourcePath: filePath,
      name: string(raw['name']) || id,
      protocol: protocol ?? ('openai-chat' as const),
      baseUrl,
      models,
      ...(defaultModel ? { defaultModel } : {}),
      hasLocalKey,
      diagnostics
    }
    out.push({ ...normalized, fingerprint: digest(normalized) })
  }
  return out
}

/** `mcp-servers.json`(JSON 数组)→ 既有 `mapMcpServer` 认得的形状。 */
export async function listOpencoworkMcp(dataDir: string): Promise<Record<string, unknown>> {
  const path = await resolveWithin(dataDir, 'mcp-servers.json')
  if (!path) return {}
  const text = await readTextBounded(path)
  if (text === null) return {}
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return {}
  }
  return normalizeOpencoworkMcp(list)
}

/** 纯函数部分:JSON 数组(已解析)→ 按名字归一化。分出来是为了单测不必落盘。 */
export function normalizeOpencoworkMcp(list: unknown): Record<string, unknown> {
  if (!Array.isArray(list)) return {}

  const out: Record<string, unknown> = {}
  for (const raw of list) {
    const v = record(raw)
    if (v['enabled'] === false) continue
    const name = string(v['name']) ?? string(v['id'])
    if (!name) continue
    const transport = string(v['transport'])
    if (transport === 'stdio') {
      out[name] = {
        type: 'stdio',
        command: string(v['command']) ?? '',
        args: Array.isArray(v['args']) ? v['args'].filter((a): a is string => typeof a === 'string') : [],
        ...(v['env'] !== undefined ? { env: v['env'] } : {}),
        ...(string(v['cwd']) ? { cwd: v['cwd'] } : {})
      }
    } else if (transport === 'sse' || transport === 'streamable-http') {
      out[name] = { type: transport, url: string(v['url']) ?? '', ...(v['headers'] !== undefined ? { headers: v['headers'] } : {}) }
    } else {
      out[name] = v
    }
  }
  return out
}

/** `~/.open-cowork/{agents,commands}/*.md`。frontmatter 校验与落盘复用 service.ts 里源无关的通用逻辑。 */
export async function listOpencoworkAssets(dataDir: string): Promise<{
  agents: Array<{ name: string; file: string }>
  commands: Array<{ name: string; file: string }>
}> {
  const markdown = async (sub: string): Promise<Array<{ name: string; file: string }>> => {
    const dir = await resolveWithin(dataDir, sub)
    if (!dir) return []
    const names = await readdir(dir).catch(() => [] as string[])
    const out: Array<{ name: string; file: string }> = []
    for (const raw of names.sort()) {
      if (!raw.endsWith('.md') || raw.startsWith('.')) continue
      const file = await resolveWithin(dir, raw)
      if (!file || !(await stat(file)).isFile()) continue
      out.push({ name: basename(raw, '.md'), file })
    }
    return out
  }
  return { agents: await markdown('agents'), commands: await markdown('commands') }
}

/**
 * `~/.agents/skills` —— ★ 和 Codex 导入器扫的是**同一个全局目录**
 * (见 `codex.ts` 的 `listCodexSkills`),OpenCoWork 没有项目级 skill 目录。
 */
export async function listOpencoworkSkills(): Promise<Array<{ name: string; dir: string }>> {
  const skillsDir = join(homedir(), '.agents', 'skills')
  const out: Array<{ name: string; dir: string }> = []
  const names = await readdir(skillsDir).catch(() => [] as string[])
  for (const raw of names.sort()) {
    if (raw.startsWith('.')) continue
    const dir = await resolveWithin(skillsDir, raw)
    if (!dir || !(await stat(dir)).isDirectory()) continue
    if (!(await resolveWithin(dir, 'SKILL.md'))) continue
    out.push({ name: raw, dir })
  }
  return out
}

/** `~/.open-cowork/hooks.json` 摊平成一条一个 handler。 */
export async function listOpencoworkHooks(dataDir: string, diagnostics: ImportDiagnostic[] = []): Promise<OpencoworkHookEntry[]> {
  const path = await resolveWithin(dataDir, 'hooks.json')
  if (!path) return []
  const text = await readTextBounded(path)
  if (text === null) return []
  let raw: Json
  try {
    raw = record(JSON.parse(text))
  } catch {
    diagnostics.push({ code: 'source.unreadable', detail: path })
    return []
  }

  const out: OpencoworkHookEntry[] = []
  const hooks = record(raw['hooks'])
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      const g = record(group)
      const matcher = string(g['matcher'])
      const handlers = Array.isArray(g['hooks']) ? g['hooks'] : []
      handlers.forEach((handler, handlerIndex) => {
        const h = record(handler)
        if (h['disabled'] === true) return
        out.push({
          event,
          ...(matcher ? { matcher } : {}),
          ...(string(h['command']) ? { command: string(h['command']) } : {}),
          handlerType: string(h['type']) ?? 'unknown',
          ...(typeof h['timeout'] === 'number' ? { timeout: h['timeout'] } : {}),
          ...(string(h['statusMessage']) ? { statusMessage: string(h['statusMessage']) } : {}),
          hasEnv: Object.keys(record(h['env'])).length > 0,
          sourcePath: path,
          sourceKey: `${event}:${groupIndex}:${handlerIndex}`
        })
      })
    })
  }
  return out
}
