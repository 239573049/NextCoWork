/**
 * 转录里的三种非文本块:思考 / 工具调用 / 子代理。
 *
 * 单独一个文件是因为**已提交的消息和还在流的块要用同一套渲染**:
 * `messages[].parts` 走这里,`transcript.live` 也走这里。两处各写一份的话,
 * 一个块从「流式中」变成「已提交」的那一瞬间会跳一下 —— 而那正是用户
 * 最容易注意到的时刻。
 */
import { Brain, ChevronRight, CornerDownRight, Wrench } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ToolCallState } from '../../../../shared/agent/transcript'
import { cn } from '../../lib/cn'

/**
 * 「深度思考 N 秒」—— 截图里是一条可折叠的行,默认收起。
 *
 * 流式过程中默认展开:思考先于正文到达,收着的话用户会盯着一个
 * 什么都不动的空白等好几秒。提交之后再收起来。
 */
export function ThinkingBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): ReactNode {
  const [open, setOpen] = useState(streaming)
  return (
    <div className="rounded-card bg-surface-raised/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-fg-muted transition-colors hover:text-fg"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Brain size={13} className="shrink-0 text-accent-soft" />
        <span className="min-w-0 flex-1 truncate">
          {streaming ? '正在深度思考…' : '深度思考'}
        </span>
      </button>
      {open && (
        <p className="selectable px-3 pb-2.5 pl-[30px] text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-faint">
          {text}
        </p>
      )}
    </div>
  )
}

const STATUS_LABEL: Record<ToolCallState['status'], string> = {
  running: '执行中',
  ok: '完成',
  error: '失败'
}

/**
 * 工具调用卡片。
 *
 * ★ 入参和结果都**折叠**:一个 `read_file` 的结果可能是 60KB
 * (`MAX_TOOL_OUTPUT_CHARS` 之内的合法体积),全铺开会把对话冲垮。
 * 展开是用户的选择,不是默认。
 */
export function ToolCallCard({
  call,
  name,
  input
}: {
  /** 从 `transcript.tools[callId]` 来;还没收到 tool_start 时可能是 undefined */
  call: ToolCallState | undefined
  /** 兜底:`tool_call` part 自带名字,即使 tools 表里还没有它 */
  name: string
  input: unknown
}): ReactNode {
  const [open, setOpen] = useState(false)
  const status = call?.status ?? 'running'
  const shownInput = call?.input ?? input

  return (
    <div
      // 状态同时给一个机器可读的属性:e2e 探针读它,而不是去正则「完成/失败」
      // 这几个会改的中文字(同 StatusLine 的理由)
      data-testid="tool-call"
      data-tool-status={status}
      className="overflow-hidden rounded-card border border-border bg-surface-raised/60"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-tint-hover/40"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')}
        />
        <Wrench size={13} className="shrink-0 text-accent-soft" />
        <span className="min-w-0 flex-1 truncate font-mono text-fg">{call?.name ?? name}</span>
        {call?.progress !== undefined && (
          <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-faint">
            {call.progress}
          </span>
        )}
        <span
          className={cn(
            'shrink-0 text-[11px]',
            status === 'running' && 'text-accent',
            status === 'ok' && 'text-fg-faint',
            status === 'error' && 'text-danger'
          )}
        >
          {STATUS_LABEL[status]}
        </span>
      </button>

      {open && (
        <div className="border-t border-hairline px-3 py-2">
          <Labeled label="入参">{stringify(shownInput)}</Labeled>
          {call?.output && (
            <Labeled label="结果">
              {call.output.content}
              {call.output.truncated === true && (
                <span className="text-fg-faint">
                  {'\n'}…已截断(原始 {call.output.originalBytes ?? '?'} 字节)
                </span>
              )}
            </Labeled>
          )}
        </div>
      )}
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-1.5 first:mt-0">
      <p className="mb-0.5 text-[11px] text-fg-faint">{label}</p>
      <pre className="selectable scroll-thin max-h-56 overflow-auto rounded-[7px] bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">
        {children}
      </pre>
    </div>
  )
}

/** 子代理:UI 上是父 run 里一个可展开节点(方案 §4.9)。展开面板留到步骤 11。 */
export function SubagentNode({ summary }: { summary: string | undefined }): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border px-3 py-2 text-[12.5px] text-fg-muted">
      <CornerDownRight size={13} className="shrink-0 text-accent-soft" />
      <span className="min-w-0 flex-1 truncate">{summary ?? '子代理运行中…'}</span>
    </div>
  )
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}
