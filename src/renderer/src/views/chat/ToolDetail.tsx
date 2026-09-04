/**
 * 展开后的详情区 —— 按形态类分派的渲染器表。
 *
 * ★ **这里是 G2(零差异化)真正被解决的地方。** 现状是所有工具的入参和结果
 * 一律 `JSON.stringify` 塞进 `<pre>`,于是一次 `Write` 会把整个文件内容
 * 当作 JSON 字符串转义后显示出来 —— 换行变成 `\n`,几千字符挤成一坨,
 * 而那恰恰是用户最想看清楚的东西。
 *
 * ★ **`external` 分支保留了现状的 JSON 行为**,而且必须保留:MCP 工具的入参形状
 * 编译期不可知,任何「智能」猜测都会在某个 server 上猜错。通用 JSON 是唯一
 * 对未知输入永远正确的呈现。
 */
import type { ReactNode } from 'react'
import type { ToolOutput } from '../../../../shared/agent/message'
import type { ToolShape } from '../../../../shared/domain/tool-presenter'
import { cn } from '../../lib/cn'

// ─────────────────────────── 原语 ───────────────────────────

/** 详情区里的一个带标签的块。样式沿用改造前 `parts.tsx` 的 Labeled,不新增 token。 */
export function Labeled({
  label,
  children,
  tone = 'normal'
}: {
  label: string
  children: ReactNode
  tone?: 'normal' | 'danger'
}): ReactNode {
  return (
    <div className="mt-1.5 first:mt-0">
      <p className={cn('mb-0.5 text-[11px]', tone === 'danger' ? 'text-danger' : 'text-fg-faint')}>
        {label}
      </p>
      <pre
        className={cn(
          'selectable scroll-thin max-h-56 overflow-auto rounded-[7px] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap',
          tone === 'danger' ? 'bg-danger/5 text-danger' : 'bg-canvas text-fg-muted'
        )}
      >
        {children}
      </pre>
    </div>
  )
}

export function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    // 循环引用 / BigInt / Symbol 都会走到这里。详情区显示一行退化文本,
    // 好过让整个转录因为一次序列化异常白屏。
    return String(v)
  }
}

/** 安全取字段(与 tool-presenter 的 pick 同构,但这里允许返回非字符串) */
function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

function str(input: unknown, key: string): string {
  const v = field(input, key)
  return typeof v === 'string' ? v : ''
}

/**
 * 超长文本按行截断,并注明省略了多少。
 *
 * 不用 CSS `max-height` 截断的原因:那样滚动条里仍然挂着几万行 DOM 文本,
 * 而这个组件在一次 run 里可能存在几十份。行数截断是把它挡在渲染之前。
 */
function clipLines(text: string, max: number): { text: string; omitted: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, omitted: 0 }
  return { text: lines.slice(0, max).join('\n'), omitted: lines.length - max }
}

function Truncated({ omitted }: { omitted: number }): ReactNode {
  if (omitted <= 0) return null
  return <span className="text-fg-faint">{`\n…另有 ${String(omitted)} 行未显示`}</span>
}

/** 结果块 —— 八个渲染器里有七个都要用,所以抽出来。 */
function OutputBlock({
  output,
  label = '结果',
  isError = false,
  maxLines = 40
}: {
  output: ToolOutput | undefined
  label?: string
  isError?: boolean
  maxLines?: number
}): ReactNode {
  if (output === undefined) return null
  const { text, omitted } = clipLines(output.content, maxLines)
  return (
    <Labeled label={isError ? '失败原因' : label} tone={isError ? 'danger' : 'normal'}>
      {text}
      <Truncated omitted={omitted} />
      {output.truncated === true && (
        <span className="text-fg-faint">
          {'\n'}…已截断(原始 {output.originalBytes ?? '?'} 字节)
        </span>
      )}
    </Labeled>
  )
}

// ─────────────────────────── 各形态渲染器 ───────────────────────────

export interface DetailProps {
  input: unknown
  output: ToolOutput | undefined
  isError: boolean
}

/** read:路径单独一行,输出当代码预览(Read 的输出本身已带 `cat -n` 行号) */
function ReadDetail({ input, output, isError }: DetailProps): ReactNode {
  const path = str(input, 'file_path') || str(input, 'path')
  return (
    <>
      {path !== '' && <PathLine path={path} />}
      <OutputBlock output={output} isError={isError} label="内容" maxLines={40} />
    </>
  )
}

/**
 * mutate:**入参里的 `content` / `new_string` 才是重点**,而它们正是现状
 * JSON 化之后最不可读的部分。这里单独拎出来按原文渲染(保留换行)。
 */
function MutateDetail({ input, output, isError }: DetailProps): ReactNode {
  const path = str(input, 'file_path')
  const content = str(input, 'content')
  const oldStr = str(input, 'old_string')
  const newStr = str(input, 'new_string')

  return (
    <>
      {path !== '' && <PathLine path={path} />}
      {oldStr !== '' && (
        <Labeled label="替换前">
          {clipLines(oldStr, 12).text}
          <Truncated omitted={clipLines(oldStr, 12).omitted} />
        </Labeled>
      )}
      {newStr !== '' && (
        <Labeled label="替换后">
          {clipLines(newStr, 12).text}
          <Truncated omitted={clipLines(newStr, 12).omitted} />
        </Labeled>
      )}
      {content !== '' && (
        <Labeled label="写入内容">
          {clipLines(content, 20).text}
          <Truncated omitted={clipLines(content, 20).omitted} />
        </Labeled>
      )}
      <OutputBlock output={output} isError={isError} maxLines={12} />
    </>
  )
}

/** search:模式 + 命中列表。命中多时只显示前 40 行,余量注明。 */
function SearchDetail({ input, output, isError }: DetailProps): ReactNode {
  const pattern = str(input, 'pattern')
  const scope = str(input, 'path') || str(input, 'glob')
  return (
    <>
      {pattern !== '' && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-faint">
          <span className="rounded-[5px] bg-canvas px-1.5 py-0.5 font-mono text-fg-muted">
            {pattern}
          </span>
          {scope !== '' && <span className="truncate">于 {scope}</span>}
        </div>
      )}
      <OutputBlock output={output} isError={isError} label="命中" maxLines={40} />
    </>
  )
}

/** command:命令原文 + 终端样式输出 */
function CommandDetail({ input, output, isError }: DetailProps): ReactNode {
  const command = str(input, 'command')
  return (
    <>
      {command !== '' && (
        <Labeled label="命令">
          <span className="text-accent-soft">$ </span>
          {command}
        </Labeled>
      )}
      <OutputBlock output={output} isError={isError} label="输出" maxLines={60} />
    </>
  )
}

/** network:URL 可点开性留给将来,先保证它完整可见且不撑破布局 */
function NetworkDetail({ input, output, isError }: DetailProps): ReactNode {
  const url = str(input, 'url')
  const query = str(input, 'query')
  const prompt = str(input, 'prompt')
  return (
    <>
      {url !== '' && <PathLine path={url} />}
      {query !== '' && (
        <div className="mb-1.5 text-[11.5px] text-fg-muted">
          <span className="text-fg-faint">查询:</span> {query}
        </div>
      )}
      {prompt !== '' && <Labeled label="提问">{clipLines(prompt, 6).text}</Labeled>}
      <OutputBlock output={output} isError={isError} label="响应" maxLines={40} />
    </>
  )
}

const TODO_MARK: Record<string, string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○'
}

/**
 * orchestration:TodoWrite 的 `todos` 是**结构化数据**,渲染成清单比 JSON
 * 有用得多 —— 这是用户在整个转录里唯一会反复回看的一份状态。
 */
function OrchestrationDetail({ input, output, isError }: DetailProps): ReactNode {
  const todos = field(input, 'todos')
  if (Array.isArray(todos) && todos.length > 0) {
    return (
      <>
        <ul className="mb-1.5 flex flex-col gap-1">
          {todos.map((t, i) => {
            const item = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>
            const status = typeof item.status === 'string' ? item.status : 'pending'
            const content = typeof item.content === 'string' ? item.content : ''
            return (
              <li
                key={i}
                className={cn(
                  'flex items-start gap-1.5 text-[12px] leading-relaxed',
                  status === 'completed' && 'text-fg-faint line-through',
                  status === 'in_progress' && 'text-fg',
                  status === 'pending' && 'text-fg-muted'
                )}
              >
                <span className="shrink-0 font-mono">{TODO_MARK[status] ?? '○'}</span>
                <span className="min-w-0 flex-1">{content}</span>
              </li>
            )
          })}
        </ul>
        <OutputBlock output={output} isError={isError} maxLines={6} />
      </>
    )
  }

  // Task / Skill:提示词往往很长,截断显示
  const prompt = str(input, 'prompt')
  const name = str(input, 'name') || str(input, 'subagent_type')
  return (
    <>
      {name !== '' && (
        <div className="mb-1.5 text-[11.5px] text-fg-muted">
          <span className="text-fg-faint">名称:</span> {name}
        </div>
      )}
      {prompt !== '' && (
        <Labeled label="任务">
          {clipLines(prompt, 10).text}
          <Truncated omitted={clipLines(prompt, 10).omitted} />
        </Labeled>
      )}
      <OutputBlock output={output} isError={isError} maxLines={30} />
    </>
  )
}

/** reasoning:纯文本流,不加等宽字体 —— 它是自然语言,不是代码 */
function ReasoningDetail({ output }: DetailProps): ReactNode {
  if (output === undefined) return null
  return (
    <p className="selectable text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-faint">
      {output.content}
    </p>
  )
}

/** external:兜底 —— 通用 JSON。这正是改造前所有工具的行为。 */
function ExternalDetail({ input, output, isError }: DetailProps): ReactNode {
  const raw = stringify(input)
  const { text, omitted } = clipLines(raw, 30)
  return (
    <>
      <Labeled label="入参">
        {text}
        <Truncated omitted={omitted} />
      </Labeled>
      <OutputBlock output={output} isError={isError} maxLines={40} />
    </>
  )
}

function PathLine({ path }: { path: string }): ReactNode {
  return (
    <p className="mb-1.5 truncate font-mono text-[11px] text-fg-faint" title={path} dir="rtl">
      {/* dir=rtl 让超长路径从**头部**省略 —— 尾部的文件名才是有用的那一半 */}
      <span dir="ltr">{path}</span>
    </p>
  )
}

/**
 * 形态类 → 详情渲染器。
 *
 * `Record<ToolShape, …>` 而不是 `Partial<…>`:少写一个形态类会**编译期**报错,
 * 而不是运行时渲染出一片空白。
 */
export const DETAIL_RENDERERS: Record<ToolShape, (p: DetailProps) => ReactNode> = {
  reasoning: ReasoningDetail,
  read: ReadDetail,
  mutate: MutateDetail,
  search: SearchDetail,
  command: CommandDetail,
  network: NetworkDetail,
  orchestration: OrchestrationDetail,
  external: ExternalDetail
}

export function ToolDetail({
  shape,
  input,
  output,
  isError
}: {
  shape: ToolShape
} & DetailProps): ReactNode {
  const Renderer = DETAIL_RENDERERS[shape]
  return <Renderer input={input} output={output} isError={isError} />
}
