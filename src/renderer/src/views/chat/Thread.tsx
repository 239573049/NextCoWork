/**
 * 对话流。
 *
 * ★ **已提交的 parts 和还在流的 live 块走同一套块渲染器**(`parts.tsx`)。
 * 一个块从「流式中」变成「已提交」的那一瞬间不该跳动 —— 而两套渲染必然会跳。
 *
 * ★ **`isToolResultOnly` 的消息必须过滤掉。** 工具结果在内部格式里是一条
 * `role: 'user'` 的消息(Anthropic 形状,方案 §4.1),不滤掉的话每次工具调用
 * 之后都会多出一个空白的用户气泡 —— 而它长得完全像一个 bug,查起来却要
 * 一路翻到消息模型才明白。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly } from '../../../../shared/agent/message'
import { runDurationOf } from '../../../../shared/agent/duration'
import type { LiveBlock, TranscriptState } from '../../../../shared/agent/transcript'
import { ProviderIcon } from '../../components/brand/ProviderIcon'
import { AgentMarkdown } from '../../components/markdown'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { agentErrorText } from '../../i18n/agent'
import { MessageImage } from './MessageImage'
import { SubagentNode, ThinkingBlock, ToolCallCard } from './parts'
import { InteractionPanel } from './InteractionPanel'
import { StatusLine } from './StatusLine'
import { ToolTimeline } from './ToolTimeline'
import { RunProcessBlock } from './RunProcessBlock'
import { ContextCheckpointPanel } from './ContextCheckpointPanel'
import { assistantSegments, isAssistantTextBlock, threadRows, type AssistantBlock } from './thread-content'
import { decideWorkspace, statusOfItem } from '../../../../shared/domain/tool-timeline'

export function Thread({
  transcript,
  runId,
  providerName,
  lastSeq,
  queued,
  onEditMessage
}: {
  transcript: TranscriptState
  runId: string | null
  lastSeq: number
  queued: number
  onEditMessage?: (id: string, text: string, continueRun: boolean) => Promise<void>
  /** 助手消息上方那行 `供应商 / 模型`(截图:`RoutinAI / claude-fable-5-1`) */
  providerName: string | undefined
}): ReactNode {
  const { t } = useI18n()
  const { messages, live, tools, subagents, model, error, usage } = transcript
  const running = runId !== null
  const visible = messages.filter((m) => !isToolResultOnly(m))
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  /**
   * 上一次**我们自己**把 scrollTop 写到的位置;`-1` = 没有待确认的程序化滚动。
   * 一次程序化写入最多派发一个 scroll 事件,认领掉就把它清空。
   */
  const selfScrolled = useRef(-1)
  /** 上一次看到的几何量。判断「这一下是谁滚的」靠的是它的**变化方向**,不是离底距离。 */
  const lastSeen = useRef({ top: 0, height: 0 })
  const needsReply = live.length === 0 && visible.at(-1)?.role !== 'assistant'

  // Follow growing replies and newly arriving interactions only while the user
  // is near the bottom. Reading older messages must not trigger a forced jump.
  useEffect(() => {
    const scroller = viewport.current
    const body = content.current
    if (scroller === null || body === null) return
    const follow = (): void => {
      if (followBottom.current) {
        const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        // 已经在底就**不写**。写了也不会派发 scroll 事件,却会留下一个永远等不到
        // 确认的 token —— 而那个 token 会把用户「滚回底部」的那一下吃掉。
        if (scroller.scrollTop !== bottom) {
          scroller.scrollTop = bottom
          selfScrolled.current = scroller.scrollTop
        }
      }
      lastSeen.current = { top: scroller.scrollTop, height: scroller.scrollHeight }
    }
    const observer = new ResizeObserver(follow)
    observer.observe(body)
    observer.observe(scroller)
    follow()
    return () => observer.disconnect()
  }, [])

  const feedback = (
    <div className="flex flex-col gap-2.5" data-testid="assistant-feedback">
      {error && !messages.some((m) => m.parts.some((p) => p.type === 'error'
        && p.error.code === error.code && p.error.message === error.message)) && (
        <p role="alert" className="selectable rounded-card border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12.5px] text-danger">
          {error.code}: {agentErrorText(error, t)}
        </p>
      )}
      {runId !== null && <InteractionPanel key={runId} runId={runId} />}
      {runId === null && usage !== undefined && <TaskUsage usage={usage} />}
      <StatusLine transcript={transcript} running={running} waitingForResponse={running && needsReply}
        lastSeq={lastSeq} queued={queued} />
    </div>
  )

  return (
    <div ref={viewport} className="scroll-thin fade-top min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" data-testid="thread"
      onScroll={() => {
        const el = viewport.current
        if (el === null) return
        const top = el.scrollTop
        const height = el.scrollHeight
        const seen = lastSeen.current
        /*
          ★ **不能拿「离底距离」反推「用户是不是滚走了」。**

          scroll 事件是异步派发的:`follow()` 在 ResizeObserver 回调里写 scrollTop,
          事件要等下一帧的 scroll steps 才送到 —— 而按 HTML「更新渲染」的步骤,
          **scroll steps 排在 ResizeObserver steps 前面**。只要这中间又有东西把内容
          撑高(mermaid 图渲完、图片解码完、代码高亮回来),处理器量到的就是
          「离底 2700px」,读成「用户滚上去了」→ 后面所有 `follow()` 全部空转,
          滚动条永久停在半路。带 mermaid 的会话里内容会断断续续长好几秒、
          派发上百次 scroll 事件,撞中几乎是必然的。

          改成看**变化方向**,它不受内容长高影响:
          - `follow()` 只会把视图往**下**带;
          - 浏览器的夹取只在内容**变矮**时把 scrollTop 往上拽。
          所以「位置往上走了、而且高度没变矮」这件事只有用户做得到。
          反过来要恢复跟随,则要求高度没动 —— 那一下才确定是用户自己滚的。
        */
        if (top === selfScrolled.current) {
          selfScrolled.current = -1
        } else if (top < seen.top && height >= seen.height) {
          followBottom.current = false
        } else if (height === seen.height) {
          followBottom.current = height - top - el.clientHeight < 80
        }
        lastSeen.current = { top, height }
      }}>
      <div ref={content} className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-6">
        <ContextCheckpointPanel checkpoints={transcript.contextCheckpoints} />
        {threadRows(messages, live, running).map((row, index, rows) =>
          row.kind === 'user' ? (
            <UserBubble key={row.key} message={row.message} onEdit={onEditMessage} disabled={running} />
          ) : (
            <AssistantTurn
              key={row.key}
              blocks={row.blocks}
              tools={tools}
              subagents={subagents}
              model={model}
              providerName={providerName}
              runStatus={transcript.status}
              runStartedAt={transcript.runStartedAt ?? row.startedAt}
              runEndedAt={transcript.runEndedAt ?? row.endedAt}
              collapseEnabled={index === rows.length - 1}
              feedback={index === rows.length - 1 ? feedback : undefined}
            />
          )
        )}
      </div>
    </div>
  )
}

function TaskUsage({ usage }: { usage: TranscriptState['usage'] }): ReactNode {
  const { t } = useI18n()
  if (usage === undefined) return null
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreate = usage.cacheCreationInputTokens ?? 0
  const inputTotal = usage.inputTokens + cacheRead + cacheCreate
  const cacheRate = inputTotal > 0 ? cacheRead / inputTotal : 0
  return (
    <div className="group relative w-fit" data-testid="task-usage">
      <div className="cursor-help text-[11px] text-fg-faint">
        {t('chat.taskUsageSummary', { input: inputTotal, output: usage.outputTokens })}
      </div>
      <div className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 w-max max-w-[min(360px,calc(100vw-48px))] rounded-card border border-border bg-surface-raised px-3 py-2 text-[11px] text-fg shadow-lg opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100">
        <div className="mb-1 font-medium">{t('chat.taskUsage')}</div>
        <div>{t('chat.taskUsageInput', { count: inputTotal })}</div>
        <div>{t('chat.taskUsageOutput', { count: usage.outputTokens })}</div>
        {cacheRead > 0 && <div>{t('chat.taskUsageCacheRead', { count: cacheRead })}</div>}
        {cacheCreate > 0 && <div>{t('chat.taskUsageCacheCreate', { count: cacheCreate })}</div>}
        <div>{t('chat.taskUsageCacheRate', { rate: `${(cacheRate * 100).toFixed(1)}%` })}</div>
      </div>
    </div>
  )
}

/**
 * 用户气泡。
 *
 * ★ **不能只取 text part。** 原实现把 parts 里的文本拼起来、其余一律丢弃,
 * 于是两件事同时发生:发出去的图在自己的气泡里看不见,而**只发图不发文字**的
 * 消息因为 `text === ''` 被整条 return null —— 那条消息从界面上彻底消失,
 * 尽管它已经发给模型了。而「拖张图进来直接问」正是最常见的用法之一。
 *
 * 按 parts 原顺序渲染:发送侧 `partsOf` 把文本放在最前,所以视觉上是
 * 「先说话、后配图」,与用户敲下去的顺序一致。
 */
function UserBubble({ message, onEdit, disabled }: { message: AgentMessage; onEdit?: (id: string, text: string, continueRun: boolean) => Promise<void>; disabled: boolean }): ReactNode {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [textDraft, setTextDraft] = useState('')
  const text = message.parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim()
  const images = message.parts.filter(
    (p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image'
  )

  // 文本与图片都没有才是真的空
  if (text === '' && images.length === 0) return null

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-[min(85%,520px)] rounded-card rounded-br-[4px] bg-tint px-3.5 py-2.5">
          <textarea
            autoFocus
            value={textDraft}
            onChange={(event) => setTextDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (!disabled) {
                  void onEdit?.(message.id, textDraft, true)
                  setEditing(false)
                }
              }
            }}
            className="scroll-thin selectable min-h-[72px] w-full resize-y bg-transparent text-[13.5px] leading-relaxed text-fg focus:outline-none"
            aria-label={t('chat.editMessage')}
            data-testid="user-message-editor"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setEditing(false)} className="rounded-[6px] px-2.5 py-1 text-[12px] text-fg-muted hover:bg-tint-hover">
              {t('common.cancel')}
            </button>
            <button type="button" disabled={disabled} data-testid="user-message-save" onClick={() => { void onEdit?.(message.id, textDraft, false); setEditing(false) }} className="rounded-[6px] px-2.5 py-1 text-[12px] text-fg-muted hover:bg-tint-hover disabled:opacity-40">
              {t('common.save')}
            </button>
            <button type="button" disabled={disabled} data-testid="user-message-save-continue" onClick={() => { void onEdit?.(message.id, textDraft, true); setEditing(false) }} className="rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg disabled:opacity-40">
              {t('chat.saveAndContinue')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[85%] rounded-card rounded-br-[4px] bg-tint px-3.5 py-2.5">
        {text !== '' && (
          <p className="selectable text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg">
            {text}
          </p>
        )}
        {images.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', text !== '' && 'mt-2')}>
            {images.map((img, i) => (
              <MessageImage
                key={`${img.dataRef}:${String(i)}`}
                mime={img.mime}
                dataRef={img.dataRef}
                // ★ 同一条消息里的图是一组 —— 灯箱据此给出翻页
                siblings={images.map((x) => ({ mime: x.mime, dataRef: x.dataRef }))}
                index={i}
              />
            ))}
          </div>
        )}
        {onEdit !== undefined && (
          <button
            type="button"
            disabled={disabled}
            aria-label={t('chat.editMessage')}
            title={t('chat.editMessage')}
            data-testid="user-message-edit"
            onClick={() => { setTextDraft(text); setEditing(true) }}
            className="absolute -left-8 top-1/2 -translate-y-1/2 rounded-[6px] p-1 text-fg-faint opacity-0 transition-opacity hover:bg-tint-hover hover:text-fg-muted group-hover:opacity-100 disabled:pointer-events-none"
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

/** 助手回合的抬头:`供应商 / 模型`。三样都是已有事件的直接投影,不新增数据。 */
function TurnHeader({
  model,
  providerName
}: {
  model: string | undefined
  providerName: string | undefined
}): ReactNode {
  if (model === undefined) return null
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-fg-faint">
      <ProviderIcon name={[model, providerName]} size={13} />
      {providerName !== undefined && (
        <>
          <span>{providerName}</span>
          <span className="text-fg-faint/60">/</span>
        </>
      )}
      <span className="min-w-0 truncate">{model}</span>
    </div>
  )
}

function AssistantTurn({
  blocks,
  tools,
  subagents,
  model,
  providerName,
  runStatus,
  runStartedAt,
  runEndedAt,
  collapseEnabled,
  feedback
}: {
  blocks: readonly AssistantBlock[]
  tools: TranscriptState['tools']
  subagents: TranscriptState['subagents']
  model: string | undefined
  providerName: string | undefined
  runStatus: TranscriptState['status']
  runStartedAt?: number
  runEndedAt?: number
  collapseEnabled: boolean
  feedback?: ReactNode
}): ReactNode {
  const { t } = useI18n()
  const segments = assistantSegments(blocks, t('chat.tool.name'), subagents)
  const lastProcessIndex = segments.reduce((last, segment, index) => segment.kind === 'process' ? index : last, -1)
  const processSegments = lastProcessIndex < 0 ? [] : segments.slice(0, lastProcessIndex + 1)
  const trailingSegments = lastProcessIndex < 0 ? segments : segments.slice(lastProcessIndex + 1)
  const processItems = processSegments.flatMap((segment) => segment.kind === 'process' ? segment.items : [])
  const errorCount = processItems.filter((item) => statusOfItem(item, tools) === 'error').length
  const hasRunningSubagent = processItems.some((item) => item.kind === 'subagent' && item.state?.status === 'running')
  const hasTrailingText = trailingSegments.some((segment) => segment.kind === 'block' && isAssistantTextBlock(segment.block))
  const outcome = runStatus === 'done' ? 'ok' : runStatus
  const decision = collapseEnabled && !hasRunningSubagent
    ? decideWorkspace({
        outcome,
        itemCount: processItems.length,
        hasTrailingText,
        errorCount
      })
    : { collapse: false, defaultOpen: false }
  const calls = processItems.flatMap((item) => {
    if (item.kind !== 'tool' || item.callId === undefined) return []
    const call = tools[item.callId]
    return call === undefined ? [] : [call]
  })
  const durationMs = runDurationOf({ runStartedAt, runEndedAt }, calls)

  const body = decision.collapse ? (
    <>
      <RunProcessBlock items={processItems} tools={tools} subagents={subagents} durationMs={durationMs} defaultOpen={decision.defaultOpen}>
        {processSegments.map((segment) => {
          if (segment.kind === 'block') {
            return <PartBlock key={segment.key} part={segment.block.part} liveBlock={segment.block.liveBlock}
              tools={tools} streaming={segment.block.streaming} cursor={segment.block.cursor} />
          }
          return <ToolTimeline key={segment.key} items={segment.items} tools={tools} subagents={subagents} />
        })}
      </RunProcessBlock>
      {trailingSegments.map((segment) => segment.kind === 'block' ? (
        <PartBlock key={segment.key} part={segment.block.part} liveBlock={segment.block.liveBlock}
          tools={tools} streaming={segment.block.streaming} cursor={segment.block.cursor} />
      ) : <ToolTimeline key={segment.key} items={segment.items} tools={tools} subagents={subagents} />)}
    </>
  ) : (
    <>
      {segments.map((segment) => {
        if (segment.kind === 'block') {
          return <PartBlock key={segment.key} part={segment.block.part} liveBlock={segment.block.liveBlock}
            tools={tools} streaming={segment.block.streaming} cursor={segment.block.cursor} />
        }
        return <ToolTimeline key={segment.key} items={segment.items} tools={tools} subagents={subagents} />
      })}
    </>
  )

  return (
    <div className="flex flex-col gap-2.5" data-testid="assistant-turn">
      <TurnHeader model={model} providerName={providerName} />
      {body}
      {feedback}
    </div>
  )
}

function PartBlock({
  part,
  liveBlock,
  tools,
  streaming = false,
  cursor = false
}: {
  part?: ContentPart
  liveBlock?: LiveBlock
  tools: TranscriptState['tools']
  streaming?: boolean
  cursor?: boolean
}): ReactNode {
  const { t } = useI18n()
  if (liveBlock) {
    switch (liveBlock.kind) {
      case 'text':
        return <AgentMarkdown content={liveBlock.text} streaming={cursor} />
      case 'thinking':
        return <ThinkingBlock text={liveBlock.text} streaming={streaming} />
      case 'tool_use':
        return <ToolCallCard call={liveBlock.callId === undefined ? undefined : tools[liveBlock.callId]}
          name={liveBlock.name ?? t('chat.tool.name')} input={liveBlock.text} />
    }
  }
  if (!part) return null
  switch (part.type) {
    case 'text':
      return part.text.trim() === '' ? null : <AgentMarkdown content={part.text} />
    case 'thinking':
      return <ThinkingBlock text={part.text} streaming={false} />
    case 'tool_call':
      return (
        <ToolCallCard call={tools[part.callId]} name={part.name} input={part.input} />
      )
    // 工具结果折在上面那张卡片里 —— 单独再画一遍就是同一件事显示两次
    case 'tool_result':
      return null
    case 'subagent':
      return <SubagentNode summary={part.summary} />
    case 'image':
      return <MessageImage mime={part.mime} dataRef={part.dataRef} />
    case 'error':
      return (
        <p className="selectable font-mono text-[12.5px] text-danger">
          {part.error.code}: {agentErrorText(part.error, t)}
        </p>
      )
  }
}
