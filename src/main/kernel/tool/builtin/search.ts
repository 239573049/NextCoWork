/**
 * 搜索两件套:`Glob`(按文件名找)与 `Grep`(按内容找)。
 *
 * 名字、参数、描述结构全部对齐 Claude Code(`output_mode` / `-i` / `-n` /
 * `-A` / `-B` / `-C` / `head_limit` / `multiline` 都是 CC 的原参数名)。
 *
 * ★ 但有一处**故意不照抄**:CC 的 Grep 描述里写的是「built on ripgrep」,
 * 我们底下是 **JavaScript 的 RegExp**。这一条必须照实说 —— 两种引擎的转义规则
 * 不一样(ripgrep 里 `\{` 要转义、JS 里不用;JS 没有 `\p{...}` 之外的那套
 * ripgrep 扩展)。描述里写 ripgrep 的话,模型会按 ripgrep 的规矩写正则,
 * 然后拿到一堆「正则不合法」或者更糟的**静默的空结果**。
 *
 * 两个工具都走 `walk.ts` 在内核侧自己遍历,而不是加一个 `KernelHost.walk` 端口 ——
 * 理由写在 `walk.ts` 的文件头:遍历带着忽略规则,忽略规则是策略,端口是能力。
 *
 * ## ★ Grep 的 ReDoS 会挂死整个应用
 *
 * 正则是**模型给的**,直接 `new RegExp` 之后拿去匹配,一个 `(a+)+$` 就能让主进程
 * 彻底无响应 —— 单线程,`RegExp.test` 又是原子的,连 abort 事件都发不出去,
 * 用户只能强杀。四道缓解,缺一不可:
 *
 * 0. **编译前做静态筛查**(`redos.ts`),嵌套无界量词直接拒绝。★ 这一道是**唯一
 *    真正管用的**那道 —— 下面三道都拦不住指数级回溯,见 `redos.ts` 的文件头;
 * 1. 每行先截到 `MAX_LINE_CHARS`(压住良性但慢的模式,也压住内存);
 * 2. 每 N 个文件查一次 `ctx.signal`;
 * 3. 整次搜索一个墙钟预算,超了就**返回部分结果并说明**。
 *
 * 对应的测试断言的是「**在 X 毫秒内返回**」,不是结果正确 —— 那是行为测试,
 * 改这个文件的时候别把它当成一条可以放宽的断言。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { EnvironmentError, missingPath } from '../../../environment/errors'
import { defineTool } from '../define'
import type { ToolContext, ToolRegistration } from '../registry'
import { compileGlob, normalizeGlobPath } from './glob-match'
import { defaultSkip } from './ignore'
import { looksBinary, relOf, resolvePath, walkBaseOf } from './paths'
import { redosRisk } from './redos'
import { walk } from './walk'

/** 结果条数上限。再多模型也读不完,只会挤掉上下文。 */
const MAX_GLOB_RESULTS = 200
const MAX_GREP_MATCHES = 200
/** 单行截断。压住良性但慢的模式和内存;**指数级回溯靠的是 `redos.ts`,不是它**。 */
const MAX_LINE_CHARS = 2000
/**
 * ★ `multiline: true` 时整份文件文本一次性进正则,单行截断这道防线就没了。
 * 所以另给一条更小的上限 —— 256KB 已经能覆盖几乎所有源码文件,
 * 而它把最坏情况的回溯规模也压回了可以接受的量级。
 */
const MAX_MULTILINE_CHARS = 256 * 1024
/** 整次搜索的墙钟预算 */
const SEARCH_BUDGET_MS = 5000
/** 比这大的文件不进 Grep —— 多半是数据或产物 */
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024
const SNIFF_BYTES = 4096
/** 每这么多个文件查一次中断 */
const SIGNAL_EVERY = 32

function rethrowRemoteFailure(error: unknown, ctx: ToolContext): void {
  if (error instanceof EnvironmentError || (ctx.host.remote && !missingPath(error))) throw error
}

/** 忽略表在两个工具的描述里都要提一句 —— 模型据此判断「没搜到」是不是可信 */
const IGNORE_NOTE =
  'Dependency and build directories (node_modules, .git, dist, out, build, target, coverage, …) are ' +
  'skipped automatically. This is a fixed list; .gitignore is NOT read. To search inside those ' +
  'directories, use Bash instead.'

/**
 * `type` 参数认识的语言别名。
 *
 * 和 ripgrep 的 `--type` 对齐了常用的那一批。★ 认不出的 type **要报错**,
 * 不能忽略后当成「不过滤」—— 那会让模型拿到一份范围完全不对的结果,
 * 而它没有任何办法察觉。
 */
const TYPE_GLOBS: Record<string, string> = {
  js: '**/*.{js,jsx,mjs,cjs}',
  ts: '**/*.{ts,tsx,mts,cts}',
  tsx: '**/*.tsx',
  jsx: '**/*.jsx',
  py: '**/*.{py,pyi}',
  go: '**/*.go',
  rust: '**/*.rs',
  java: '**/*.java',
  kotlin: '**/*.{kt,kts}',
  swift: '**/*.swift',
  c: '**/*.{c,h}',
  cpp: '**/*.{cc,cpp,cxx,hh,hpp,hxx}',
  cs: '**/*.cs',
  rb: '**/*.rb',
  php: '**/*.php',
  sh: '**/*.{sh,bash,zsh}',
  html: '**/*.{html,htm}',
  css: '**/*.{css,scss,sass,less}',
  vue: '**/*.vue',
  svelte: '**/*.svelte',
  json: '**/*.json',
  yaml: '**/*.{yaml,yml}',
  toml: '**/*.toml',
  xml: '**/*.xml',
  md: '**/*.{md,markdown}',
  sql: '**/*.sql'
}

// ────────────────────────────── Glob ──────────────────────────────

const GlobInput = z.object({
  pattern: z.string().min(1).describe('The glob pattern to match file paths against'),
  path: z
    .string()
    .optional()
    .describe(
      'Directory to search in (absolute path; it may be outside the workspace). Omit it to search the whole workspace. ' +
        'IMPORTANT: to use the default, OMIT this field entirely — do not pass "undefined" or "null"'
    )
})

export const globTool: ToolRegistration = defineTool({
  internalId: 'Glob',
  description:
    '- Fast file-pattern matching that works on any codebase size\n' +
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
    '- Returns matching paths SORTED BY MODIFICATION TIME, most recent first\n' +
    '- Use this when you are looking for files by name; use Grep when you are looking for them by CONTENT\n' +
    '- For an open-ended search that may take several rounds of globbing and grepping, use Task to launch a subagent instead\n' +
    '- You can call multiple tools in one reply. Speculatively firing several searches at once beats trying one at a time\n' +
    '- Note that * does not cross directory boundaries: to find every .ts file in every subdirectory write "**/*.ts", not "*.ts"\n' +
    `- ${IGNORE_NOTE}`,
  schema: GlobInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    const r = await resolvePath(ctx, input.path ?? '')
    if (!r.ok) return r.result
    const walkBase = walkBaseOf(ctx, r)
    const base = walkBase.label

    const re = compileGlob(input.pattern)
    const res = await walk({
      fs: ctx.host.fs,
      path: ctx.host.path,
      root: walkBase.root,
      start: walkBase.start,
      signal: ctx.signal,
      now: () => ctx.host.clock.now(),
      deadlineMs: SEARCH_BUDGET_MS,
      skip: defaultSkip
    })

    const hits = res.entries.filter((e) => !e.isDir && re.test(normalizeGlobPath(e.rel)))
    if (hits.length === 0) {
      return toolOk(
        `No files match "${input.pattern}" under ${base}. ` +
          `Note that * does not cross directory boundaries — use **/ to descend.` +
          `${res.timedOut ? ' The traversal also timed out, so this result may be incomplete.' : ''}`
      )
    }

    // ★ 只对命中的文件 stat。对全部遍历结果 stat 的话,一个大仓库要多几万次系统调用
    const withTime = await Promise.all(
      hits.slice(0, MAX_GLOB_RESULTS * 4).map(async (e) => {
        const rel = walkBase.display(e.rel)
        try {
          return { rel, mtime: (await ctx.host.fs.stat(e.abs)).mtimeMs }
        } catch (error) {
          rethrowRemoteFailure(error, ctx)
          return { rel, mtime: 0 }
        }
      })
    )
    withTime.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel))

    const shown = withTime.slice(0, MAX_GLOB_RESULTS)
    const notes: string[] = []
    if (hits.length > shown.length) {
      notes.push(
        `${String(hits.length)} files matched; listing the ${String(shown.length)} most recently modified`
      )
    }
    if (res.truncated) notes.push('traversal limit reached; some directories were not scanned')
    if (res.timedOut) notes.push('traversal timed out; the result may be incomplete')

    return toolOk(
      shown.map((h) => h.rel).join('\n') + (notes.length > 0 ? `\n\n[${notes.join('; ')}]` : '')
    )
  }
})

// ────────────────────────────── Grep ──────────────────────────────

const GrepInput = z.object({
  pattern: z.string().min(1).describe('The regular expression to search file contents for (JavaScript syntax)'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search (absolute path; it may be outside the workspace). Omit it to search the whole workspace'),
  glob: z
    .string()
    .optional()
    .describe('Filter files by glob pattern, e.g. "*.js" or "**/*.{ts,tsx}". Mutually exclusive with type'),
  type: z
    .string()
    .optional()
    .describe(
      'Filter files by language type, e.g. "js", "py", "rust". Easier than glob and covers the common ' +
        'languages. Use glob when you need finer control'
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output shape: "content" returns the matching lines (supports -A/-B/-C/-n/head_limit); ' +
        '"files_with_matches" returns just the file paths (default); "count" returns a match count per file'
    ),
  '-i': z.boolean().optional().describe('Case-insensitive matching'),
  '-n': z.boolean().optional().describe('Include line numbers in the output. Only used when output_mode is "content"'),
  '-A': z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe('Lines of context to show after each match. Only used when output_mode is "content"'),
  '-B': z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe('Lines of context to show before each match. Only used when output_mode is "content"'),
  '-C': z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe('Lines of context to show on each side of a match. Only used when output_mode is "content"'),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Let the pattern match across line boundaries (. then matches newlines too). Defaults to false — ' +
        'by default matching happens within a single line'
    ),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Keep only the first N results (lines, files, or count rows, depending on output_mode). Omit for the built-in cap'
    )
})

interface FileHits {
  rel: string
  /** 命中的行号,从 1 开始,升序 */
  lines: number[]
  /** 该文件所有行(已按 MAX_LINE_CHARS 截断),content 模式取上下文要用 */
  text: string[]
}

/** 搜一个文件。`null` = 这个文件跳过(二进制/太大/读不了),不是「没命中」。 */
async function grepFile(
  ctx: ToolContext,
  abs: string,
  rel: string,
  re: RegExp,
  multiline: boolean,
  budget: number
): Promise<FileHits | null> {
  const { fs } = ctx.host
  let size: number
  try {
    size = (await fs.stat(abs)).size
  } catch (error) {
    rethrowRemoteFailure(error, ctx)
    return null
  }
  if (size === 0 || size > MAX_GREP_FILE_BYTES) return null

  // ★ 先嗅探再解码:大多数二进制文件在这里就被挡掉了,全量读只发生在文本文件上
  try {
    if (looksBinary(await fs.readFileBytes(abs, SNIFF_BYTES))) return null
  } catch (error) {
    rethrowRemoteFailure(error, ctx)
    return null
  }

  let raw: string
  try {
    raw = await fs.readFile(abs)
  } catch (error) {
    rethrowRemoteFailure(error, ctx)
    return null
  }

  const text = raw
    .split('\n')
    // ★ 截断在**匹配之前**。灾难性回溯的代价随行长指数增长,截完就封了顶
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l))

  const lines: number[] = []

  if (multiline) {
    const joined = text.join('\n').slice(0, MAX_MULTILINE_CHARS)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(joined)) !== null) {
      // 命中的起始偏移落在第几行 —— 前面有几个换行就是第几行
      let line = 1
      for (let i = 0; i < m.index; i++) if (joined.charCodeAt(i) === 10) line++
      if (lines[lines.length - 1] !== line) lines.push(line)
      // 零宽匹配会让 lastIndex 不前进,死循环
      if (m.index === re.lastIndex) re.lastIndex++
      if (lines.length >= MAX_GREP_MATCHES) break
    }
  } else {
    for (let i = 0; i < text.length; i++) {
      re.lastIndex = 0
      if (re.test(text[i] as string)) {
        lines.push(i + 1)
        if (lines.length >= MAX_GREP_MATCHES) break
      }
      // 一个文件内部也要能被时间预算掐断 —— 单个 5MB 的文件本身就够慢
      if ((i & 0x3ff) === 0 && ctx.host.clock.now() > budget) break
    }
  }

  return { rel, lines, text }
}

/** content 模式的渲染。格式对齐 ripgrep:命中行用 `:`,上下文行用 `-`。 */
function renderContent(
  hits: FileHits[],
  before: number,
  after: number,
  showLineNo: boolean
): string[] {
  const out: string[] = []
  for (const f of hits) {
    const wanted = new Set<number>()
    for (const ln of f.lines) {
      for (let i = ln - before; i <= ln + after; i++) {
        if (i >= 1 && i <= f.text.length) wanted.add(i)
      }
    }
    const isHit = new Set(f.lines)
    const ordered = [...wanted].sort((a, b) => a - b)
    let prev = 0
    for (const ln of ordered) {
      // 两段上下文之间断开时插一条 `--`,和 ripgrep 一样
      if (prev !== 0 && ln > prev + 1) out.push('--')
      const sep = isHit.has(ln) ? ':' : '-'
      const body = f.text[ln - 1] ?? ''
      out.push(showLineNo ? `${f.rel}${sep}${String(ln)}${sep}${body}` : `${f.rel}${sep}${body}`)
      prev = ln
    }
  }
  return out
}

export const grepTool: ToolRegistration = defineTool({
  internalId: 'Grep',
  description:
    'A powerful search tool for finding text inside files.\n\n' +
    'Usage:\n' +
    '- ALWAYS use Grep to search file contents. NEVER shell out to grep or rg through Bash — this tool ' +
    'applies the ignore list, skips binaries, and has a timeout budget that the shell versions do not\n' +
    '- Supports full JAVASCRIPT regular expression syntax (e.g. "log.*Error", "function\\s+\\w+"). ' +
    'This is NOT ripgrep: { } need no escaping here, and ripgrep-specific extensions do not exist\n' +
    '- Filter files with glob (e.g. "*.js", "**/*.tsx") or with type by language (e.g. "js", "py")\n' +
    '- output_mode: "content" returns matching lines, "files_with_matches" returns just paths (DEFAULT), ' +
    '"count" returns a match count per file\n' +
    '- For an open-ended question that will take several rounds of searching, use Task to launch a subagent instead\n' +
    '- Matching is WITHIN A SINGLE LINE by default. Pass multiline: true to match across lines ' +
    '(e.g. "interface\\s+X[\\s\\S]*?field")\n' +
    '- Binary files and files over 5MB are skipped\n' +
    `- ${IGNORE_NOTE}`,
  schema: GrepInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    const r = await resolvePath(ctx, input.path ?? '')
    if (!r.ok) return r.result

    const multiline = input.multiline === true

    /*
      ★ 静态筛查排在编译**之前**。`RegExp.test` 是原子的,一旦跑进 V8 里
      就再没有查 signal 或查时钟的机会 —— 唯一有效的做法是根本不去跑它。
      详见 `redos.ts` 的文件头(以及那里为什么「行截到 2000」救不了)。
    */
    const risk = redosRisk(input.pattern)
    if (risk !== null) return toolFail(risk)

    let re: RegExp
    try {
      // `g` 是逐行 test / 跨行 exec 都要的;`s` 让 . 也匹配换行(仅 multiline)
      re = new RegExp(
        input.pattern,
        `g${input['-i'] === true ? 'i' : ''}${multiline ? 's' : ''}`
      )
    } catch (err) {
      return toolFail(
        `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}. ` +
          `This is JavaScript regex syntax; when searching for a literal, escape . ( ) [ ] * + ? with a backslash.`
      )
    }

    // ★ 认不出的 type 要报错,不能当成「不过滤」—— 静默放宽范围是查不出来的错
    if (input.type !== undefined && TYPE_GLOBS[input.type] === undefined) {
      return toolFail(
        `Unknown type "${input.type}". Available: ${Object.keys(TYPE_GLOBS).join(', ')}. ` +
          `Or use the glob parameter and write the filename pattern directly.`
      )
    }

    const st = await ctx.host.fs.stat(r.abs).catch((error: unknown) => { rethrowRemoteFailure(error, ctx); return null })
    if (st === null) return toolFail(`Path does not exist: ${relOf(ctx, r.abs)}`)
    const walkBase = walkBaseOf(ctx, r)
    const base = walkBase.label

    const nameFilterPattern = input.glob ?? (input.type === undefined ? undefined : TYPE_GLOBS[input.type])
    const nameFilter = nameFilterPattern === undefined ? null : compileGlob(nameFilterPattern)
    const budget = ctx.host.clock.now() + SEARCH_BUDGET_MS

    // path 直接指到一个文件时就只搜那一个,不必遍历
    let files: Array<{ rel: string; abs: string }>
    let walkTruncated = false
    let walkTimedOut = false
    if (!st.isDir) {
      files = [{ rel: relOf(ctx, r.abs), abs: r.abs }]
    } else {
      const res = await walk({
        fs: ctx.host.fs,
        path: ctx.host.path,
        root: walkBase.root,
        start: walkBase.start,
        signal: ctx.signal,
        now: () => ctx.host.clock.now(),
        deadlineMs: SEARCH_BUDGET_MS,
        skip: defaultSkip
      })
      walkTruncated = res.truncated
      walkTimedOut = res.timedOut
      files = res.entries
        .filter((e) => !e.isDir && (nameFilter === null || nameFilter.test(normalizeGlobPath(e.rel))))
        .map((e) => ({ rel: walkBase.display(e.rel), abs: e.abs }))
    }

    const hits: FileHits[] = []
    let totalMatches = 0
    let scanned = 0
    let budgetHit = false

    for (const f of files) {
      if (++scanned % SIGNAL_EVERY === 0) {
        // ★ 中断要能在搜索途中生效。不查的话,停止按钮要等整个仓库搜完才有反应
        if (ctx.signal.aborted) break
        ctx.emit({ callId: ctx.callId, message: `Searched ${String(scanned)} files` })
      }
      if (ctx.host.clock.now() > budget) {
        budgetHit = true
        break
      }

      const fh = await grepFile(ctx, f.abs, f.rel, re, multiline, budget)
      if (fh === null || fh.lines.length === 0) continue
      hits.push(fh)
      totalMatches += fh.lines.length
      if (totalMatches >= MAX_GREP_MATCHES) break
    }

    const notes: string[] = []
    if (totalMatches >= MAX_GREP_MATCHES) {
      notes.push(
        `hit the ${String(MAX_GREP_MATCHES)} match cap; narrow the pattern, glob, or path and search again`
      )
    }
    /*
      ★ 超时**必须说出来**。静默返回部分结果的话,模型会据此断言
      「这个字符串在仓库里不存在」—— 而那是个看起来很有说服力的错误答案。
    */
    if (budgetHit || walkTimedOut) {
      notes.push(
        `搜索超过 ${String(SEARCH_BUDGET_MS)}ms 预算,只搜了 ${String(scanned)}/${String(files.length)} 个文件,` +
          `结果不完整。请用 path、glob 或 type 缩小范围再搜一次`
      )
    }
    if (walkTruncated) notes.push('traversal limit reached; some directories were not scanned')

    const tail = notes.length > 0 ? `\n\n[${notes.join('; ')}]` : ''

    if (hits.length === 0) {
      return toolOk(
        `No content matching "${input.pattern}" in the ${String(files.length)} files under ${base}.` +
          (notes.length > 0 ? `\n[${notes.join('; ')}]` : '')
      )
    }

    const mode = input.output_mode ?? 'files_with_matches'
    const limit = input.head_limit

    if (mode === 'files_with_matches') {
      const paths = hits.map((h) => h.rel)
      const shown = limit === undefined ? paths : paths.slice(0, limit)
      return toolOk(
        shown.join('\n') +
          (shown.length < paths.length ? `\n[showing the first ${String(shown.length)} files]` : '') +
          tail
      )
    }

    if (mode === 'count') {
      const rows = hits.map((h) => `${h.rel}:${String(h.lines.length)}`)
      const shown = limit === undefined ? rows : rows.slice(0, limit)
      return toolOk(
        shown.join('\n') +
          (shown.length < rows.length ? `\n[showing the first ${String(shown.length)} files]` : '') +
          tail
      )
    }

    const ctxLines = input['-C']
    const before = ctxLines ?? input['-B'] ?? 0
    const after = ctxLines ?? input['-A'] ?? 0
    const rendered = renderContent(hits, before, after, input['-n'] === true)
    const shown = limit === undefined ? rendered : rendered.slice(0, limit)
    return toolOk(
      shown.join('\n') +
        (shown.length < rendered.length ? `\n[showing the first ${String(shown.length)} lines]` : '') +
        tail
    )
  }
})

/** 给测试用的常量出口,避免测试里再抄一份魔法数字 */
export const SEARCH_LIMITS = {
  MAX_GLOB_RESULTS,
  MAX_GREP_MATCHES,
  MAX_LINE_CHARS,
  MAX_MULTILINE_CHARS,
  SEARCH_BUDGET_MS,
  MAX_GREP_FILE_BYTES
} as const

/** `type` 参数认识的名字,给测试和文档用 */
export const GREP_TYPES = Object.keys(TYPE_GLOBS)
