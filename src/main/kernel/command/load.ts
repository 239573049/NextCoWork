/**
 * 斜杠命令的扫描 —— 结构照抄 `agent/load.ts`(两层目录、同名时项目胜出、
 * 永不 throw、一切失败变诊断),因为用户手写这两种文件时的心智是同一套。
 *
 * ```
 * <appData>/commands/<name>.md                     全局
 * <workspaceRoot>/.next-cowork/commands/<name>.md  项目(同名时项目胜出)
 * ```
 *
 * 和子代理的两处差别:
 *
 * 1. **不要求 frontmatter**。命令的全部内容就是正文,而 `description` 只影响
 *    弹层里那一行副标题 —— 缺了它就用命令名兜底,而不是把整条作废。
 *    (子代理那边缺 description 必须作废,因为模型是靠它决定派不派活的。)
 * 2. **没有工具/权限字段**。命令展开后就是一段普通文本,不带任何运行期语义。
 */
import type { CommandDefinition, CommandScope } from '../../../shared/domain/command'
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_NAME_RE,
  COMMAND_PROMPT_MAX
} from '../../../shared/domain/command'
import { fmString, parseFrontmatter } from '../frontmatter'
import type { KernelFs } from '../host'
import { clampWithEllipsis, stripControlChars } from '../text'
import { PathEscapeError, resolveInWorkspace } from '../tool/path-guard'
import { BUILTIN_COMMANDS } from './builtin'

/** 目录名 */
export const COMMANDS_DIR = 'commands'
export const PROJECT_COMMANDS_PREFIX = '.next-cowork'

const COMMAND_FILE_MAX_BYTES = 128 * 1024
const MAX_COMMANDS = 200

export interface CommandDiagnostic {
  path: string
  message: string
}

export interface CommandScanResult {
  commands: CommandDefinition[]
  diagnostics: CommandDiagnostic[]
}

export interface CommandScanInput {
  fs: KernelFs
  /** `<appData>/commands`。空串 = 跳过全局这一层。 */
  globalRoot: string
  /** `<workspaceRoot>/.next-cowork/commands`。空串 = 没有工作区。 */
  projectRoot: string
}

/**
 * 扫两层目录,产出一张命令表(内置那几条永远在里面)。
 *
 * ★ **永不 throw**:一个坏文件让整次扫描失败的话,用户看到的是
 * 「所有命令都不见了」,包括那条他从来没碰过的 `/init`。
 */
export async function scanCommands(input: CommandScanInput): Promise<CommandScanResult> {
  const diagnostics: CommandDiagnostic[] = []
  const byName = new Map<string, CommandDefinition>()

  for (const c of BUILTIN_COMMANDS) byName.set(c.name, c)

  // 顺序即优先级:全局先进,项目后进覆盖同名
  for (const scope of ['global', 'project'] as const) {
    const root = scope === 'global' ? input.globalRoot : input.projectRoot
    if (root === '') continue
    await scanOneRoot(input.fs, root, scope, byName, diagnostics)
  }

  return { commands: [...byName.values()], diagnostics }
}

async function scanOneRoot(
  fs: KernelFs,
  root: string,
  scope: Exclude<CommandScope, 'builtin'>,
  out: Map<string, CommandDefinition>,
  diagnostics: CommandDiagnostic[]
): Promise<void> {
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    if (!(await fs.exists(root))) return // 没有 commands 目录是常态,不是错误
    entries = await fs.readDir(root)
  } catch (err) {
    diagnostics.push({ path: root, message: `读不了这个目录:${msg(err)}` })
    return
  }

  for (const e of entries) {
    if (e.isDir) continue
    if (!e.name.endsWith('.md')) continue

    const stem = e.name.slice(0, -'.md'.length)
    if (!COMMAND_NAME_RE.test(stem)) {
      diagnostics.push({ path: `${root}/${e.name}`, message: '文件名不合法,已跳过' })
      continue
    }

    if (out.size >= MAX_COMMANDS) {
      diagnostics.push({
        path: root,
        message: `命令数量超过 ${String(MAX_COMMANDS)} 个,其余未加载`
      })
      return
    }

    let file: string
    try {
      // 挡软链逃逸:`commands/evil.md -> /etc/passwd` 之后,选一次命令
      // 就等于把任意文件的内容塞进输入框发给模型。
      file = resolveInWorkspace(root, e.name)
    } catch (err) {
      if (err instanceof PathEscapeError) {
        diagnostics.push({
          path: `${root}/${e.name}`,
          message: '这个文件指向了 commands 之外,已跳过'
        })
        continue
      }
      diagnostics.push({ path: `${root}/${e.name}`, message: msg(err) })
      continue
    }

    const loaded = await loadOne(fs, file, stem, scope, diagnostics)
    if (loaded !== null) out.set(loaded.name, loaded)
  }
}

async function loadOne(
  fs: KernelFs,
  file: string,
  fileName: string,
  scope: Exclude<CommandScope, 'builtin'>,
  diagnostics: CommandDiagnostic[]
): Promise<CommandDefinition | null> {
  let raw: string
  try {
    const bytes = await fs.readFileBytes(file, COMMAND_FILE_MAX_BYTES)
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch (err) {
    diagnostics.push({ path: file, message: `读不了这个文件:${msg(err)}` })
    return null
  }

  const fm = parseFrontmatter(raw)
  for (const s of fm.skipped) diagnostics.push({ path: file, message: s })

  /*
    ★ 命令名**只认文件名**,不认 frontmatter 里的 `name`。
    用户敲的是 `/文件名` —— 让文件里的一行能改掉这件事,等于让
    「目录里有什么」和「能敲出什么」分叉,而那个分叉没有任何提示。
  */
  const name = fileName

  const prompt = clampWithEllipsis(stripControlChars(fm.body).trim(), COMMAND_PROMPT_MAX)
  if (prompt === '') {
    diagnostics.push({ path: file, message: '正文(提示词)是空的,这个命令已作废' })
    return null
  }

  const description = fmString(fm, 'description')
  const hint = fmString(fm, 'argument-hint') ?? fmString(fm, 'argumentHint')

  return {
    name,
    description: clampWithEllipsis(
      stripControlChars(description ?? firstLine(prompt)),
      COMMAND_DESCRIPTION_MAX
    ),
    prompt,
    scope,
    source: file,
    ...(hint !== undefined ? { argumentHint: stripControlChars(hint) } : {})
  }
}

/** 没写 description 时的兜底:拿正文第一行当摘要,总好过只显示一个命令名。 */
function firstLine(prompt: string): string {
  return (prompt.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^#+\s*/, '').trim()
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
