/**
 * 命令 / 子代理的**单文件**读写 —— 扩展面板里那个编辑器的内核侧。
 *
 * 和 `command/load.ts`、`agent/load.ts` 的分工:
 *
 * - 那两个是**扫描器**,回答「这个目录里有哪些有效的命令 / 子代理」,产出的是
 *   加载器解读之后的结果(description 有兜底、prompt 被 clamp、tools 被归一化)。
 * - 这一个是**编辑器的后端**,回答「这个文件里到底写了什么」。它必须保真:
 *   frontmatter 原样进原样出,包括本应用不认识的键。
 *
 * ★ 两者不能合并。拿扫描结果去回写,等于把兜底值写进用户的文件 ——
 *   一个从没写过 description 的命令,编辑一次就会被塞进一行正文的第一句。
 *
 * ★ 零 electron:路径怎么算、写完广播给谁,都在 `ipc/` 那一层。
 */
import type { MarkdownResourceKind } from '../../shared/domain/markdown-resource'
import { MARKDOWN_RESOURCE_BODY_MAX } from '../../shared/domain/markdown-resource'
import { EnvironmentError } from '../../shared/domain/environment'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import type { KernelFs } from './host'

const RESOURCE_FILE_MAX_BYTES = 128 * 1024

/**
 * 前置块的键序。
 *
 * ★ 稳定的键序不是洁癖:每存一次就换一次顺序,git diff 会变成一片噪音,
 *   而真正改了什么反而看不出来。没列出来的键按字母序跟在后面。
 */
const KEY_ORDER: Record<MarkdownResourceKind, readonly string[]> = {
  command: ['description', 'argument-hint'],
  agent: ['name', 'description', 'tools', 'model', 'permissionMode']
}

export interface ResourceFileContent {
  frontmatter: Record<string, string | string[]>
  body: string
  skipped: string[]
  revision: string
}

/**
 * `mtimeMs:size` —— 和 `local-settings.ts` 的缓存键同一种格式,同一个理由:
 * 一次 stat 就能判断「我读到的还是不是磁盘上那一份」。
 */
export async function fileRevision(fs: KernelFs, file: string): Promise<string> {
  const stat = await fs.stat(file)
  return `${String(stat.mtimeMs)}:${String(stat.size)}`
}

/** 读一个资源文件。不存在返回 `null` —— 那不是错误,是「还没建」。 */
export async function readResourceFile(fs: KernelFs, file: string): Promise<ResourceFileContent | null> {
  if (!(await fs.exists(file))) return null

  const bytes = await fs.readFileBytes(file, RESOURCE_FILE_MAX_BYTES)
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const fm = parseFrontmatter(raw)

  return {
    // `fm.data` 是冻结的无原型对象 —— 拷一份普通对象出去,好让渲染层能改。
    frontmatter: { ...fm.data },
    body: fm.body,
    skipped: [...fm.skipped],
    revision: await fileRevision(fs, file)
  }
}

/** 拼出要落盘的文本。★ 正文上限在这里兜一次,渲染层的限制挡不住 IPC 直调。 */
export function renderResourceFile(
  kind: MarkdownResourceKind,
  frontmatter: Readonly<Record<string, string | string[] | undefined>>,
  body: string
): string {
  const clamped = body.length > MARKDOWN_RESOURCE_BODY_MAX ? body.slice(0, MARKDOWN_RESOURCE_BODY_MAX) : body
  return serializeFrontmatter(frontmatter, clamped, { order: KEY_ORDER[kind] })
}

export type SaveOutcome =
  | { ok: true; revision: string }
  | { ok: false; reason: 'conflict' | 'io' }

/**
 * 写一个资源文件。
 *
 * ★ `expectedRevision` 对不上就**拒绝写**并回 `conflict`。两个窗口开着同一个
 *   文件、或者用户刚在外部编辑器里改过 —— 最后保存的那一次不该把另一次静默盖掉。
 *   传 `undefined` = 新建,此时文件已存在同样算冲突(否则「新建」会悄悄覆盖)。
 */
export async function writeResourceFile(
  fs: KernelFs,
  file: string,
  text: string,
  expectedRevision: string | undefined
): Promise<SaveOutcome> {
  try {
    const exists = await fs.exists(file)
    if (expectedRevision === undefined) {
      if (exists) return { ok: false, reason: 'conflict' }
    } else {
      if (!exists) return { ok: false, reason: 'conflict' }
      if ((await fileRevision(fs, file)) !== expectedRevision) return { ok: false, reason: 'conflict' }
    }
    await fs.mkdirp(file)
    await fs.writeFile(file, text)
    return { ok: true, revision: await fileRevision(fs, file) }
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    return { ok: false, reason: 'io' }
  }
}
