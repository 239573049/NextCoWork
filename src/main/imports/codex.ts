/** Read-only Codex adapter. The only inputs are allowlisted configuration, skill packages and rollouts. */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { lstat, readdir, realpath, stat, readFile } from 'node:fs/promises'
import { parse as parseToml } from 'smol-toml'
import { IMPORT_LIMITS, type ImportDiagnostic, type ImportSourceAvailability } from '../../shared/domain/import'
import { PACKAGE_LIMITS } from '../kernel/skill/install'
import { parseFrontmatter, fmString } from '../kernel/frontmatter'
import { SKILL_NAME_RE } from '../../shared/domain/skill'
import type { CodexProviderConfig } from './codex-provider'
import type { CodexHookEntry } from './codex-hooks'
export type { CodexProviderConfig } from './codex-provider'
export type { CodexHookEntry } from './codex-hooks'

type Json = Record<string, unknown>
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const CONFIG_MAX_BYTES = 2 * 1024 * 1024

export interface CodexSource {
  sourceId: string
  configDir: string
  origin: 'auto' | 'env' | 'user-picked'
  availability: ImportSourceAvailability
  diagnostics: ImportDiagnostic[]
}
export interface CodexSkillEntry {
  name: string
  skillId: string
  dir: string
  scope: 'global' | 'project'
  projectKey?: string
  compatibilityPath: boolean
  disabled: boolean
  fingerprint: string
  diagnostics: ImportDiagnostic[]
}
export interface CodexSessionFile {
  path: string
  sessionId: string
  archived: boolean
  size: number
  mtimeMs: number
}

export async function detectCodexSource(pickedDir?: string): Promise<CodexSource> {
  const envDir = process.env['CODEX_HOME']
  const dir = pickedDir || envDir || join(homedir(), '.codex')
  const origin = pickedDir ? 'user-picked' : envDir ? 'env' : 'auto'
  try {
    const configDir = await realpath(resolve(dir))
    if (!(await stat(configDir)).isDirectory()) throw new Error('not-found')
    const names = await readdir(configDir)
    if (!names.some((name) => ['config.toml', 'hooks.json', 'sessions', 'archived_sessions', 'skills'].includes(name))) throw new Error('not-found')
    return { sourceId: `codex-${digest(['codex', configDir]).slice(0, 16)}`, configDir, origin, availability: 'detected', diagnostics: [] }
  } catch (error) {
    const denied = ['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))
    return { sourceId: '', configDir: '', origin, availability: denied ? 'denied' : 'not-found', diagnostics: [{ code: denied ? 'source.denied' : 'source.not-found', detail: dir }] }
  }
}

export async function resolveCodexPath(root: string, ...parts: string[]): Promise<string | null> {
  try {
    const [target, realRoot] = await Promise.all([realpath(resolve(root, ...parts)), realpath(root)])
    return target === realRoot || target.startsWith(realRoot + sep) ? target : null
  } catch { return null }
}

async function readText(path: string, max = CONFIG_MAX_BYTES): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.size > max) throw new Error('source.unreadable')
  return readFile(path, 'utf8')
}

async function configAt(root: string, filename: string, diagnostics: ImportDiagnostic[]): Promise<Json> {
  const path = await resolveCodexPath(root, filename)
  if (!path) return {}
  try { return record(parseToml(await readText(path))) }
  catch { diagnostics.push({ code: 'source.unreadable', detail: path }); return {} }
}

/** Strict TOML parse, exposed for fixtures without any filesystem access. */
export function parseCodexToml(text: string): Json { return record(parseToml(text)) }

export async function listCodexProfiles(root: string): Promise<string[]> {
  const config = await configAt(root, 'config.toml', [])
  const names = await readdir(root).catch(() => [] as string[])
  return [...new Set([...Object.keys(record(config['profiles'])), ...names.filter((name) => /^[\w-]+\.config\.toml$/.test(name)).map((name) => name.slice(0, -12))])].sort()
}

export async function listCodexProjectRoots(root: string, diagnostics: ImportDiagnostic[] = []): Promise<string[]> {
  const config = await configAt(root, 'config.toml', diagnostics)
  return Object.keys(record(config['projects'])).filter((path) => resolve(path) === path)
}

export async function listCodexProviders(root: string, diagnostics: ImportDiagnostic[] = [], profiles: readonly string[] = []): Promise<CodexProviderConfig[]> {
  const base = await configAt(root, 'config.toml', diagnostics)
  const selected: Array<{ config: Json; profile: string; sourcePath: string }> = [{ config: base, profile: 'default', sourcePath: join(root, 'config.toml') }]
  for (const profile of profiles) {
    if (!/^[\w-]+$/.test(profile)) continue
    const file = await configAt(root, `${profile}.config.toml`, diagnostics)
    const inline = record(record(base['profiles'])[profile])
    const override = { ...inline, ...file }
    selected.push({ config: { ...base, ...override, model_providers: { ...record(base['model_providers']), ...record(override['model_providers']) } }, profile, sourcePath: Object.keys(file).length ? join(root, `${profile}.config.toml`) : join(root, 'config.toml') })
  }
  const out: CodexProviderConfig[] = []
  for (const entry of selected) {
    const active = string(entry.config['model_provider']) ?? 'openai'
    const providers = { ...record(entry.config['model_providers']) }
    // Built-in providers have a well-defined endpoint but still require a fresh local credential.
    if (!Object.hasOwn(providers, active) && ['openai', 'ollama', 'lmstudio'].includes(active)) {
      providers[active] = { name: active, base_url: active === 'openai' ? 'https://api.openai.com/v1' : active === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1', wire_api: 'responses' }
    }
    for (const [id, raw] of Object.entries(providers)) {
      const values = record(raw)
      const unsupportedOptions = ['http_headers', 'env_http_headers', 'query_params', 'supports_websockets', 'supports_standalone_web_search', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'].filter((key) => Object.hasOwn(values, key))
      const itemDiagnostics: ImportDiagnostic[] = [{ code: 'provider.needs-credentials' }]
      if (unsupportedOptions.length) itemDiagnostics.push({ code: 'provider.unsupported-options', detail: unsupportedOptions.join(', ') }, { code: 'provider.needs-manual-setup' })
      if (Object.keys(record(values['auth'])).length || values['experimental_bearer_token']) itemDiagnostics.push({ code: 'provider.auth-command-skipped' }, { code: 'provider.needs-manual-setup' })
      const envKey = string(values['env_key'])
      const baseUrl = string(values['base_url']) ?? ''
      let sanitizedUrl = ''
      try {
        const url = new URL(baseUrl)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
        if (url.username || url.password || url.search || url.hash) itemDiagnostics.push({ code: 'provider.needs-manual-setup' })
        url.username = ''; url.password = ''; url.search = ''; url.hash = ''
        sanitizedUrl = url.href
      } catch { itemDiagnostics.push({ code: 'provider.needs-manual-setup', detail: 'base_url' }) }
      if (values['wire_api'] !== undefined && !['responses', 'chat'].includes(String(values['wire_api']))) itemDiagnostics.push({ code: 'provider.needs-manual-setup', detail: 'wire_api' })
      const defaultModel = id === active ? string(entry.config['model']) : undefined
      if (defaultModel) itemDiagnostics.push({ code: 'model.metadata-incomplete' })
      const normalized = { id, profile: entry.profile, sourcePath: entry.sourcePath, name: string(values['name']) || id, baseUrl: sanitizedUrl,
        wireApi: values['wire_api'] === 'chat' ? 'chat' as const : 'responses' as const,
        ...(defaultModel ? { defaultModel } : {}), ...(envKey && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey) ? { envKey } : {}),
        ...(typeof values['requires_openai_auth'] === 'boolean' ? { requiresOpenaiAuth: values['requires_openai_auth'] as boolean } : {}), unsupportedOptions, diagnostics: itemDiagnostics }
      out.push({ ...normalized, fingerprint: digest(normalized) })
    }
  }
  return out
}

export async function listCodexSessions(root: string, diagnostics: ImportDiagnostic[] = []): Promise<CodexSessionFile[]> {
  const files: CodexSessionFile[] = []
  let visited = 0
  const seen = new Set<string>()
  for (const [folder, archived] of [['sessions', false], ['archived_sessions', true]] as const) {
    const base = await resolveCodexPath(root, folder)
    if (!base) continue
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5 || seen.has(dir) || files.length >= IMPORT_LIMITS.maxSessionsPerScan || visited++ > 10_000) return
      seen.add(dir)
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= IMPORT_LIMITS.maxSessionsPerScan) break
        if (entry.isSymbolicLink()) continue
        // Resolve relative to the authorized session root; absolute segments are never accepted.
        const safe = await resolveCodexPath(base, join(dir, entry.name).slice(base.length + 1))
        if (!safe) continue
        if (entry.isDirectory()) await walk(safe, depth + 1)
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
          const info = await stat(safe)
          files.push({ path: safe, sessionId: basename(safe, '.jsonl'), archived, size: info.size, mtimeMs: info.mtimeMs })
        }
      }
    }
    try { await walk(base, 0) } catch { diagnostics.push({ code: 'source.unreadable', detail: base }) }
  }
  if (files.length >= IMPORT_LIMITS.maxSessionsPerScan) diagnostics.push({ code: 'transcript.oversize', detail: 'sessions' })
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function readCodexSessionIndex(root: string, diagnostics: ImportDiagnostic[] = []): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const path = await resolveCodexPath(root, 'session_index.jsonl')
  if (!path) return titles
  try {
    for (const line of (await readText(path, 8 * 1024 * 1024)).split('\n')) {
      if (!line.trim()) continue
      try {
        const row = record(JSON.parse(line))
        const id = string(row['id']) ?? string(row['session_id'])
        const name = string(row['thread_name'])
        if (id && name) titles.set(id, name)
      } catch { diagnostics.push({ code: 'transcript.truncated-tail', detail: 'session_index.jsonl' }) }
    }
  } catch { diagnostics.push({ code: 'source.unreadable', detail: path }) }
  return titles
}

async function inspectPackage(dir: string): Promise<string> {
  const hash = createHash('sha256')
  let count = 0
  let bytes = 0
  const walk = async (path: string, relative: string, depth: number): Promise<void> => {
    if (depth > PACKAGE_LIMITS.MAX_DEPTH) throw new Error('skill.package-too-large')
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (++count > PACKAGE_LIMITS.MAX_ENTRIES) throw new Error('skill.package-too-large')
      if (entry.isSymbolicLink()) throw new Error('skill.unsupported-constraint')
      const child = join(path, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child, rel, depth + 1)
      else if (entry.isFile()) {
        bytes += (await lstat(child)).size
        if (bytes > PACKAGE_LIMITS.MAX_EXPANDED) throw new Error('skill.package-too-large')
        hash.update(rel).update('\0').update(await readFile(child)).update('\0')
      }
    }
  }
  await walk(dir, '', 0)
  return hash.digest('hex')
}

export async function listCodexSkills(root: string, projectRoots: readonly string[] = [], diagnostics: ImportDiagnostic[] = []): Promise<CodexSkillEntry[]> {
  const config = await configAt(root, 'config.toml', diagnostics)
  const disabled = new Set((Array.isArray(record(config['skills'])['config']) ? record(config['skills'])['config'] as unknown[] : []).filter((item) => record(item)['enabled'] === false).map((item) => resolve(string(record(item)['path']) ?? root)))
  const paths: Array<{ dir: string; compatibilityPath: boolean; scope: 'global' | 'project'; projectKey?: string }> = [
    { dir: join(homedir(), '.agents', 'skills'), compatibilityPath: false, scope: 'global' },
    { dir: join(root, 'skills'), compatibilityPath: true, scope: 'global' },
    ...projectRoots.map((projectKey) => ({ dir: join(projectKey, '.agents', 'skills'), compatibilityPath: false, scope: 'project' as const, projectKey }))
  ]
  const out: CodexSkillEntry[] = []
  const used = new Set<string>()
  for (const source of paths) {
    const names = await readdir(source.dir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (name.startsWith('.') || used.has(`${source.projectKey ?? ''}:${name}`)) continue
      const dir = await resolveCodexPath(source.dir, name)
      if (!dir || !(await stat(dir)).isDirectory()) continue
      const marker = await resolveCodexPath(dir, 'SKILL.md')
      if (!marker) continue
      const itemDiagnostics: ImportDiagnostic[] = []
      let fingerprint = ''
      let skillName = name
      try {
        const text = await readText(marker, 256 * 1024)
        const fm = parseFrontmatter(text)
        skillName = fmString(fm, 'name') ?? name
        if (!SKILL_NAME_RE.test(skillName) || !fmString(fm, 'description')) throw new Error('skill.unsupported-constraint')
        if (/(?:disable-model-invocation|user-invocable|allowed-directories)\s*:/m.test(text)) itemDiagnostics.push({ code: 'skill.unsupported-constraint' })
        fingerprint = await inspectPackage(dir)
      } catch (error) { itemDiagnostics.push({ code: (error as Error).message === 'skill.package-too-large' ? 'skill.package-too-large' : 'skill.unsupported-constraint' }) }
      used.add(`${source.projectKey ?? ''}:${name}`)
      out.push({ name, skillId: skillName, dir, scope: source.scope, ...(source.projectKey ? { projectKey: source.projectKey } : {}), compatibilityPath: source.compatibilityPath, disabled: disabled.has(dir) || disabled.has(marker), fingerprint, diagnostics: itemDiagnostics })
    }
  }
  return out
}

export async function listCodexHooks(root: string, projectRoots: readonly string[] = [], diagnostics: ImportDiagnostic[] = []): Promise<CodexHookEntry[]> {
  const out: CodexHookEntry[] = []
  const layers = [{ root, scope: 'global' as const, projectKey: undefined as string | undefined }, ...projectRoots.map((projectKey) => ({ root: join(projectKey, '.codex'), scope: 'project' as const, projectKey }))]
  for (const layer of layers) {
    for (const file of ['hooks.json', 'config.toml']) {
      const path = await resolveCodexPath(layer.root, file)
      if (!path) continue
      try {
        const raw = record(file.endsWith('.toml') ? parseToml(await readText(path)) : JSON.parse(await readText(path)))
        if (layer.scope === 'project' && (raw['model_provider'] || raw['model_providers'])) diagnostics.push({ code: 'provider.project-scope-ignored', detail: path })
        const hooks = record(raw['hooks'])
        if (hooks['state']) diagnostics.push({ code: 'hook.trust-state-skipped', detail: path })
        for (const [event, groups] of Object.entries(hooks)) {
          if (!Array.isArray(groups)) continue
          groups.forEach((group, groupIndex) => {
            const g = record(group)
            const handlers = Array.isArray(g['hooks']) ? g['hooks'] : []
            handlers.forEach((handler, handlerIndex) => {
              const h = record(handler)
              out.push({ event, matcher: string(g['matcher']), command: string(h['command']), handlerType: string(h['type']) ?? 'unknown',
                timeout: typeof h['timeout'] === 'number' ? h['timeout'] : undefined, statusMessage: string(h['statusMessage']), async: h['async'] === true,
                sourcePath: path, scope: layer.scope, ...(layer.projectKey ? { projectKey: layer.projectKey } : {}), sourceKey: `${layer.scope}:${layer.projectKey ?? ''}:${file}:${event}:${groupIndex}:${handlerIndex}` })
            })
          })
        }
      } catch { diagnostics.push({ code: 'source.unreadable', detail: path }) }
    }
  }
  return out
}
