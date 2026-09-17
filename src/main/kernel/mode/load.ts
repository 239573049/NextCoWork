import type { KernelFs, WorkspacePaths } from '../host'
import { fmList, fmString, parseFrontmatter } from '../frontmatter'
import { clampWithEllipsis, stripControlChars } from '../text'
import { PathEscapeError, resolveInWorkspace } from '../tool/path-guard'
import { normalizeToolName } from '../agent/tool-alias'
import { EnvironmentError } from '../../../shared/domain/environment'
import { LOCAL_SETTINGS_DIRNAME } from '../../../shared/domain/local-settings'
import type { ModeDefinition } from '../../../shared/domain/mode'
import {
  isBuiltinModeId,
  MODE_DESCRIPTION_MAX,
  MODE_ID_RE,
  MODE_NAME_MAX,
  MODE_PROMPT_MAX
} from '../../../shared/domain/mode'
import { BUILTIN_MODES } from './builtin'

export const MODES_DIR = 'modes'
/** 项目级资源所在的那层目录 —— 唯一出处见 `skill/load.ts` 的同名常量。 */
export const PROJECT_MODES_PREFIX = LOCAL_SETTINGS_DIRNAME
const MODE_FILE_MAX_BYTES = 128 * 1024
const MAX_MODES = 100
const TOOL_ID_RE = /^[A-Za-z0-9_.:/-]{1,256}$/

export interface ModeDiagnostic {
  path: string
  message: string
}

export interface ModeScanResult {
  modes: ModeDefinition[]
  diagnostics: ModeDiagnostic[]
}

export interface ModeScanInput {
  fs: KernelFs
  projectFs?: KernelFs
  projectPath?: WorkspacePaths
  globalRoot: string
  projectRoot: string
  availableTools?: ReadonlySet<string>
}

export async function scanModes(input: ModeScanInput): Promise<ModeScanResult> {
  const diagnostics: ModeDiagnostic[] = []
  const byId = new Map(BUILTIN_MODES.map((mode) => [mode.id, mode]))

  for (const scope of ['global', 'project'] as const) {
    const root = scope === 'global' ? input.globalRoot : input.projectRoot
    if (root === '') continue
    await scanRoot(
      scope === 'project' ? input.projectFs ?? input.fs : input.fs,
      root,
      scope,
      byId,
      diagnostics,
      scope === 'project' ? input.projectPath : undefined,
      input.availableTools
    )
  }

  return { modes: [...byId.values()], diagnostics }
}

async function scanRoot(
  fs: KernelFs,
  root: string,
  scope: 'global' | 'project',
  modes: Map<string, ModeDefinition>,
  diagnostics: ModeDiagnostic[],
  paths?: WorkspacePaths,
  availableTools?: ReadonlySet<string>
): Promise<void> {
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    if (!(await fs.exists(root))) return
    entries = await fs.readDir(root)
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    diagnostics.push({ path: root, message: `Cannot read modes directory: ${message(error)}` })
    return
  }

  for (const entry of entries) {
    if (entry.isDir || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -3)
    const displayPath = `${root}/${entry.name}`

    if (!MODE_ID_RE.test(id)) {
      diagnostics.push({ path: displayPath, message: 'Invalid mode file name.' })
      continue
    }
    if (isBuiltinModeId(id)) {
      diagnostics.push({ path: displayPath, message: `Built-in mode "${id}" cannot be overridden; copy it under a new id.` })
      continue
    }
    if (modes.size >= MAX_MODES + BUILTIN_MODES.length) {
      diagnostics.push({ path: root, message: `Only the first ${String(MAX_MODES)} custom modes were loaded.` })
      return
    }

    let file: string
    try {
      file = paths ? await paths.resolveWithin(root, entry.name) : resolveInWorkspace(root, entry.name)
    } catch (error) {
      if (error instanceof EnvironmentError) throw error
      diagnostics.push({
        path: displayPath,
        message: error instanceof PathEscapeError ? 'Mode file points outside the modes directory.' : message(error)
      })
      continue
    }

    const loaded = await loadMode(fs, file, id, scope, diagnostics, availableTools)
    if (loaded !== undefined) modes.set(id, loaded)
  }
}

async function loadMode(
  fs: KernelFs,
  file: string,
  id: string,
  scope: 'global' | 'project',
  diagnostics: ModeDiagnostic[],
  availableTools?: ReadonlySet<string>
): Promise<ModeDefinition | undefined> {
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: false }).decode(await fs.readFileBytes(file, MODE_FILE_MAX_BYTES))
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    diagnostics.push({ path: file, message: `Cannot read mode file: ${message(error)}` })
    return undefined
  }

  const frontmatter = parseFrontmatter(raw)
  for (const skipped of frontmatter.skipped) diagnostics.push({ path: file, message: skipped })

  const rawName = fmString(frontmatter, 'name')
  const rawDescription = fmString(frontmatter, 'description')
  if (rawName === undefined || rawDescription === undefined) {
    diagnostics.push({ path: file, message: 'Custom modes require name and description frontmatter.' })
    return undefined
  }

  const prompt = clampWithEllipsis(stripControlChars(frontmatter.body).trim(), MODE_PROMPT_MAX)
  if (prompt === '') {
    diagnostics.push({ path: file, message: 'The mode prompt is empty.' })
    return undefined
  }

  const tools = readTools(frontmatter, 'tools', file, diagnostics)
  if (tools === 'invalid') return undefined
  const requiredTools = readTools(frontmatter, 'requiredTools', file, diagnostics)
    ?? readTools(frontmatter, 'required-tools', file, diagnostics)
  if (requiredTools === 'invalid') return undefined

  if (availableTools !== undefined) {
    const unknown = [...(tools ?? []), ...(requiredTools ?? [])].filter((tool) => !availableTools.has(tool))
    if (unknown.length > 0) {
      diagnostics.push({ path: file, message: `Unknown tool ids: ${[...new Set(unknown)].join(', ')}` })
      return undefined
    }
  }

  if (tools === undefined && requiredTools !== undefined) {
    diagnostics.push({ path: file, message: 'requiredTools requires an explicit tools list.' })
    return undefined
  }
  if (tools !== undefined && requiredTools !== undefined) {
    const allowed = new Set(tools)
    const missing = requiredTools.filter((tool) => !allowed.has(tool))
    if (missing.length > 0) {
      diagnostics.push({
        path: file,
        message: `requiredTools must also appear in tools: ${missing.join(', ')}`
      })
      return undefined
    }
  }

  return {
    id,
    name: clampWithEllipsis(stripControlChars(rawName), MODE_NAME_MAX),
    description: clampWithEllipsis(stripControlChars(rawDescription), MODE_DESCRIPTION_MAX),
    prompt,
    ...(tools === undefined ? {} : { tools }),
    ...(requiredTools === undefined ? {} : { requiredTools }),
    source: { kind: scope, path: file }
  }
}

function readTools(
  frontmatter: ReturnType<typeof parseFrontmatter>,
  key: string,
  file: string,
  diagnostics: ModeDiagnostic[]
): string[] | undefined | 'invalid' {
  const values = fmList(frontmatter, key)
  if (values === undefined) return undefined

  const tools: string[] = []
  const invalid: string[] = []
  for (const value of values) {
    const normalized = normalizeToolName(value) ?? value.trim()
    if (!TOOL_ID_RE.test(normalized)) {
      invalid.push(value)
      continue
    }
    if (!tools.includes(normalized)) tools.push(normalized)
  }

  if (invalid.length > 0) {
    diagnostics.push({ path: file, message: `${key} contains invalid tool ids: ${invalid.join(', ')}` })
  }
  if (tools.length === 0) {
    diagnostics.push({ path: file, message: `${key} does not contain a valid tool id.` })
    return 'invalid'
  }
  return tools
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const MODE_LIMITS = { MODE_FILE_MAX_BYTES, MAX_MODES } as const
