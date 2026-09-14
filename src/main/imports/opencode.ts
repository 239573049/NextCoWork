/** 只读 OpenCode 适配器。输入只有:opencode.db(SQLite)、opencode.jsonc、auth.json、资产目录。 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { IMPORT_LIMITS, type ImportDiagnostic, type ImportSourceAvailability } from '../../shared/domain/import'
import { protocolFromNpm, type OpencodeProviderConfig } from './opencode-provider'

type Json = Record<string, unknown>
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'bigint' ? Number(value) : 0)
const CONFIG_MAX_BYTES = 4 * 1024 * 1024

export interface OpencodeSource {
  sourceId: string
  /** ★ 存的是 **data 目录**(会话主入口),对齐 detection.configDir 字段。 */
  configDir: string
  origin: 'auto' | 'env' | 'user-picked'
  availability: ImportSourceAvailability
  diagnostics: ImportDiagnostic[]
}

/** 一条会话的元数据(不含正文)。size 用消息数近似,界面只作展示。 */
export interface OpencodeSessionMeta {
  id: string
  projectId: string
  /** cwd —— ★ 项目路径的唯一可信来源(project.worktree 常是 `/`,不可靠)。 */
  directory: string
  title: string
  model?: { providerID?: string; modelID?: string }
  parentId?: string
  createdAt: number
  updatedAt: number
  archived: boolean
  messageCount: number
}

export interface OpencodeRawMessage {
  id: string
  data: Json
  createdAt: number
}
export interface OpencodeRawPart {
  messageId: string
  data: Json
  createdAt: number
}
export interface OpencodeRawSession {
  session: OpencodeSessionMeta
  messages: OpencodeRawMessage[]
  parts: OpencodeRawPart[]
}

export interface OpencodeAssets {
  skills: Array<{ name: string; dir: string }>
  agents: Array<{ name: string; file: string }>
  commands: Array<{ name: string; file: string }>
}

// ═══════════════════════════════════════════════════════════════
// 探测与路径收口
// ═══════════════════════════════════════════════════════════════

export async function detectOpencodeSource(pickedDir?: string): Promise<OpencodeSource> {
  const envDir = process.env['XDG_DATA_HOME']
  const dir = pickedDir || (envDir ? join(envDir, 'opencode') : join(homedir(), '.local', 'share', 'opencode'))
  const origin = pickedDir ? 'user-picked' : envDir ? 'env' : 'auto'
  try {
    const dataDir = await realpath(resolve(dir))
    if (!(await stat(dataDir)).isDirectory()) throw new Error('not-found')
    const dbPath = await resolveWithin(dataDir, 'opencode.db')
    if (!dbPath || !(await stat(dbPath)).isFile()) throw new Error('not-found')
    return { sourceId: `opencode-${digest(['opencode', dataDir]).slice(0, 16)}`, configDir: dataDir, origin, availability: 'detected', diagnostics: [] }
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

/** 配置目录(provider/mcp/plugin/资产)。data 与 config 在 OpenCode 里是**两处**。 */
export function opencodeConfigDir(): string {
  const envCfg = process.env['XDG_CONFIG_HOME']
  return envCfg ? join(envCfg, 'opencode') : join(homedir(), '.config', 'opencode')
}

// ═══════════════════════════════════════════════════════════════
// SQLite 只读读取
// ═══════════════════════════════════════════════════════════════

/** ★ 只读打开。不跑任何 PRAGMA(只读连接改不了 journal_mode),源库一字节不动。 */
function openDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, 'opencode.db'), { readOnly: true })
}

function toSessionMeta(row: Json): OpencodeSessionMeta {
  let model: OpencodeSessionMeta['model']
  const rawModel = string(row['model'])
  if (rawModel) {
    try {
      const parsed = record(JSON.parse(rawModel))
      model = { ...(string(parsed['providerID']) ? { providerID: string(parsed['providerID']) } : {}), ...(string(parsed['modelID']) ?? string(parsed['id']) ? { modelID: string(parsed['modelID']) ?? string(parsed['id']) } : {}) }
    } catch {
      /* 模型列非法就当没有 */
    }
  }
  return {
    id: string(row['id']) ?? '',
    projectId: string(row['project_id']) ?? '',
    directory: string(row['directory']) ?? '',
    title: string(row['title']) ?? '',
    ...(model ? { model } : {}),
    ...(string(row['parent_id']) ? { parentId: string(row['parent_id']) } : {}),
    createdAt: number(row['time_created']),
    updatedAt: number(row['time_updated']),
    archived: row['time_archived'] != null,
    messageCount: number(row['message_count'])
  }
}

export async function listOpencodeSessions(dataDir: string, diagnostics: ImportDiagnostic[] = []): Promise<OpencodeSessionMeta[]> {
  let db: DatabaseSync | null = null
  try {
    db = openDb(dataDir)
    const rows = db
      .prepare(
        `SELECT s.id, s.project_id, s.directory, s.title, s.model, s.parent_id, s.time_created, s.time_updated, s.time_archived,
                (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS message_count
         FROM session s ORDER BY s.time_updated DESC LIMIT ?`
      )
      .all(IMPORT_LIMITS.maxSessionsPerScan) as Json[]
    return rows.map(toSessionMeta).filter((s) => s.id !== '')
  } catch {
    diagnostics.push({ code: 'source.unreadable', detail: join(dataDir, 'opencode.db') })
    return []
  } finally {
    db?.close()
  }
}

export async function readOpencodeSession(dataDir: string, sessionId: string): Promise<OpencodeRawSession | null> {
  let db: DatabaseSync | null = null
  try {
    db = openDb(dataDir)
    const s = db
      .prepare('SELECT id, project_id, directory, title, model, parent_id, time_created, time_updated, time_archived FROM session WHERE id = ?')
      .get(sessionId) as Json | undefined
    if (!s) return null
    const parseData = (value: unknown): Json | null => {
      try {
        return record(JSON.parse(string(value) ?? '{}'))
      } catch {
        return null
      }
    }
    const messages = (db.prepare('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?').all(sessionId, IMPORT_LIMITS.maxMessagesPerSession) as Json[])
      .map((row) => ({ id: string(row['id']) ?? '', data: parseData(row['data']), createdAt: number(row['time_created']) }))
      .filter((m): m is OpencodeRawMessage => m.data !== null && m.id !== '')
    const parts = (db.prepare('SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created, id LIMIT ?').all(sessionId, IMPORT_LIMITS.maxMessagesPerSession * 40) as Json[])
      .map((row) => ({ messageId: string(row['message_id']) ?? '', data: parseData(row['data']), createdAt: number(row['time_created']) }))
      .filter((p): p is OpencodeRawPart => p.data !== null && p.messageId !== '')
    return { session: toSessionMeta({ ...s, message_count: messages.length }), messages, parts }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

// ═══════════════════════════════════════════════════════════════
// JSONC 与配置
// ═══════════════════════════════════════════════════════════════

/**
 * 容错解析 JSONC。★ 剥注释时**尊重字符串字面量** —— 否则 `"https://…"` 里的
 * `//` 会被当成行注释削掉,配置直接解析失败。只认双引号(JSON 标准),
 * 顺带去掉对象/数组结尾的尾逗号。
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i] as string
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i += 1
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
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

export async function readOpencodeConfig(configDir: string, diagnostics: ImportDiagnostic[] = []): Promise<{ config: Json; path: string }> {
  for (const name of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    const path = await resolveWithin(configDir, name)
    if (!path) continue
    const text = await readTextBounded(path)
    if (text === null) continue
    try {
      return { config: record(parseJsonc(text)), path }
    } catch {
      diagnostics.push({ code: 'source.unreadable', detail: path })
      return { config: {}, path }
    }
  }
  return { config: {}, path: join(configDir, 'opencode.jsonc') }
}

/** auth.json 里已登记凭证的 provider id。★ **只取键名**,值不进任何返回。 */
export async function readOpencodeAuthNames(dataDir: string): Promise<Set<string>> {
  const path = await resolveWithin(dataDir, 'auth.json')
  if (!path) return new Set()
  const text = await readTextBounded(path)
  if (text === null) return new Set()
  try {
    return new Set(Object.keys(record(JSON.parse(text))))
  } catch {
    return new Set()
  }
}

// ═══════════════════════════════════════════════════════════════
// provider / mcp / plugin / 资产
// ═══════════════════════════════════════════════════════════════

export function listOpencodeProviders(config: Json, authNames: ReadonlySet<string>, sourcePath: string): OpencodeProviderConfig[] {
  const providers = record(config['provider'])
  const out: OpencodeProviderConfig[] = []
  for (const [id, raw] of Object.entries(providers)) {
    const values = record(raw)
    const options = record(values['options'])
    const npm = string(values['npm'])
    const protocol = protocolFromNpm(npm)
    const diagnostics: ImportDiagnostic[] = []
    const models = Object.keys(record(values['models']))
    const hasLocalKey = authNames.has(id) || typeof options['apiKey'] === 'string'
    if (hasLocalKey) diagnostics.push({ code: 'provider.needs-credentials' })
    if (protocol === null) diagnostics.push({ code: 'provider.needs-manual-setup', detail: npm ?? 'npm' })
    const rawUrl = string(options['baseURL']) ?? string(options['baseUrl']) ?? ''
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
    const defaultModel = models[0]
    if (defaultModel) diagnostics.push({ code: 'model.metadata-incomplete' })
    const normalized = {
      id,
      sourcePath,
      name: string(values['name']) || id,
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

/**
 * 把 OpenCode 的 mcp 项归一化成既有 `mapMcpServer` 认得的形状:
 * `remote` → url 式(streamable-http),`local` → command 式(stdio,command 是数组要摊平)。
 * 关掉的(`enabled === false`)直接不搬。
 */
export function listOpencodeMcp(config: Json): Record<string, unknown> {
  const servers = record(config['mcp'])
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(servers)) {
    const v = record(raw)
    if (v['enabled'] === false) continue
    const type = string(v['type'])
    if (type === 'remote' || v['url'] !== undefined) {
      out[name] = { type: 'streamable-http', url: string(v['url']) ?? '', ...(v['headers'] !== undefined ? { headers: v['headers'] } : {}) }
    } else if (type === 'local' || v['command'] !== undefined) {
      const cmd = v['command']
      const list = Array.isArray(cmd) ? cmd.filter((x): x is string => typeof x === 'string') : typeof cmd === 'string' ? [cmd] : []
      const env = v['environment'] ?? v['env']
      out[name] = { type: 'stdio', command: list[0] ?? '', args: list.slice(1), ...(env !== undefined ? { env } : {}) }
    } else {
      out[name] = v
    }
  }
  return out
}

/** `plugin` 数组里的 npm 包名。本地跑不了它们 —— 只报告,不安装。 */
export function listOpencodePlugins(config: Json): string[] {
  const raw = config['plugin']
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

export async function listOpencodeAssets(configDir: string): Promise<OpencodeAssets> {
  const markdown = async (sub: string): Promise<Array<{ name: string; file: string }>> => {
    const dir = await resolveWithin(configDir, sub)
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
  const skillsDir = await resolveWithin(configDir, 'skill')
  const skills: Array<{ name: string; dir: string }> = []
  if (skillsDir) {
    for (const raw of (await readdir(skillsDir).catch(() => [] as string[])).sort()) {
      if (raw.startsWith('.')) continue
      const dir = await resolveWithin(skillsDir, raw)
      if (!dir || !(await stat(dir)).isDirectory()) continue
      if (!(await resolveWithin(dir, 'SKILL.md'))) continue
      skills.push({ name: raw, dir })
    }
  }
  return { skills, agents: await markdown('agent'), commands: await markdown('command') }
}
