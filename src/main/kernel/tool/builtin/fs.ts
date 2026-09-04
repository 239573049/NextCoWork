/**
 * 文件四件套:`Read` / `Write` / `Edit` / `LS`。
 *
 * ★ 名字、参数名、描述的写法**全部对齐 Claude Code**,不是审美选择:
 *
 * 1. 模型见过海量 `Read(file_path=...)` / `Edit(old_string=..., new_string=...)`
 *    的训练数据。换成 `read_file(path=...)` 它照样能用,但会更频繁地传错参数名、
 *    更少地遵守「先读后写」这类只在 CC 描述里写过的纪律。
 * 2. 用户会把 CC 的 agent 定义文件(`tools: Read, Grep, Glob`)原样粘过来。
 *    名字一致的话,那张别名表就只是兜底,而不是正确性的前提。
 *
 * 四个工具共同守着三条线:
 *
 * - **路径一律过 `resolvePath`**(里面是 `resolveInWorkspace`)。这是模型唯一能
 *   碰到磁盘的合法入口,围栏漏在这里就等于没有围栏。
 * - **已有文件必须先 `Read` 过才能写**(见 `read-tracker.ts`)。
 * - **失败要说清楚下一步做什么**。模型是照着 `toolFail` 的正文决定怎么重试的:
 *   「文件不存在」和「文件不存在,先用 Glob 找找」产出的后续行为完全不同。
 */
import { z } from 'zod'
import { DIR_LISTING_LIMIT, sortEntries, type FileEntry } from '../../../../shared/domain/file-tree'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'
import { compileGlob, normalizeGlobPath } from './glob-match'
import { humanSize, looksBinary, relOf, resolvePath } from './paths'
import { markRead, wasRead } from './read-tracker'

/** 单次读取的上限。超过就让模型改用 `Grep`,或 `Bash` 里的 `sed -n`。 */
const MAX_READ_BYTES = 8 * 1024 * 1024
/** 单行截断长度。和 CC 一致 —— 压缩产物一行能有几十万字符。 */
const MAX_LINE_CHARS = 2000
/** 不带 `limit` 时默认读多少行。和 CC 一致。 */
const DEFAULT_READ_LIMIT = 2000
/** 二进制探测的取样长度 */
const SNIFF_BYTES = 4096

/** 「没读过就想写」的统一说辞。两个写工具必须给出同一句话。 */
function mustReadFirst(rel: string): string {
  return (
    `文件 ${rel} 在这次任务里还没有被读过。请先用 Read 读一遍再改。` +
    `这条限制是为了防止你凭记忆整体覆盖一个文件、把没看见的内容一起抹掉。`
  )
}

// ────────────────────────────── Read ──────────────────────────────

const ReadInput = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('要读的文件的绝对路径(必须在工作区内)。传相对路径时按工作区根解释'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('从第几行开始读(从 1 开始)。只在文件很大、需要分段读时才传'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .optional()
    .describe('最多读多少行。只在文件很大、需要分段读时才传')
})

/**
 * ★ 行号用 `cat -n` 的形式(右对齐 6 位 + 制表符),和 CC 逐字节一致。
 *
 * 不是审美:`Edit` 要求模型给出**原文**。换一种它不熟悉的前缀,它会把前缀一起
 * 抄进 `old_string`,然后每一次编辑都匹配不上 —— 而错误信息看起来只是「没找到」。
 */
function withLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => {
      const n = String(startLine + i).padStart(6, ' ')
      const body =
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[本行已截断]` : line
      return `${n}\t${body}`
    })
    .join('\n')
}

export const readTool: ToolRegistration = defineTool({
  internalId: 'Read',
  description:
    '从工作区里读取一个文件。\n\n' +
    '用法:\n' +
    '- file_path 必须是绝对路径,不是相对路径\n' +
    '- 默认从文件开头读最多 2000 行\n' +
    '- 可以传 offset 和 limit 分段读(文件很长时有用),但能整读就整读,不要没事分段\n' +
    '- 超过 2000 字符的行会被截断\n' +
    '- 输出是 `cat -n` 格式,行号从 1 开始\n' +
    '- 你可以在一次回复里调用多个工具。预判性地一次批量读几个相关文件,比一个个来回快得多\n' +
    '- 二进制文件会被拒绝;超过 8MB 的文件请改用 Grep 或 Bash 里的 sed 取片段\n' +
    '- 在修改任何已有文件之前,你**必须**先用这个工具读它,否则 Write / Edit 会直接失败',
  schema: ReadInput,
  readOnly: true,
  destructive: false,
  async run(input, ctx) {
    const r = resolvePath(ctx, input.file_path)
    if (!r.ok) return r.result
    const { fs } = ctx.host
    const rel = relOf(ctx, r.abs)

    if (!(await fs.exists(r.abs))) {
      return toolFail(`文件不存在:${rel}。用 LS 看看目录里有什么,或者用 Glob 按模式找一下。`)
    }

    const st = await fs.stat(r.abs)
    if (st.isDir) return toolFail(`${rel} 是一个目录,不是文件。用 LS 列它的内容。`)
    if (st.size > MAX_READ_BYTES) {
      return toolFail(
        `${rel} 太大了(${humanSize(st.size)},上限 ${humanSize(MAX_READ_BYTES)})。` +
          `用 Grep 搜你要找的内容,或者用 Bash 跑 sed -n '起始,结束p' 取一段。`
      )
    }

    if (st.size === 0) {
      // ★ 空文件也算「读过」—— 否则模型永远没法用 Write 往一个占位空文件里填内容
      markRead(ctx.runId, r.abs)
      return toolOk(`${rel} 存在,但内容是空的(0 字节)。`)
    }

    // ★ 探测在解码之前 —— 否则一个 300MB 的 .pack 会先被解成一堆 U+FFFD
    if (looksBinary(await fs.readFileBytes(r.abs, SNIFF_BYTES))) {
      return toolFail(`${rel} 看起来是二进制文件(${humanSize(st.size)}),这个工具只能读文本。`)
    }

    ctx.emit({ callId: ctx.callId, message: `读取 ${rel}(${humanSize(st.size)})` })

    const all = (await fs.readFile(r.abs)).split('\n')
    const start = (input.offset ?? 1) - 1
    if (start >= all.length) {
      return toolFail(`${rel} 只有 ${String(all.length)} 行,offset=${String(input.offset)} 越界了。`)
    }
    const limit = input.limit ?? DEFAULT_READ_LIMIT
    const slice = all.slice(start, start + limit)

    markRead(ctx.runId, r.abs)

    const shown = start + slice.length
    const note =
      shown < all.length
        ? `\n\n[只显示了第 ${String(start + 1)}–${String(shown)} 行,共 ${String(all.length)} 行。` +
          `继续读请传 offset=${String(shown + 1)}]`
        : ''
    return toolOk(withLineNumbers(slice, start + 1) + note)
  }
})

// ────────────────────────────── Write ──────────────────────────────

const WriteInput = z.object({
  file_path: z.string().min(1).describe('要写的文件的绝对路径(必须在工作区内)。父目录会自动创建'),
  content: z.string().describe('要写进文件的完整内容。这会**整个覆盖**已有文件')
})

export const writeTool: ToolRegistration = defineTool({
  internalId: 'Write',
  description:
    '把一个文件写进工作区。\n\n' +
    '用法:\n' +
    '- 目标位置已经有文件时,这个工具会**整体覆盖**它\n' +
    '- 如果是一个已存在的文件,你**必须**先用 Read 读过它,否则这次调用会失败\n' +
    '- **优先修改已有文件**。除非确实必要,不要新建文件\n' +
    '- 不要主动创建文档文件(*.md)或 README。只有用户明确要求时才写文档\n' +
    '- 除非用户明确要求,不要往文件里写 emoji\n' +
    '- 只改文件的一部分时用 Edit,不要用这个 —— 整体覆盖一个你没完整读过的文件,' +
    '几乎一定会丢掉别的内容',
  schema: WriteInput,
  readOnly: false,
  destructive: true,
  async run(input, ctx) {
    const r = resolvePath(ctx, input.file_path)
    if (!r.ok) return r.result
    const { fs } = ctx.host
    const rel = relOf(ctx, r.abs)

    const existed = await fs.exists(r.abs)
    if (existed) {
      const st = await fs.stat(r.abs)
      if (st.isDir) return toolFail(`${rel} 是一个目录,不能当文件写。`)
      // ★ 只对**已有**文件要求先读。新建文件当然没得读。
      if (!wasRead(ctx.runId, r.abs)) return toolFail(mustReadFirst(rel))
    }

    await fs.mkdirp(r.abs)
    await fs.writeFile(r.abs, input.content)
    // 写完就等于知道当下内容,后续的 Edit 不该再被拦
    markRead(ctx.runId, r.abs)

    const lines = input.content === '' ? 0 : input.content.split('\n').length
    return toolOk(
      `${existed ? '已覆盖' : '已创建'} ${rel}(${String(lines)} 行,${humanSize(input.content.length)})。`
    )
  }
})

// ────────────────────────────── Edit ──────────────────────────────

const EditInput = z.object({
  file_path: z.string().min(1).describe('要修改的文件的绝对路径(必须在工作区内)'),
  old_string: z.string().min(1).describe('要被替换掉的原文'),
  new_string: z.string().describe('替换成什么(必须和 old_string 不同)。留空串表示删掉这一段'),
  replace_all: z
    .boolean()
    .optional()
    .describe('替换 old_string 的所有出现。默认 false —— 不唯一时会直接失败,让你补上下文')
})

export const editTool: ToolRegistration = defineTool({
  internalId: 'Edit',
  description:
    '在文件里做精确的字符串替换。\n\n' +
    '用法:\n' +
    '- 编辑之前你**必须**先用 Read 读过这个文件,否则这次调用会直接失败\n' +
    '- 从 Read 的输出里抄原文时,注意保留**行号前缀之后**的原始缩进(制表符/空格)。' +
    '行号前缀的格式是「若干空格 + 行号 + 一个制表符」,制表符之后的才是文件真正的内容。' +
    '**绝对不要**把行号前缀的任何一部分放进 old_string 或 new_string\n' +
    '- old_string 在文件里**不唯一**时这次编辑会失败。要么多带几行前后文让它唯一,' +
    '要么用 replace_all 替换每一处\n' +
    '- 需要重命名一个变量之类的整文件替换时,用 replace_all\n' +
    '- **优先修改已有文件**。除非确实必要,不要新建文件\n' +
    '- 除非用户明确要求,不要往文件里加 emoji',
  schema: EditInput,
  readOnly: false,
  destructive: true,
  async run(input, ctx) {
    if (input.old_string === input.new_string) {
      return toolFail('old_string 和 new_string 完全一样,这次编辑什么也不会改变。')
    }

    const r = resolvePath(ctx, input.file_path)
    if (!r.ok) return r.result
    const { fs } = ctx.host
    const rel = relOf(ctx, r.abs)

    if (!(await fs.exists(r.abs))) {
      return toolFail(`文件不存在:${rel}。要新建文件请用 Write。`)
    }
    const st = await fs.stat(r.abs)
    if (st.isDir) return toolFail(`${rel} 是一个目录,不是文件。`)
    if (!wasRead(ctx.runId, r.abs)) return toolFail(mustReadFirst(rel))

    const before = await fs.readFile(r.abs)
    const count = before.split(input.old_string).length - 1

    if (count === 0) {
      /*
        ★ **不要**把文件内容附在错误里。模型会以为那是它该抄的原文,
        而更要紧的是:一次失败的编辑不该把整个文件塞进上下文窗。
        给它一条可执行的下一步就够了。
      */
      return toolFail(
        `在 ${rel} 里没找到 old_string。常见原因:缩进对不上(制表符 vs 空格)、` +
          `行尾空白、或者你把 Read 输出里的行号前缀一起抄进来了 —— ` +
          `行号和它后面那个制表符不属于文件内容。请重新 Read 确认原文。`
      )
    }
    if (count > 1 && input.replace_all !== true) {
      return toolFail(
        `old_string 在 ${rel} 里出现了 ${String(count)} 次,不唯一,没有执行任何修改。` +
          `请往前后多带几行上下文让它唯一;确实要全部替换时才传 replace_all: true。`
      )
    }

    const after =
      input.replace_all === true
        ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, input.new_string)

    await fs.writeFile(r.abs, after)
    return toolOk(`已修改 ${rel}:替换了 ${String(input.replace_all === true ? count : 1)} 处。`)
  }
})

// ────────────────────────────── LS ──────────────────────────────

const LsInput = z.object({
  path: z.string().min(1).describe('要列的目录的绝对路径(必须在工作区内),不是相对路径'),
  ignore: z
    .array(z.string())
    .max(64)
    .optional()
    .describe('要忽略的名字模式列表,例如 ["*.log", "__pycache__"]')
})

export const lsTool: ToolRegistration = defineTool({
  internalId: 'LS',
  description:
    '列出某个目录下的文件和子目录(**不递归**),目录在前、文件在后。' +
    'path 必须是绝对路径,不是相对路径。可以用 ignore 传一组要忽略的名字模式。' +
    '★ 已经知道要找什么的时候,优先用 Glob(按文件名)和 Grep(按内容)—— ' +
    'LS 只适合「先看看这个目录里大概有些什么」。',
  schema: LsInput,
  readOnly: true,
  destructive: false,
  async run(input, ctx) {
    const r = resolvePath(ctx, input.path)
    if (!r.ok) return r.result
    const { fs } = ctx.host
    const rel = relOf(ctx, r.abs)

    if (!(await fs.exists(r.abs))) return toolFail(`目录不存在:${rel}`)
    const st = await fs.stat(r.abs)
    if (!st.isDir) return toolFail(`${rel} 是一个文件,不是目录。用 Read 读它。`)

    // ignore 里的模式只比名字,不比路径 —— LS 不递归,路径匹配在这里没有意义
    const ignores = (input.ignore ?? []).map((p) => compileGlob(p))
    const items = (await fs.readDir(r.abs)).filter(
      (it) => !ignores.some((re) => re.test(normalizeGlobPath(it.name)))
    )
    const truncated = items.length > DIR_LISTING_LIMIT

    const entries: FileEntry[] = []
    for (const it of items.slice(0, DIR_LISTING_LIMIT)) {
      let size: number | undefined
      if (!it.isDir) {
        try {
          size = (await fs.stat(`${r.abs}/${it.name}`)).size
        } catch {
          // 断链软链 / 刚被删掉 —— 仍然列出来,只是没有大小
        }
      }
      entries.push({
        name: it.name,
        path: rel === '.' ? it.name : `${rel}/${it.name}`,
        kind: it.isDir ? 'dir' : 'file',
        hidden: it.name.startsWith('.'),
        ...(size !== undefined ? { size } : {})
      })
    }

    if (entries.length === 0) return toolOk(`${rel} 是一个空目录。`)

    // ★ 复用 shared 的排序:文件树和工具输出必须给出同一个顺序,
    //   否则用户在树里看到的和模型报告的对不上号
    const body = sortEntries(entries)
      .map((e) =>
        e.kind === 'dir'
          ? `${e.name}/`
          : `${e.name}${e.size === undefined ? '' : `  (${humanSize(e.size)})`}`
      )
      .join('\n')

    const note = truncated
      ? `\n\n[目录里共有 ${String(items.length)} 项,只显示了前 ${String(DIR_LISTING_LIMIT)} 项]`
      : ''
    return toolOk(`${rel}:\n${body}${note}`)
  }
})

/** 给测试用的常量出口,避免测试里再抄一份魔法数字 */
export const FS_LIMITS = {
  MAX_READ_BYTES,
  MAX_LINE_CHARS,
  DEFAULT_READ_LIMIT
} as const
