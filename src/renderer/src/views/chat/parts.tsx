/**
 * 转录里的三种非文本块:思考 / 工具调用 / 子代理。
 *
 * 单独一个文件是因为**已提交的消息和还在流的块要用同一套渲染**:
 * `messages[].parts` 走这里,`transcript.live` 也走这里。两处各写一份的话,
 * 一个块从「流式中」变成「已提交」的那一瞬间会跳一下 —— 而那正是用户
 * 最容易注意到的时刻。
 *
 * ★ 批次 2 之后,工具行的**长相由 `shared/domain/tool-presenter.ts` 决定**,
 * 这个文件只负责把 presenter 的输出摆进版式里。新增一个工具的展示规则
 * 不需要动这里一行。
 */
import { Brain, ChevronRight, CornerDownRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { formatCallDuration } from '../../../../shared/agent/duration'
import type { ToolCallState } from '../../../../shared/agent/transcript'
import { presenterOf } from '../../../../shared/domain/tool-presenter'
import { cn } from '../../lib/cn'
import { ToolDetail } from './ToolDetail'
import { ToolIcon, type ToolViewStatus } from './ToolIcon'

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

/**
 * 工具调用卡片。
 *
 * ★ 入参和结果都**折叠**:一个 `Read` 的结果可能是 60KB
 * (`MAX_TOOL_OUTPUT_CHARS` 之内的合法体积),全铺开会把对话冲垮。
 * 展开是用户的选择,不是默认 —— **除了失败**,见下面 `open` 的算法。
 *
 * ★ **props 保持三参不变**(`call` / `name` / `input`)。批次 2 新增的所有能力
 * (图标、耗时、差异化标题与详情)全部收在组件内部,`Thread.tsx` 两处调用点
 * 一行都不用改 —— 那两处必须同构,少改一处就是「已提交」和「流式中」长得不一样。
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
  /**
   * `null` = 用户还没表态,按默认规则走;一旦点过就永久接管。
   *
   * ★ 不能写成 `useState(status === 'error')` —— 初始值只在挂载时算一次,
   * 而工具是先 running 后 error 的,那样失败永远不会自动展开。
   */
  const [manual, setManual] = useState<boolean | null>(null)

  const status: ToolViewStatus = call === undefined ? 'pending' : call.status
  const shownInput = call?.input ?? input
  const toolName = call?.name ?? name
  const presenter = presenterOf(toolName)

  // 失败默认展开:`toolFail` 的文案是设计过的可执行提示(见 fs.ts 里 Edit 失败
  // 那段三段式说明),把它藏在折叠里等于白写。
  const open = manual ?? status === 'error'

  const duration = call === undefined ? undefined : formatCallDuration(call)
  const summary = presenter.summary?.(shownInput, call?.output)

  return (
    <div
      // 状态同时给一个机器可读的属性:e2e 探针读它,而不是去正则「完成/失败」
      // 这几个会改的中文字(同 StatusLine 的理由)
      data-testid="tool-call"
      data-tool-status={status}
      data-tool-shape={presenter.shape}
      className={cn(
        'overflow-hidden rounded-card border bg-surface-raised/60',
        status === 'error' ? 'border-danger/40' : 'border-border'
      )}
    >
      {/* 失败时左侧一道竖条:在一屏十几行工具里,颜色差比文字差更快被扫到 */}
      <div className="flex">
        {status === 'error' && <span aria-hidden className="w-[2px] shrink-0 bg-danger" />}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setManual(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-tint-hover/40"
        >
          <ChevronRight
            size={13}
            className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')}
          />
          <ToolIcon shape={presenter.shape} status={status} />
          <span className="min-w-0 flex-1 truncate text-fg">{presenter.title(shownInput)}</span>

          {/* 运行中的一行进度优先于摘要 —— 它是此刻唯一在变的信息 */}
          {call?.progress !== undefined ? (
            <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-faint">
              {call.progress}
            </span>
          ) : (
            summary !== undefined && (
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-faint">
                {summary}
              </span>
            )
          )}

          <StatusSlot status={status} duration={duration} />
        </button>
      </div>

      {open && (
        <div className="border-t border-hairline px-3 py-2">
          <ToolDetail
            shape={presenter.shape}
            input={shownInput}
            output={call?.output}
            isError={status === 'error'}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 行右端那一个插槽。
 *
 * ★ **成功态显示耗时而不是「完成」二字。** 一行只有一个右侧插槽,而「完成」
 * 是默认结果、信息量接近于零;耗时才是用户会主动去看的那个数。
 * 失败态相反 —— 它必须占满这个插槽,不能被任何数字挤掉。
 */
function StatusSlot({
  status,
  duration
}: {
  status: ToolViewStatus
  duration: string | undefined
}): ReactNode {
  if (status === 'error') {
    return <span className="shrink-0 text-[11px] text-danger">失败</span>
  }
  if (status === 'running') {
    return <span className="shrink-0 text-[11px] text-accent">执行中</span>
  }
  if (status === 'pending') {
    return <span className="shrink-0 text-[11px] text-fg-faint">等待</span>
  }
  // ok:有耗时就显示耗时,没有(旧转录)就什么都不显示 —— 空着比写「完成」干净
  return duration === undefined ? null : (
    <span className="shrink-0 font-mono text-[11px] text-fg-faint">{duration}</span>
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
