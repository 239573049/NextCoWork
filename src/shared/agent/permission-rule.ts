/**
 * 「以后都允许」落成的那条**规则** —— `.next-cowork/settings.local.json` 里
 * `permissions.allow / ask / deny` 三个桶存的就是这种字符串。
 *
 * 语法沿用 Claude Code 的写法,因为用户多半已经认识它:
 *
 * ```
 * Bash                        这个工具的每一次调用
 * Bash(git status:*)          以 `git status` 开头的命令
 * Read(/Users/me/a.ts)        这一个路径
 * Write(src/*.ts)             通配
 * WebFetch(domain:example.com)
 * ```
 *
 * ★ 规则用工具的 **internalId**(`Bash` / `mcp__server__tool`),不是模型看到的
 * externalName —— 后者会被注册表截断和去重,同一个工具在不同会话里可能不是同一个名字,
 * 而这份文件要跨会话活着。
 *
 * ★ 这里只有**匹配**,没有 IO,也没有档位判断。谁比谁优先(deny → ask → 档位 → allow)
 * 由 `runtime.ts` 的接线处决定,和 `permission-gate.ts` 那张表放在一起看才完整。
 */

export interface PermissionRule {
  /** 工具的 internalId */
  tool: string
  /** 括号里那截;缺省 = 这个工具的所有调用 */
  specifier?: string
}

export const RULE_MAX = 512

const TOOL_RE = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * 前缀授权(`xxx:*`)不能被接续符扩写成第二条命令。
 *
 * ★ 这是这套语法唯一真正危险的地方:`Bash(git status:*)` 字面上也匹配
 * `git status && rm -rf /`。用户授权的是「看一眼状态」,不是「随便跑」。
 * 所以前缀命中之后,**剩下那截**里出现任何一个接续/重定向符号就整条不算命中,
 * 退回人工审批。宁可多问一次,也不要把一条窄授权悄悄变成通行证。
 */
const SHELL_ESCAPE_RE = /[;&|`\n\r<>]|\$\(/

export function parsePermissionRule(text: unknown): PermissionRule | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > RULE_MAX) return null
  const open = trimmed.indexOf('(')
  if (open < 0) return TOOL_RE.test(trimmed) ? { tool: trimmed } : null
  if (!trimmed.endsWith(')')) return null
  const tool = trimmed.slice(0, open).trim()
  const specifier = trimmed.slice(open + 1, -1).trim()
  if (!TOOL_RE.test(tool) || specifier === '') return null
  return { tool, specifier }
}

export function formatPermissionRule(rule: PermissionRule): string {
  return rule.specifier === undefined ? rule.tool : `${rule.tool}(${rule.specifier})`
}

/** 规则文本能不能读懂 —— 归一化本地设置时用它筛掉手写坏了的行。 */
export function isValidPermissionRule(text: unknown): boolean {
  return parsePermissionRule(text) !== null
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 一次调用拿去和 specifier 比对的**对象**。
 *
 * ★ 只认这几个约定字段,不做「把整个 input 拍平去比」那种事:后者会让一条
 * `Write(README.md)` 因为某个无关字段里恰好出现同样的字符串而命中。
 * 认不出来的工具(多数 MCP 工具)只剩下裸 `ToolName` 规则可用 —— 那是保守的一侧。
 */
export function ruleSubjects(input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  push(record.command)
  push(record.file_path)
  push(record.path)
  push(record.pattern)
  push(record.query)
  if (typeof record.url === 'string') {
    push(record.url)
    const host = hostOf(record.url)
    if (host !== null) out.push(`domain:${host}`)
  }
  return out
}

/**
 * 线性通配匹配(`*` 匹配任意字符,包括 `/`)。
 *
 * ★ 刻意不编译成正则:`*a*a*a*a*` 这类模式在回溯正则上是指数级的,而这些模式
 * 来自一个**可以被手改、也可能随仓库被别人改**的文件。这个两指针版本最坏 O(n·m)。
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === text[t])) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

function matchSpecifier(specifier: string, subject: string, tool: string): boolean {
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2)
    if (!subject.startsWith(prefix)) return false
    return !(tool === 'Bash' && SHELL_ESCAPE_RE.test(subject.slice(prefix.length)))
  }
  if (specifier.includes('*')) return wildcardMatch(specifier, subject)
  return specifier === subject
}

export function matchesPermissionRule(ruleText: string, tool: string, input: unknown): boolean {
  const rule = parsePermissionRule(ruleText)
  if (rule === null || rule.tool !== tool) return false
  if (rule.specifier === undefined) return true
  return ruleSubjects(input).some((subject) => matchSpecifier(rule.specifier as string, subject, tool))
}

/** 命中的第一条规则原文 —— 返回文本而不是布尔,是为了能告诉用户「是哪一条放行/拦下的」。 */
export function matchPermissionRules(rules: readonly string[], tool: string, input: unknown): string | null {
  return rules.find((rule) => matchesPermissionRule(rule, tool, input)) ?? null
}

/**
 * 这些命令的第二个词是子命令,把它带进规则里才有意义:
 * `Bash(git:*)` 等于把整个 git 交出去,`Bash(git status:*)` 才是用户以为自己点的那个。
 */
const BASH_DRIVERS: ReadonlySet<string> = new Set([
  'bun', 'bunx', 'cargo', 'docker', 'dotnet', 'gh', 'git', 'go', 'gradle', 'kubectl', 'make', 'mvn',
  'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm', 'poetry', 'python', 'python3', 'terraform', 'uv', 'yarn'
])

function bashSpecifier(command: string): string {
  // 带接续符的命令不给前缀授权:前缀只覆盖第一段,后面那几段等于没被审过。
  if (SHELL_ESCAPE_RE.test(command)) return command
  const tokens = command.split(/\s+/u).filter((token) => token !== '')
  const head = tokens[0]
  if (head === undefined || !/^[A-Za-z0-9_./-]+$/u.test(head)) return command
  const base = head.split('/').pop() ?? head
  const second = tokens[1]
  if (BASH_DRIVERS.has(base) && second !== undefined && /^[a-z][a-z0-9:_-]*$/u.test(second)) {
    return `${head} ${second}:*`
  }
  return `${head}:*`
}

/**
 * 给「以后都允许」按钮用的**建议规则**。
 *
 * ★ 由主进程算,不由渲染层送 —— 渲染层送什么就写什么的话,这颗按钮就是一个
 * 「往权限文件里写任意一行」的接口。渲染层只负责把这条规则显示给用户看。
 */
export function suggestPermissionRule(tool: string, input: unknown): string {
  const fits = (specifier: string): boolean => tool.length + specifier.length + 2 <= RULE_MAX
  const subjects = ruleSubjects(input)
  if (tool === 'Bash') {
    const command = subjects[0]
    if (command === undefined) return tool
    const specifier = bashSpecifier(command)
    return fits(specifier) ? `${tool}(${specifier})` : tool
  }
  const specifier = subjects.find((subject) => subject.startsWith('domain:')) ?? subjects[0]
  if (specifier === undefined || !fits(specifier)) return tool
  return `${tool}(${specifier})`
}
