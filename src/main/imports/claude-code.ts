/**
 * 本机 Claude Code 的**只读**适配器 —— 发现来源、枚举项目与转录、读取配置。
 *
 * ## 只读是这个文件的全部安全模型
 *
 * 这里没有一个写操作。不是「目前还没写」,是**结构上不提供** ——
 * 导入承诺「源文件零修改」,而让承诺可执行的唯一办法是让违反它需要先加一个函数。
 *
 * 顺带的三条边界,每条都对应一种已知的踩法:
 * - **不跟随逃逸软链**:`~/.claude/skills/x -> ~/.ssh` 这种链接,配上「把内容
 *   拼进上下文再发给上游」,就是一次静默的密钥外泄。每一次落地都过 `realpath`
 *   再比前缀。
 * - **不执行任何东西**:不跑 Claude CLI、不跑 Hooks、不启动 MCP helper。
 *   源目录里躺着的是别人写的脚本,导入器碰它们的唯一方式是当文本读。
 * - **不读认证文件**:`.credentials.json` / keychain 一概不碰。
 *
 * ## 项目路径为什么不从目录名反推
 *
 * 磁盘上是 `projects/-Users-anon-my-proj/`。看起来把 `-` 换成 `/` 就行,
 * 但这个编码**有歧义**:`-Users-anon-my-proj` 既可能是 `/Users/anon/my/proj`,
 * 也可能是 `/Users/anon/my-proj`。猜错的后果不是报错,是把聊天记录挂到一个
 * 错误的工作区上。所以真实路径只认转录里的 `cwd` 字段(和 `.claude.json`
 * 里那张 projects 表),目录名只当**索引键**用。
 */
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { ImportDiagnostic, ImportSourceAvailability } from '../../shared/domain/import'
import { IMPORT_LIMITS, IMPORT_MCP_ID_MAX } from '../../shared/domain/import'

/** 源侧目录/文件名。集中在这里,不散落成十几个字符串字面量。 */
const LAYOUT = {
  projects: 'projects',
  instructions: 'CLAUDE.md',
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  /** 全局状态 + MCP。注意它是**文件**,而且不一定在配置目录里(见 `locateGlobalConfig`)。 */
  globalConfig: '.claude.json',
  /** 项目级 MCP,在项目根目录下。 */
  projectMcp: '.mcp.json'
} as const

export interface DetectedSource {
  sourceId: string
  configDir: string
  origin: 'auto' | 'env' | 'user-picked'
  availability: ImportSourceAvailability
  diagnostics: ImportDiagnostic[]
}

/**
 * 来源身份。★ 按**已解析的真实路径**取指纹,不是用户输入的那串字符 ——
 * `~/.claude` 和 `/Users/anon/.claude` 是同一个来源,映射表必须认得出来,
 * 否则同一份数据会被当成两个来源各导一遍。
 */
function sourceIdOf(realConfigDir: string): string {
  return `cc-${createHash('sha256').update(`claude-code:${realConfigDir}`).digest('hex').slice(0, 16)}`
}

/**
 * 探测顺序:用户指定 > `CLAUDE_CONFIG_DIR` > `~/.claude`。
 *
 * ★ 环境变量排在自动之前、却排在用户指定之后,而且**必须保留目录选择入口** ——
 * Finder 启动的 Electron 没有 shell 环境,那台机器上 `CLAUDE_CONFIG_DIR`
 * 读不到,可它在终端里明明是设着的。只靠环境变量的话,那位用户会看到
 * 「未检测到 Claude Code」,而他的数据就在那儿。
 */
export async function detectSource(pickedDir?: string): Promise<DetectedSource> {
  const envDir = process.env['CLAUDE_CONFIG_DIR']
  const candidates: Array<{ dir: string; origin: DetectedSource['origin'] }> = []
  if (pickedDir !== undefined && pickedDir !== '') candidates.push({ dir: pickedDir, origin: 'user-picked' })
  if (envDir !== undefined && envDir !== '') candidates.push({ dir: envDir, origin: 'env' })
  candidates.push({ dir: join(homedir(), '.claude'), origin: 'auto' })

  const diagnostics: ImportDiagnostic[] = []
  for (const candidate of candidates) {
    const probe = await probeDir(candidate.dir)
    if (probe.availability === 'detected') {
      return {
        sourceId: sourceIdOf(probe.realPath),
        configDir: probe.realPath,
        origin: candidate.origin,
        availability: 'detected',
        diagnostics: []
      }
    }
    // ★ 「没权限」要往外冒,「不存在」不用 —— 前者用户能处理(去授权),
    //   后者只是这一条候选没命中,还有下一条要试。
    if (probe.availability === 'denied') {
      diagnostics.push({ code: 'source.denied', detail: candidate.dir })
    }
  }

  const denied = diagnostics.length > 0
  return {
    sourceId: '',
    configDir: '',
    origin: pickedDir === undefined ? 'auto' : 'user-picked',
    availability: denied ? 'denied' : 'not-found',
    diagnostics: denied ? diagnostics : [{ code: 'source.not-found' }]
  }
}

async function probeDir(dir: string): Promise<{ availability: ImportSourceAvailability; realPath: string }> {
  try {
    const real = await realpath(resolve(dir))
    const info = await stat(real)
    if (!info.isDirectory()) return { availability: 'not-found', realPath: '' }
    // 目录在,但里面得真的像一份 Claude Code 配置 —— 只看到一个空目录就
    // 报「已检测到」,后面每一步都会是空的,那比直说没找到更让人困惑。
    await readdir(real)
    return { availability: 'detected', realPath: real }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return { availability: 'denied', realPath: '' }
    return { availability: 'not-found', realPath: '' }
  }
}

// ─── 有界读取 ─────────────────────────────────────────────────────────────

/**
 * 落地到授权根之内,并且**解析软链之后**再比。
 *
 * ★ 先 `resolve` 再 `realpath` 再比前缀,顺序不能换:只比字符串前缀的话,
 * `<root>/skills/x` 这个名字完全合法,而它指向 `/etc`。
 */
export async function resolveWithinRoot(root: string, ...segments: string[]): Promise<string | null> {
  const target = resolve(root, ...segments)
  try {
    const real = await realpath(target)
    const realRoot = await realpath(root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
    return real
  } catch {
    return null
  }
}

/**
 * 按行读一份转录,带三重上限。
 *
 * ★ 用流不是一次 `readFile`:上限是 128MiB,而把 128MiB 读成一个 JS 字符串
 * 会在主进程里造一次可观的停顿 —— 这个进程同时还在给界面发事件。
 * 超行长的那一行**整行丢弃并记诊断**,不截断后交给 `JSON.parse`
 * (截断过的 JSON 必然解析失败,那条诊断会说成「文件损坏」,答非所问)。
 */
export async function readTranscriptLines(
  path: string
): Promise<{ lines: string[]; diagnostics: ImportDiagnostic[] }> {
  const diagnostics: ImportDiagnostic[] = []
  const info = await stat(path)
  if (info.size > IMPORT_LIMITS.transcriptFileMaxBytes) {
    return { lines: [], diagnostics: [{ code: 'transcript.oversize', detail: String(info.size) }] }
  }

  const lines: string[] = []
  let oversizeLines = 0
  const stream = createReadStream(path, { encoding: 'utf8' })
  try {
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of reader) {
      if (line.length > IMPORT_LIMITS.transcriptLineMaxBytes) {
        oversizeLines += 1
        continue
      }
      lines.push(line)
    }
  } finally {
    stream.destroy()
  }
  if (oversizeLines > 0) {
    diagnostics.push({ code: 'transcript.oversize', detail: `lines:${String(oversizeLines)}` })
  }
  return { lines, diagnostics }
}

// ─── 项目与转录枚举 ───────────────────────────────────────────────────────

export interface TranscriptFile {
  /** 绝对路径。 */
  path: string
  /** 文件名去掉 `.jsonl` —— 源侧的会话 uuid。 */
  sessionId: string
  /** 所属的编码目录名。★ 只当索引键,不反推路径。 */
  encodedDir: string
  size: number
  mtimeMs: number
}

/**
 * 枚举全部转录文件。
 *
 * ★ 排除 `superseded` / `orphaned` 副本、`subagents` 子目录与调试文件 ——
 * 官方确认完整聊天位于 `projects/<encoded>/<session>.jsonl`,而同目录下
 * 那些旁支文件导进来会变成一堆内容重复、时间错乱的「对话」。
 */
export async function listTranscripts(configDir: string): Promise<{
  files: TranscriptFile[]
  diagnostics: ImportDiagnostic[]
}> {
  const diagnostics: ImportDiagnostic[] = []
  const root = await resolveWithinRoot(configDir, LAYOUT.projects)
  if (root === null) return { files: [], diagnostics: [] }

  const files: TranscriptFile[] = []
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (err) {
    return { files: [], diagnostics: [{ code: 'source.unreadable', detail: msg(err) }] }
  }

  for (const encodedDir of entries) {
    if (files.length >= IMPORT_LIMITS.maxSessionsPerScan) {
      diagnostics.push({ code: 'transcript.oversize', detail: `projects:${String(entries.length)}` })
      break
    }
    const dir = await resolveWithinRoot(root, encodedDir)
    if (dir === null) continue
    let names: string[]
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) continue
      names = await readdir(dir)
    } catch {
      continue
    }

    for (const name of names) {
      if (!isMainTranscript(name)) continue
      const file = await resolveWithinRoot(dir, name)
      if (file === null) continue
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        files.push({
          path: file,
          sessionId: name.slice(0, -'.jsonl'.length),
          encodedDir,
          size: info.size,
          mtimeMs: info.mtimeMs
        })
      } catch {
        continue
      }
    }
  }

  return { files, diagnostics }
}

/**
 * 是不是一份主转录。
 *
 * ★ 白名单式判定(必须是 `.jsonl` 且名字里不含旁支标记),不是黑名单 ——
 * 对方将来新增一种旁支文件时,白名单的失败方式是「少导一个文件」,
 * 黑名单的失败方式是「把一份不是对话的东西导成对话」。
 */
function isMainTranscript(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  const base = name.slice(0, -'.jsonl'.length)
  if (base === '') return false
  return !/superseded|orphaned|subagent|debug|backup/i.test(base)
}

// ─── 配置读取 ─────────────────────────────────────────────────────────────

/**
 * 找到与这个配置目录**配套**的 `.claude.json`。
 *
 * ★ 这里必须小心:该文件默认在用户主目录下(`~/.claude.json`),而配置目录是
 * `~/.claude`。用户用 `CLAUDE_CONFIG_DIR` 指了另一个 profile 时,如果我们还去读
 * `~/.claude.json`,就把**另一个 profile 的项目表和 MCP 悄悄混了进来**。
 *
 * 所以:配置目录里有同名文件就用它;否则只在「配置目录正好是 `<home>/.claude`」
 * 这一种情形下才回落到 `~/.claude.json`。两者都不成立就**跳过这一部分**并记诊断,
 * 不猜。
 */
export async function locateGlobalConfig(
  configDir: string
): Promise<{ path: string | null; diagnostics: ImportDiagnostic[] }> {
  const inside = await resolveWithinRoot(configDir, LAYOUT.globalConfig)
  if (inside !== null) return { path: inside, diagnostics: [] }

  const defaultDir = join(homedir(), '.claude')
  try {
    if ((await realpath(defaultDir)) === configDir) {
      const sibling = join(homedir(), LAYOUT.globalConfig)
      await stat(sibling)
      return { path: sibling, diagnostics: [] }
    }
  } catch {
    // 落到下面那条诊断
  }
  return { path: null, diagnostics: [{ code: 'mcp.missing-type', detail: LAYOUT.globalConfig }] }
}

/** `.claude.json` 里我们认的那两块。其余字段(遥测、提示计数等)一概不读。 */
export interface GlobalConfig {
  /** 绝对项目路径 → 该项目的局部配置。键就是真实路径,不需要解码。 */
  projects: Record<string, { mcpServers?: Record<string, unknown> }>
  mcpServers: Record<string, unknown>
}

export async function readGlobalConfig(
  path: string | null
): Promise<{ config: GlobalConfig; diagnostics: ImportDiagnostic[] }> {
  const empty: GlobalConfig = { projects: {}, mcpServers: {} }
  if (path === null) return { config: empty, diagnostics: [] }
  const parsed = await readJson(path, 32 * 1024 * 1024)
  if (parsed.value === null) return { config: empty, diagnostics: parsed.diagnostics }

  const raw = parsed.value as Record<string, unknown>
  const projects: GlobalConfig['projects'] = {}
  const rawProjects = raw['projects']
  if (rawProjects !== null && typeof rawProjects === 'object' && !Array.isArray(rawProjects)) {
    for (const [projectPath, value] of Object.entries(rawProjects as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const servers = (value as Record<string, unknown>)['mcpServers']
      projects[projectPath] =
        servers !== null && typeof servers === 'object' && !Array.isArray(servers)
          ? { mcpServers: servers as Record<string, unknown> }
          : {}
    }
  }
  const globalServers = raw['mcpServers']
  return {
    config: {
      projects,
      mcpServers:
        globalServers !== null && typeof globalServers === 'object' && !Array.isArray(globalServers)
          ? (globalServers as Record<string, unknown>)
          : {}
    },
    diagnostics: parsed.diagnostics
  }
}

/** 项目根下的 `.mcp.json`(仓库内共享的那份配置)。 */
export async function readProjectMcp(
  projectRoot: string
): Promise<{ servers: Record<string, unknown>; diagnostics: ImportDiagnostic[] }> {
  const file = await resolveWithinRoot(projectRoot, LAYOUT.projectMcp)
  if (file === null) return { servers: {}, diagnostics: [] }
  const parsed = await readJson(file, 4 * 1024 * 1024)
  if (parsed.value === null) return { servers: {}, diagnostics: parsed.diagnostics }
  const servers = (parsed.value as Record<string, unknown>)['mcpServers']
  return {
    servers:
      servers !== null && typeof servers === 'object' && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)
        : {},
    diagnostics: parsed.diagnostics
  }
}

/**
 * `CLAUDE.md` 正文。★ 只读常规正文 —— 目录继承规则、`@` 文件递归导入、
 * 路径限定 rules 这些**没有实现**,发现了要记诊断让用户知道需要调整,
 * 而不是把一份依赖它们的说明原样搬过来、假装完整兼容。
 */
export async function readInstructions(
  root: string
): Promise<{ text: string; diagnostics: ImportDiagnostic[] } | null> {
  const file = await resolveWithinRoot(root, LAYOUT.instructions)
  if (file === null) return null
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > 1024 * 1024) return null
    const text = await readFile(file, 'utf8')
    const diagnostics: ImportDiagnostic[] = []
    // `@path/to/file` 单独成行 = 递归导入另一份说明。我们不展开它。
    if (/^\s*@[^\s@]+\s*$/m.test(text)) {
      diagnostics.push({ code: 'instructions.unsupported-directive', detail: '@import' })
    }
    // `!`(cmd)` = 动态 shell 插值。**永不执行**。
    if (/!`[^`]+`/.test(text)) {
      diagnostics.push({ code: 'instructions.unsupported-directive', detail: 'shell' })
    }
    return { text, diagnostics }
  } catch {
    return null
  }
}

/** 资产目录里的条目名。skills 是目录,agents/commands 是 `.md` 文件。 */
export async function listAssetNames(
  root: string,
  kind: 'skills' | 'agents' | 'commands'
): Promise<string[]> {
  const dir = await resolveWithinRoot(root, LAYOUT[kind])
  if (dir === null) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => (kind === 'skills' ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.md')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export { LAYOUT as CLAUDE_LAYOUT }

// ─── 小工具 ───────────────────────────────────────────────────────────────

async function readJson(
  path: string,
  maxBytes: number
): Promise<{ value: unknown; diagnostics: ImportDiagnostic[] }> {
  try {
    const info = await stat(path)
    if (info.size > maxBytes) {
      return { value: null, diagnostics: [{ code: 'source.unreadable', detail: path }] }
    }
    // ★ 标准 JSON parser,不是 eval、不做 shell 展开、不自造字符串解析。
    return { value: JSON.parse(await readFile(path, 'utf8')), diagnostics: [] }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { value: null, diagnostics: [] }
    return { value: null, diagnostics: [{ code: 'source.unreadable', detail: msg(err) }] }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── MCP 配置适配 ─────────────────────────────────────────────────────────

/**
 * 源侧一条 MCP 配置 → 本应用的 `McpServerConfig`。
 *
 * ## 三条不可商量的规矩
 *
 * 1. **`enabled: false`。** `runtime.ts` 启动时会 `connectEnabledInBackground` ——
 *    导入一条 `enabled: true` 的配置,等于在用户还没看过它之前就**启动了一个进程**
 *    或发起了一次网络连接。这不是保守,这是防执行边界。
 * 2. **只搬键名,不搬值。** `env` / `headers` 的值十有八九是 token。它们留在源文件里,
 *    用户到连接设置页自己补 —— 和 `domain/mcp.ts` 文件头那条规矩同源。
 * 3. **认不出的形态宁可跳过。** `ws` / `sdk` / `headersHelper` / OAuth 占位符
 *    都不装作支持。缺 `type` 的 URL 配置也不猜(命令式配置没有歧义,URL 式有)。
 */
export interface MappedMcpServer {
  /** 本地稳定 id。受 `MCP_SERVER_ID_RE` 的字符与长度限制。 */
  id: string
  /** 源侧名字。显示与映射用,不进 id。 */
  sourceName: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  cwd?: string
  /** ★ 只有键名。 */
  secretNames: string[]
  diagnostics: ImportDiagnostic[]
}

/** 值看起来像不像一个塞在配置里的凭证。命中只用来提醒,不用来拒绝。 */
function looksLikeSecret(name: string, value: string): boolean {
  if (/token|key|secret|password|passwd|auth|credential/i.test(name)) return true
  // 一长串无空格的高熵字符串:典型的 `sk-…` / JWT / base64 token
  return value.length >= 24 && /^[A-Za-z0-9_\-.=+/]+$/.test(value)
}

/** 命令行或 URL 里内嵌的凭证。★ 命中时生成脱敏待配置项,不原样激活。 */
function hasInlineCredential(parts: readonly string[]): boolean {
  return parts.some((part) =>
    /(^|[\s=:/?&])(sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,}|(api[_-]?key|token|secret|password)=[^\s&]{8,})/i.test(part)
  )
}

/** `${VAR}` / `$VAR` 这类我们不做展开的变量表达式。 */
function hasUnsupportedExpansion(parts: readonly string[]): boolean {
  return parts.some((part) => /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(part))
}

/**
 * 本地 id。★ 源名字**不直接当 id** —— id 会拼进工具名(`mcp__<id>__<tool>`),
 * 而源侧的名字可以含空格、中文、斜杠。带上一小段来源哈希是为了让两个
 * slug 后同名的服务器不撞车(撞了会让后导入的那条覆盖前一条)。
 */
export function localMcpId(sourceName: string): string {
  const slug = sourceName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha256').update(sourceName).digest('hex').slice(0, 6)
  const base = slug === '' ? 'mcp' : slug
  return `${base.slice(0, IMPORT_MCP_ID_MAX - hash.length - 1)}-${hash}`
}

export function mapMcpServer(sourceName: string, raw: unknown): MappedMcpServer | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const config = raw as Record<string, unknown>
  const diagnostics: ImportDiagnostic[] = []

  const declared = typeof config['type'] === 'string' ? (config['type'] as string).toLowerCase() : undefined
  const command = typeof config['command'] === 'string' ? config['command'] : undefined
  const url = typeof config['url'] === 'string' ? config['url'] : undefined

  // 明确不支持的传输方式:直说,不装。
  if (declared === 'ws' || declared === 'websocket' || declared === 'sdk') {
    return {
      id: localMcpId(sourceName),
      sourceName,
      transport: 'stdio',
      secretNames: [],
      diagnostics: [{ code: 'mcp.unsupported-transport', detail: declared }]
    }
  }

  const secretNames: string[] = []
  let needsSecrets = false
  const collectSecrets = (bag: unknown): void => {
    if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) return
    for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
      secretNames.push(key)
      if (typeof value === 'string' && looksLikeSecret(key, value)) needsSecrets = true
    }
  }

  if (command !== undefined) {
    // ★ 命令式配置缺 `type` 没有歧义:有 `command` 就是 stdio。
    //   有歧义的是 URL 式那一种,见下面。
    if (declared !== undefined && declared !== 'stdio') {
      diagnostics.push({ code: 'mcp.unsupported-transport', detail: declared })
      return { id: localMcpId(sourceName), sourceName, transport: 'stdio', secretNames: [], diagnostics }
    }
    const args = Array.isArray(config['args'])
      ? (config['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    collectSecrets(config['env'])
    const surface = [command, ...args]
    if (hasInlineCredential(surface)) diagnostics.push({ code: 'mcp.possible-inline-credential' })
    if (hasUnsupportedExpansion(surface)) diagnostics.push({ code: 'mcp.needs-secrets', detail: 'expansion' })
    if (needsSecrets) diagnostics.push({ code: 'mcp.needs-secrets' })
    return {
      id: localMcpId(sourceName),
      sourceName,
      transport: 'stdio',
      command,
      args,
      ...(typeof config['cwd'] === 'string' ? { cwd: config['cwd'] } : {}),
      secretNames,
      diagnostics
    }
  }

  if (url !== undefined) {
    if (declared === undefined) {
      // ★ 不猜。`sse` 与 `streamable-http` 的握手方式不同,猜错的表现是
      //   「加进来了,连不上」,而用户无从判断是配置错了还是服务挂了。
      return {
        id: localMcpId(sourceName),
        sourceName,
        transport: 'streamable-http',
        secretNames: [],
        diagnostics: [{ code: 'mcp.missing-type', detail: sourceName }]
      }
    }
    const transport = declared === 'sse' ? 'sse' : declared === 'http' || declared === 'streamable-http' ? 'streamable-http' : null
    if (transport === null) {
      return {
        id: localMcpId(sourceName),
        sourceName,
        transport: 'streamable-http',
        secretNames: [],
        diagnostics: [{ code: 'mcp.unsupported-transport', detail: declared }]
      }
    }
    collectSecrets(config['headers'])
    // `headersHelper` 会去执行一条命令拿请求头 —— 我们不执行任何东西。
    if (config['headersHelper'] !== undefined) {
      diagnostics.push({ code: 'mcp.unsupported-transport', detail: 'headersHelper' })
    }
    if (hasInlineCredential([url])) diagnostics.push({ code: 'mcp.possible-inline-credential' })
    if (needsSecrets) diagnostics.push({ code: 'mcp.needs-secrets' })
    return { id: localMcpId(sourceName), sourceName, transport, url, secretNames, diagnostics }
  }

  return {
    id: localMcpId(sourceName),
    sourceName,
    transport: 'stdio',
    secretNames: [],
    diagnostics: [{ code: 'mcp.missing-type', detail: sourceName }]
  }
}
