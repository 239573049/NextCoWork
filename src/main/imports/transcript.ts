/**
 * Claude Code 的 `.jsonl` 转录 → 本应用的 `AgentMessage[]`。
 *
 * ## 这个文件为什么是纯函数
 *
 * 它不碰文件系统、不碰数据库、不 mint 任何 id。输入是**一批行**,输出是
 * 一份规范化结果加一串诊断。理由是第 1 步那条判据:「先用最小 user/assistant/tool
 * 往返夹具验证源数据能编码为当前消息」—— 这件事必须能在 vitest 的 node 环境里
 * 用几十行夹具跑完,而不是先起一个 Electron。
 *
 * 落盘、mint ULID、把 base64 图片变成受管附件,全在 `service.ts`。
 *
 * ## 主分支是怎么恢复的
 *
 * 磁盘上的一份转录**不是一条线**:用户编辑过的消息会留下分叉,每个记录靠
 * `parentUuid` 指向它的前一条。所以「按文件顺序拼起来」得到的是所有分支
 * 混在一起的一坨 —— 表现是同一个问题被问了三遍、助手答非所问。
 *
 * 正确做法是**从叶子往回走**:取最后一条主线记录,顺着 `parentUuid` 回溯到根,
 * 再反转。最后写入的那一条必然在当前活跃分支上,这是 append-only 日志的直接推论。
 *
 * ★ 走不通的时候(父记录缺失、根本没有 uuid)**不退化成按文件顺序拼** ——
 * 那正是上面说的那坨。该会话标记 `transcript.branch-unresolvable`,
 * 整条跳过。宁可少导一条,不导一条错的。
 *
 * ## 不做的事
 *
 * - 不透传 `signature` / `cache_control` 之类的厂商私有字段。可见的 thinking
 *   正文留下,不透明部分丢掉 —— 它是上一家供应商的凭据,发给另一家只会报错。
 * - 不为落单的 `tool_use` 编一个成功结果。那会在界面上变成一张「执行成功」的
 *   工具卡,而那次执行**从来没有发生过**。落单的降级成可读正文。
 * - 不联网下载任何东西。源里那种临时 URL 图片只留一行说明。
 */
import type { ContentPart, ToolOutput } from '../../shared/agent/message'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { truncateToolOutput } from '../../shared/agent/message'

/**
 * 转换器版本。★ 改了任何一条映射规则就要 +1 ——
 * `import_mappings.transformer_version` 靠它认出「这条是旧规则导进来的」。
 */
export const TRANSFORMER_VERSION = 1

/** 一条已规范化的消息。★ 还没有本地 id:那是 `service.ts` 的事。 */
export interface ImportedMessage {
  /**
   * 源侧稳定键。有 `uuid` 就用它;没有的记录用内容指纹 + 同内容出现序号
   * (见 `fallbackKey`)—— 后者保证「重复说了两遍同样的话」不会被合并成一条。
   */
  sourceId: string
  role: 'user' | 'assistant'
  parts: ContentPart[]
  createdAt: number
  /** 待落盘的内联图片。`service` 落完受管附件后回填对应 part 的 `dataRef`。 */
  images: PendingImage[]
}

export interface PendingImage {
  /** 在 `parts` 里的下标。 */
  partIndex: number
  mime: string
  /** 原始 base64,不含 data URI 前缀。 */
  base64: string
}

export interface ParsedTranscript {
  /** 源会话 id(记录里的 `sessionId`,退化时用文件名)。 */
  sessionId: string
  /**
   * 源工作目录。★ **项目路径的唯一可信来源** —— 不从连字符编码的目录名反推,
   * 那种编码有歧义(`-Users-a-b-c` 既可能是 `/Users/a/b/c` 也可能是 `/Users/a-b/c`)。
   */
  cwd: string
  title?: string
  /** 源侧模型名。只作为来源元数据保留,不用它去解析本地 provider。 */
  model?: string
  startedAt?: number
  updatedAt?: number
  messages: ImportedMessage[]
  diagnostics: ImportDiagnostic[]
}

export interface ParseOptions {
  /** 文件名去掉扩展名 —— 记录里没有 `sessionId` 时的退路。 */
  fallbackSessionId: string
  /** 单会话消息数上限。超过的截断并记诊断,不静默丢。 */
  maxMessages: number
}

// ─── 原始记录的形状识别 ───────────────────────────────────────────────────

/**
 * ★ 这里**不用 Zod**,用手写的窄化。
 *
 * 源格式不是我们的契约,它会随对方版本变,而 Zod schema 的失败是全或无的 ——
 * 一个新增的未知字段会让整条记录作废。这些判定只问「我要读的那几个字段在不在、
 * 是不是我以为的类型」,对多出来的字段一概不关心,这正是读外部数据该有的姿态。
 */
type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** ISO 时间戳 → epoch 毫秒。解不出来返回 undefined,由调用方兜底。 */
function timeOf(value: unknown): number | undefined {
  const raw = str(value)
  if (raw === undefined) return undefined
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : undefined
}

interface RawRecord {
  uuid?: string
  parentUuid?: string
  type: string
  isSidechain: boolean
  isMeta: boolean
  timestamp?: number
  cwd?: string
  sessionId?: string
  message?: Json
  summary?: string
  /** ★ 真机上的会话标题在这里,不在 `summary` —— 见 `pickTitle`。 */
  aiTitle?: string
  /**
   * ★★ 压缩边界跨到上一段的链接。
   *
   * 一次 `/compact` 会在文件里开一棵**新树**:那条 `subtype: 'compact_boundary'`
   * 的 system 记录 `parentUuid` 是 null,但 `logicalParentUuid` 指回压缩前那棵树。
   * 不跟这一跳的话,一份聊了很久、压缩过两次的会话只会恢复出最后那一小段
   * (真机上量到的是 158 条候选里只取到 5 条)。
   */
  logicalParentUuid?: string
  leafUuid?: string
  /** 在文件里的行号,只用于诊断。 */
  line: number
}

/** 会**产出一条消息**的记录类型。其余带 uuid 的类型只参与遍历。 */
function isMessageRecord(record: RawRecord): boolean {
  return (record.type === 'user' || record.type === 'assistant') && record.message !== undefined
}

function toRawRecord(value: unknown, line: number): RawRecord | undefined {
  if (!isObject(value)) return undefined
  const type = str(value['type'])
  if (type === undefined) return undefined
  return {
    ...(str(value['uuid']) === undefined ? {} : { uuid: str(value['uuid']) as string }),
    ...(str(value['parentUuid']) === undefined ? {} : { parentUuid: str(value['parentUuid']) as string }),
    type,
    isSidechain: value['isSidechain'] === true,
    isMeta: value['isMeta'] === true,
    ...(timeOf(value['timestamp']) === undefined ? {} : { timestamp: timeOf(value['timestamp']) as number }),
    ...(str(value['cwd']) === undefined ? {} : { cwd: str(value['cwd']) as string }),
    ...(str(value['sessionId']) === undefined ? {} : { sessionId: str(value['sessionId']) as string }),
    ...(isObject(value['message']) ? { message: value['message'] } : {}),
    ...(str(value['summary']) === undefined ? {} : { summary: str(value['summary']) as string }),
    ...(str(value['aiTitle']) === undefined ? {} : { aiTitle: str(value['aiTitle']) as string }),
    ...(str(value['logicalParentUuid']) === undefined
      ? {} : { logicalParentUuid: str(value['logicalParentUuid']) as string }),
    ...(str(value['leafUuid']) === undefined ? {} : { leafUuid: str(value['leafUuid']) as string }),
    line
  }
}

// ─── 内容块映射 ───────────────────────────────────────────────────────────

/** `tool_result.content` 可以是字符串,也可以是块数组。两种都要能读成一段文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!isObject(block)) return ''
      if (block['type'] === 'text') return str(block['text']) ?? ''
      // 工具返回的图片:正文里留一行说明,不假装它是一张能显示的图。
      if (block['type'] === 'image') return '[图片输出]'
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** base64 图片源 → 待落盘项。非 base64(URL 引用)返回 undefined。 */
function imageSource(block: Json): { mime: string; base64: string } | undefined {
  const source = block['source']
  if (!isObject(source)) return undefined
  if (source['type'] !== 'base64') return undefined
  const mime = str(source['media_type'])
  const base64 = str(source['data'])
  if (mime === undefined || base64 === undefined || base64 === '') return undefined
  return { mime, base64 }
}

interface BlockResult {
  parts: ContentPart[]
  images: PendingImage[]
  diagnostics: ImportDiagnostic[]
}

/**
 * 一条源消息的 `content` → `ContentPart[]`。
 *
 * ★ 返回的 part 顺序 = 源顺序。`tool_use` 和它后面的文字在同一条助手消息里
 * 是有意义的(「我先说要做什么,再发起调用」),重排会让转录读起来前后颠倒。
 */
function mapContent(content: unknown, role: 'user' | 'assistant'): BlockResult {
  const parts: ContentPart[] = []
  const images: PendingImage[] = []
  const diagnostics: ImportDiagnostic[] = []

  if (typeof content === 'string') {
    if (content !== '') parts.push({ type: 'text', text: content })
    return { parts, images, diagnostics }
  }
  if (!Array.isArray(content)) return { parts, images, diagnostics }

  for (const block of content) {
    if (typeof block === 'string') {
      if (block !== '') parts.push({ type: 'text', text: block })
      continue
    }
    if (!isObject(block)) continue

    switch (block['type']) {
      case 'text': {
        const text = str(block['text']) ?? ''
        if (text !== '') parts.push({ type: 'text', text })
        break
      }
      case 'thinking':
      case 'redacted_thinking': {
        /*
          ★ 只留可见正文,`signature` / `data` 一概不带。
          那是上一家供应商签发的凭据,原样发给当前供应商只会换来一次
          400 —— 而 `encode/anthropic.ts` 的做法本来就是无签名即丢弃,
          这里提前丢掉是让两处保持同一个事实,不是多此一举。
        */
        const text = str(block['thinking']) ?? str(block['text']) ?? ''
        if (text !== '') parts.push({ type: 'thinking', text })
        break
      }
      case 'tool_use': {
        const callId = str(block['id'])
        const name = str(block['name'])
        if (callId === undefined || name === undefined) {
          diagnostics.push({ code: 'tool.unencodable', detail: name ?? 'tool_use' })
          break
        }
        parts.push({ type: 'tool_call', callId, name, input: block['input'] ?? {} })
        break
      }
      case 'tool_result': {
        const callId = str(block['tool_use_id'])
        if (callId === undefined) {
          diagnostics.push({ code: 'tool.unencodable', detail: 'tool_result' })
          break
        }
        const output: ToolOutput = truncateToolOutput(toolResultText(block['content']))
        parts.push({ type: 'tool_result', callId, output, isError: block['is_error'] === true })
        break
      }
      case 'image': {
        const source = imageSource(block)
        if (source === undefined) {
          /*
            源里那种指向临时 URL 的图片:**不联网下载**。留一行可读说明,
            并记一条诊断 —— 把 URL 当永久引用存下来的话,链接过期之后
            界面上就是一个永远转圈的破图。
          */
          diagnostics.push({ code: 'attachment.external-url' })
          parts.push({ type: 'text', text: '[图片:源侧为外部引用,未导入]' })
          break
        }
        // dataRef 是占位符,service 落完附件回填。
        images.push({ partIndex: parts.length, mime: source.mime, base64: source.base64 })
        parts.push({ type: 'image', mime: source.mime, dataRef: '' })
        break
      }
      default:
        // 未知块类型:不猜,也不让它进本地内核。记一条,继续。
        diagnostics.push({ code: 'tool.unencodable', detail: str(block['type']) ?? 'unknown' })
        break
    }
  }

  // 助手消息里出现 tool_result、或用户消息里出现 tool_use,都是形状错乱 ——
  // 真发生了就说明我们对源格式的理解有偏差,记下来比静默接受强。
  const misplaced = parts.some((part) =>
    role === 'assistant' ? part.type === 'tool_result' : part.type === 'tool_call'
  )
  if (misplaced) diagnostics.push({ code: 'transcript.unparsable', detail: `role=${role}` })

  return { parts, images, diagnostics }
}

// ─── 主分支恢复 ───────────────────────────────────────────────────────────

/**
 * 从叶子回溯到根。见文件头那段「主分支是怎么恢复的」。
 *
 * ★★ `dag` 里装的是**所有带 uuid 的记录**,不只是 user/assistant。
 *
 * 这是真机数据教的:`attachment` 和 `system` 记录同样带着 `uuid` / `parentUuid`,
 * 它们是这张图上的**真实节点**。只把 user/assistant 放进 uuid 表的话,链会在
 * 第一个附件处断掉 —— 而附件在真实转录里到处都是,于是**每一条会话**都报
 * 「转录末尾不完整」,并且只恢复出末尾那一小段。
 *
 * 所以分工是:**遍历走全图,产出只取消息**。
 *
 * ★ 环检测用的是 `seen`,不是深度上限。畸形数据造出的环会让这个循环
 * 永远跑下去,而这是主进程 —— 转死它就是整个应用没有响应。
 */
function mainBranch(
  dag: readonly RawRecord[],
  leafCandidates: readonly RawRecord[]
): { chain: RawRecord[]; broken: boolean } {
  const byUuid = new Map<string, RawRecord>()
  for (const record of dag) {
    // 重复 uuid 保留**第一次**出现的。重发的助手块在后面,内容相同;
    // 留第一条让顺序和时间戳都对得上。
    if (record.uuid !== undefined && !byUuid.has(record.uuid)) byUuid.set(record.uuid, record)
  }

  // ★ 叶子只能是一条**消息**。取最后一条 `attachment` 当叶子的话,
  //   回溯出来的链会缺掉它后面那几轮真正的对话。
  const leaf = leafCandidates[leafCandidates.length - 1]
  if (leaf === undefined) return { chain: [], broken: false }

  /*
    ★ 一个 uuid 都没有的转录:**回落到文件顺序**。

    这不违反文件头那条「不按文件顺序拼」—— 那条禁令针对的是「有分叉信息却不用」,
    而这里根本没有分叉信息可言,文件顺序是唯一存在的顺序。反过来,坚持走回溯
    会让整份对话只剩最后一条记录,而那是**静默丢掉全部内容**,比顺序可能不准糟得多。
  */
  if (byUuid.size === 0) return { chain: [...leafCandidates], broken: false }

  const chain: RawRecord[] = []
  const seen = new Set<string>()
  let cursor: RawRecord | undefined = leaf
  let broken = false

  while (cursor !== undefined) {
    if (cursor.uuid !== undefined) {
      if (seen.has(cursor.uuid)) {
        broken = true
        break
      }
      seen.add(cursor.uuid)
    }
    chain.push(cursor)
    /*
      ★ 到根之后还要看一眼 `logicalParentUuid` —— 压缩边界是一棵新树的根,
      但它指回压缩前那一段。不跟这一跳,长会话只剩最后一小段(见字段注释)。
    */
    const nextId = cursor.parentUuid ?? cursor.logicalParentUuid
    if (nextId === undefined) break // 真的到根了
    const parent: RawRecord | undefined = byUuid.get(nextId)
    if (parent === undefined) {
      // 父记录不在这个文件里:被清理过,或者这份转录是接着另一份写的。
      broken = true
      break
    }
    cursor = parent
  }

  chain.reverse()
  return { chain, broken }
}

/** 没有 uuid 的记录也要有一个稳定键 —— 否则重复扫描每次都当成新消息。 */
function fallbackKey(parts: readonly ContentPart[], role: string, occurrence: number): string {
  // 便宜的内容指纹:不追求密码学强度,只要同内容同键、异内容异键。
  const text = JSON.stringify({ role, parts })
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  // ★ 带上「同内容第几次出现」——「好的」说两遍是两条真实发言,不是重复记录。
  return `fp:${hash.toString(36)}:${String(occurrence)}`
}

// ─── 入口 ─────────────────────────────────────────────────────────────────

/**
 * 一份转录的全部解析。**永不 throw** —— 一份坏掉的转录不该让整次扫描失败,
 * 和 `scanSkills` / `scanInstructions` 同一条规矩。
 *
 * `lines` 已经由读取侧按 `IMPORT_LIMITS` 做过行长与总量限制。
 */
export function parseTranscript(lines: readonly string[], options: ParseOptions): ParsedTranscript {
  const diagnostics: ImportDiagnostic[] = []
  /** 所有带 uuid 的记录 —— **遍历走这张图**,含 attachment / system。 */
  const dag: RawRecord[] = []
  /** 只有 user / assistant —— 选叶子和产出消息走这一份。 */
  const messages0: RawRecord[] = []
  /** 无 uuid 的旁挂记录里能给出标题的那些(`ai-title` / 老版本的 `summary`)。 */
  const titles: RawRecord[] = []
  let cwd = ''
  let sessionId = ''
  let model: string | undefined
  let badLines = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      /*
        ★ 最后一行解不开是**常态**,不是损坏:Claude Code 正在写的时候我们读了它。
        中间行解不开才是真的坏 —— 两者的诊断必须不同,否则用户会为一次正常的
        并发读看到「文件已损坏」。
      */
      if (i === lines.length - 1) diagnostics.push({ code: 'transcript.truncated-tail' })
      else badLines += 1
      continue
    }
    const record = toRawRecord(value, i + 1)
    if (record === undefined) continue
    if (record.cwd !== undefined && cwd === '') cwd = record.cwd
    if (record.sessionId !== undefined && sessionId === '') sessionId = record.sessionId

    // 标题的两种来源。★ 真机上是 `ai-title`;`summary` 是别的版本的形状,一并认。
    if (record.aiTitle !== undefined || record.type === 'summary') {
      titles.push(record)
      continue
    }

    /*
      ★★ 带 uuid 的**一律进图**,包括 attachment / system,也包括 sidechain 与 meta。

      遍历和产出是两件事:少放一种节点进图,链就会在那儿断掉(真机上断在
      `attachment` 上,于是每条会话都报「末尾不完整」且只剩尾巴那一小段);
      而 sidechain / meta 的排除属于**产出**侧,在下面做。
    */
    if (record.uuid !== undefined) dag.push(record)

    // 子代理转录、meta 记录不产出消息。首版保留主聊天里已有的子代理结果/摘要,
    // 不单独导入整棵子代理会话树。
    if (record.isSidechain || record.isMeta) continue
    if (!isMessageRecord(record)) continue
    if (record.type === 'assistant' && model === undefined) model = str(record.message?.['model'])
    messages0.push(record)
  }

  if (badLines > 0) diagnostics.push({ code: 'transcript.unparsable', detail: String(badLines) })

  if (messages0.length === 0) {
    diagnostics.push({ code: 'transcript.empty' })
    return { sessionId: sessionId || options.fallbackSessionId, cwd, messages: [], diagnostics }
  }

  const { chain, broken } = mainBranch(dag, messages0)
  if (chain.length === 0) {
    diagnostics.push({ code: 'transcript.branch-unresolvable' })
    return { sessionId: sessionId || options.fallbackSessionId, cwd, messages: [], diagnostics }
  }
  if (broken) diagnostics.push({ code: 'transcript.truncated-tail' })

  const messages: ImportedMessage[] = []
  const occurrences = new Map<string, number>()
  let truncated = false

  for (const record of chain) {
    if (messages.length >= options.maxMessages) {
      truncated = true
      break
    }
    // ★ 图上的 attachment / system / sidechain 节点只是路过,不产出消息。
    if (!isMessageRecord(record) || record.isSidechain || record.isMeta) continue
    const role = record.type === 'assistant' ? 'assistant' : 'user'
    const mapped = mapContent(record.message?.['content'], role)
    diagnostics.push(...mapped.diagnostics)
    if (mapped.parts.length === 0) continue // 空壳记录(纯元数据)不占一条消息

    const key = record.uuid ?? (() => {
      const base = fallbackKey(mapped.parts, role, 0)
      const seen = occurrences.get(base) ?? 0
      occurrences.set(base, seen + 1)
      return fallbackKey(mapped.parts, role, seen)
    })()

    messages.push({
      sourceId: key,
      role,
      parts: mapped.parts,
      createdAt: record.timestamp ?? Date.now(),
      images: mapped.images
    })
  }

  if (truncated) diagnostics.push({ code: 'transcript.oversize', detail: String(chain.length) })

  const repaired = repairToolPairing(messages, diagnostics)
  const title = pickTitle(titles, chain, repaired)
  const first = repaired[0]
  const last = repaired[repaired.length - 1]

  return {
    sessionId: sessionId || options.fallbackSessionId,
    cwd,
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(first === undefined ? {} : { startedAt: first.createdAt }),
    ...(last === undefined ? {} : { updatedAt: last.createdAt }),
    messages: repaired,
    diagnostics
  }
}

/**
 * 落单的 `tool_call` 降级成可读正文。
 *
 * ★ 为什么非做不可:Anthropic 要求每个 `tool_use` 都在紧随的 user 消息里有配对的
 * `tool_result`(见 `shared/agent/message.ts` 的 `orphanedToolCalls`)。源侧在
 * 工具调用发出、结果回来之前被中断是很常见的,那条转录的末尾就挂着一个没有结果的
 * 调用 —— 原样导入的话,用户点「继续」的第一次请求就会被上游拒绝。
 *
 * ★ 为什么不补一个结果:那会在界面上变成一张「执行成功」或「执行失败」的工具卡,
 * 而那次执行从来没有发生过。降级成一行文字是唯一诚实的处置。
 */
function repairToolPairing(
  messages: readonly ImportedMessage[],
  diagnostics: ImportDiagnostic[]
): ImportedMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') answered.add(part.callId)
    }
  }

  let downgraded = 0
  const result = messages.map((message) => {
    if (!message.parts.some((part) => part.type === 'tool_call' && !answered.has(part.callId))) {
      return message
    }
    // 图片按**原下标**索引;降级会让后面的下标整体前移,所以要边走边重算。
    const imageAt = new Map(message.images.map((image) => [image.partIndex, image]))
    const parts: ContentPart[] = []
    const images: PendingImage[] = []
    for (let i = 0; i < message.parts.length; i += 1) {
      const part = message.parts[i]
      if (part === undefined) continue
      if (part.type === 'tool_call' && !answered.has(part.callId)) {
        downgraded += 1
        parts.push({ type: 'text', text: `[工具调用 ${part.name}:源转录中没有对应结果,已转为文字记录]` })
        continue
      }
      const image = imageAt.get(i)
      if (image !== undefined) images.push({ ...image, partIndex: parts.length })
      parts.push(part)
    }
    return { ...message, parts, images }
  })

  if (downgraded > 0) diagnostics.push({ code: 'tool.unencodable', detail: String(downgraded) })
  return result
}

/**
 * 标题。
 *
 * ## 三级,顺序有意义
 *
 * 1. **`ai-title` 记录的 `aiTitle`** —— 真机上会话标题就在这里,而且会随对话
 *    重新生成,所以取**最后一条**。一份转录里有几十条 `ai-title` 是常态。
 * 2. 老版本的 `summary` 记录(本机数据里一条都没有,但别的版本有,一并认)。
 * 3. 首条**真实**用户发言的第一行。
 *
 * ★★ 第 3 级必须跳过系统注入的包装。`<command-name>/compact</command-name>`、
 * `<task-notification>`、`<local-command-stdout>` 这些确实是 `role: user` 的
 * 记录,但它们不是用户说的话 —— 直接拿来当标题,侧边栏上会出现一排
 * 「<command-name>/compact</command-name>」,而用户根本认不出那是哪次对话。
 *
 * ★ 三级都没有时返回 undefined,由调用方落到「新对话」—— 在这里编一个标题
 * 会让「源侧本来就没起名」这件事看不出来。
 */
function pickTitle(
  titles: readonly RawRecord[],
  chain: readonly RawRecord[],
  messages: readonly ImportedMessage[]
): string | undefined {
  // 从后往前:标题会随对话重新生成,最后那条最贴切。
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    const text = titles[i]?.aiTitle?.trim()
    if (text !== undefined && text !== '') return text.slice(0, 80)
  }

  const chainUuids = new Set(chain.map((record) => record.uuid).filter((id): id is string => id !== undefined))
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    const record = titles[i]
    if (record?.summary === undefined) continue
    if (record.leafUuid !== undefined && !chainUuids.has(record.leafUuid)) continue
    const text = record.summary.trim()
    if (text !== '') return text.slice(0, 80)
  }

  for (const message of messages) {
    if (message.role !== 'user') continue
    const part = message.parts.find((p) => p.type === 'text')
    if (part?.type !== 'text') continue
    const line = firstMeaningfulLine(part.text)
    if (line !== undefined) return line.slice(0, 80)
  }
  return undefined
}

/**
 * 系统注入的用户消息包装。命中就不能拿来当标题。
 *
 * ★ 判据是**整条**以标签开头,不是「含有尖括号」—— 用户自己写的
 * 「`<div>` 为什么不居中」是一句正经问题,不该被滤掉。
 */
const SYNTHETIC_USER_PREFIX =
  /^\s*(<(command-name|command-message|command-args|task-notification|local-command-stdout|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b|Caveat: The messages below were generated)/i

function firstMeaningfulLine(text: string): string | undefined {
  if (SYNTHETIC_USER_PREFIX.test(text)) return undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (SYNTHETIC_USER_PREFIX.test(line)) return undefined
    return line
  }
  return undefined
}
