/**
 * 斜杠命令(`/命令`)—— **一段存在磁盘上的提示词模板**,不是一个能执行的动作。
 *
 * ```
 * <appData>/commands/<name>.md                     全局
 * <workspaceRoot>/.next-cowork/commands/<name>.md  项目(同名时项目胜出)
 * ```
 *
 * 形状刻意和 `agent-def.ts` 平行(单文件 md、frontmatter 里放 description、
 * 正文即提示词、同名时项目胜出),因为用户手写这两种文件时的心智应该是同一套。
 *
 * ★ **展开在发送前完成,主进程收到的是普通文本。** 命令不进 `RunRequest`、
 * 不进内核、不需要任何新的运行期概念 —— `/init` 和用户自己把那一整段话打进
 * 输入框在下游是**同一件事**。这是这个功能能只有一个 IPC 频道的原因。
 */

/** 命令名。会出现在 `/xxx` 里,所以不许带空白和路径分隔符。 */
export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export const COMMAND_DESCRIPTION_MAX = 200
export const COMMAND_PROMPT_MAX = 32 * 1024

export type CommandScope = 'builtin' | 'global' | 'project'

export interface CommandDefinition {
  name: string
  /** 弹层里那一行副标题。文件命令取 frontmatter,内置命令由渲染层翻译。 */
  description: string
  /** 正文 —— 展开后真正发给模型的那段话 */
  prompt: string
  scope: CommandScope
  /** 磁盘路径。内置命令为空串。 */
  source: string
  /** frontmatter 里的 `argument-hint`,例如 `<文件路径>`。只用于提示。 */
  argumentHint?: string
}

/** 一次 `/命令 参数` 的解析结果 */
export interface CommandInvocation {
  name: string
  /** 命令名之后的全部内容,已 trim。没有参数时是空串。 */
  args: string
}

/**
 * 草稿是不是**整条**都是一次命令调用。
 *
 * ★ 必须是整条:`帮我看下 /init 这个命令` 里的 `/init` 是在说话,不是在调用。
 * 判据落在「`/` 在开头」上,而不是「文本里出现过 `/xxx`」。
 */
export function parseCommandInvocation(draft: string): CommandInvocation | null {
  const m = /^\s*\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:[ \t]+([\s\S]*))?$/.exec(draft)
  if (m === null) return null
  return { name: m[1] as string, args: (m[2] ?? '').trim() }
}

/**
 * 把参数塞进模板。
 *
 * - `$ARGUMENTS` → 全部参数原样
 * - `$1`…`$9` → 按空白切开的第 n 个
 *
 * ★ 模板里**一个占位符都没有**、用户却带了参数时,把参数追加到末尾 ——
 * 而不是把它丢掉。丢掉的话用户敲的那句话会凭空消失,且没有任何反馈。
 */
export function expandCommandPrompt(prompt: string, args: string): string {
  const positional = args === '' ? [] : args.split(/\s+/)
  let used = false
  const out = prompt
    .replace(/\$ARGUMENTS\b/g, () => {
      used = true
      return args
    })
    .replace(/\$([1-9])\b/g, (_, d: string) => {
      used = true
      return positional[Number(d) - 1] ?? ''
    })
  if (used || args === '') return out
  return `${out}\n\n${args}`
}

/**
 * 草稿 → 真正要发出去的文本。不是一次命令调用就原样返回。
 *
 * ★ 认不出的命令名也原样返回:用户可能真的想以 `/` 开头说一句话,
 * 而把它吞掉或者报错都比「照他写的发出去」更糟。
 */
export function applyCommand(draft: string, commands: readonly CommandDefinition[]): string {
  const call = parseCommandInvocation(draft)
  if (call === null) return draft
  const found = commands.find((c) => c.name.toLowerCase() === call.name.toLowerCase())
  if (found === undefined) return draft
  return expandCommandPrompt(found.prompt, call.args)
}
