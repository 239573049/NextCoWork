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
import { useEffect, useRef, type ReactNode } from 'react'
import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly } from '../../../../shared/agent/message'
import type { LiveBlock, TranscriptState } from '../../../../shared/agent/transcript'
import { ProviderIcon } from '../../components/brand/ProviderIcon'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { MessageImage } from './MessageImage'
import { SubagentNode, ThinkingBlock, ToolCallCard } from './parts'

export function Thread({
  transcript,
  running,
  providerName
}: {
  transcript: TranscriptState
  running: boolean
  /** 助手消息上方那行 `供应商 / 模型`(截图:`RoutinAI / claude-fable-5-1`) */
  providerName: string | undefined
}): ReactNode {
  const { messages, live, tools, model, error } = transcript
  const visible = messages.filter((m) => !isToolResultOnly(m))
  const bottom = useRef<HTMLDivElement>(null)

  /**
   * 跟随滚动。依赖是 `live.length` 与消息数,**不是整个 transcript** ——
   * 每个 token 都触发一次 `scrollIntoView` 会和用户自己的滚轮打架。
   */
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [visible.length, live.length])

  /*
    ★ **这里没有空态分支,是故意的。** 会话一条消息都没有时,ChatView 根本不挂
    Thread —— 那一屏是问候语加输入框(见 ChatView 里的 `started`)。
    所以走到这儿而 `visible` 为空只剩一种处境:**run 已经起了、第一个事件还没到**
    (刚 attach 上去的那一瞬,或者本轮只产出了工具结果消息)。
    那一瞬该是一块空白的转录区,不是一张「还没有开始对话」的插画 ——
    插画在这里会闪一下再被文字顶掉,看着像渲染错了。
  */
  return (
    <div className="scroll-thin fade-top min-h-0 flex-1 overflow-y-auto" data-testid="thread">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-6">
        {visible.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} message={m} />
          ) : (
            <AssistantTurn
              key={m.id}
              parts={m.parts}
              tools={tools}
              model={model}
              providerName={providerName}
            />
          )
        )}

        {/* 还在流的块。提交后 live 必须为空,否则整段重影 */}
        {live.length > 0 && (
          <LiveTurn
            live={live}
            tools={tools}
            model={model}
            providerName={providerName}
            running={running}
          />
        )}

        {error && (
          <p className="selectable rounded-card border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12.5px] text-danger">
            {error.code}: {error.message}
          </p>
        )}

        <div ref={bottom} />
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
function UserBubble({ message }: { message: AgentMessage }): ReactNode {
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

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-card rounded-br-[4px] bg-tint px-3.5 py-2.5">
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
  parts,
  tools,
  model,
  providerName
}: {
  parts: readonly ContentPart[]
  tools: TranscriptState['tools']
  model: string | undefined
  providerName: string | undefined
}): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <TurnHeader model={model} providerName={providerName} />
      {parts.map((p, i) => (
        <PartBlock key={i} part={p} tools={tools} />
      ))}
    </div>
  )
}

function PartBlock({
  part,
  tools
}: {
  part: ContentPart
  tools: TranscriptState['tools']
}): ReactNode {
  switch (part.type) {
    case 'text':
      return part.text.trim() === '' ? null : <Prose>{part.text}</Prose>
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
          {part.error.code}: {part.error.message}
        </p>
      )
  }
}

function LiveTurn({
  live,
  tools,
  model,
  providerName,
  running
}: {
  live: readonly LiveBlock[]
  tools: TranscriptState['tools']
  model: string | undefined
  providerName: string | undefined
  running: boolean
}): ReactNode {
  const { t } = useI18n()
  const last = live[live.length - 1]
  return (
    <div className="flex flex-col gap-2.5">
      <TurnHeader model={model} providerName={providerName} />
      {live.map((b) => {
        // 光标只跟在**最后一个文本块**后面 —— 跟在每个块后面就是一排闪烁的方块
        const cursor = running && b === last && b.kind === 'text'
        switch (b.kind) {
          case 'text':
            return (
              <Prose key={b.index} cursor={cursor}>
                {b.text}
              </Prose>
            )
          case 'thinking':
            return <ThinkingBlock key={b.index} text={b.text} streaming={running} />
          case 'tool_use':
            return (
              <ToolCallCard
                key={b.index}
                call={b.callId === undefined ? undefined : tools[b.callId]}
                name={b.name ?? t('chat.tool.name')}
                // 流式中途的参数 JSON 一定是非法的,原样显示片段而不是尝试 parse
                input={b.text}
              />
            )
        }
      })}
      {/* 一个字都还没到:给个占位,否则「已发送」到「首字」之间界面完全没反应 */}
      {live.length === 0 && running && <Prose cursor>{''}</Prose>}
    </div>
  )
}

function Prose({ children, cursor = false }: { children: string; cursor?: boolean }): ReactNode {
  return (
    <p
      className={cn(
        'selectable text-[13.5px] leading-[1.75] whitespace-pre-wrap text-fg',
        // Markdown 解析推迟到块边界(方案 §8),v1 先按纯文本渲染
        'break-words'
      )}
    >
      {children}
      {cursor && <span className="ml-0.5 animate-pulse text-accent">▍</span>}
    </p>
  )
}
