/**
 * 「压缩之后,这一轮真正发给模型的是什么」—— 上下文检查器的数据源。
 *
 * ## 需求
 *
 * 压缩组件原先只能显示一段 note 和一对 token 读数,而用户真正要问的是
 * **哪些消息还在、哪些被削过、哪些彻底没了**。这三件事都只存在于
 * `projectContextWindow` 的输出里,而那份输出从来没有离开过主进程 ——
 * 渲染层拿着转录自己是推不出来的(它看不到机械压缩把哪条的工具输出清空了)。
 *
 * ## 这个模块故意不做的事
 *
 * - **不搬运消息体**。一条 `tool_result` 可以有 64KB,整份投影过一次 IPC 是
 *   几十 MB 的结构化克隆。这里每条只出身份、估算占用和几行预览 ——
 *   完整内容用户本来就在屏幕上的转录里看着。
 * - **不算系统提示词和工具定义那两档**。它们不随压缩变化,已经由
 *   `context:preview` 那条通道按段归因(`ContextSegment`),再算一遍就是
 *   两个口径迟早分叉。这里只回答「消息这一档被压成了什么样」。
 * - **不自己定压缩规则**。切点、折叠、骨架全部来自 `projectContextWindow`,
 *   这个文件只负责把它的输出翻译成可显示的形状。
 */
import type { AgentMessage, ContentPart } from '../../shared/agent/message'
import type { ContextWindowEntry, ContextWindowEntryKind, ContextWindowView } from '../../shared/agent/context-management'
import { estimateMessages } from './context-assembler'
import { clampWithEllipsis, stripControlChars } from './text'

/** 单行预览的字符上限。够看出「这是哪一条」,不够把内容搬过来。 */
const PREVIEW_MAX = 200

/**
 * 机械压缩留下的那句占位符前缀。
 *
 * ★ 判「这条被削过」只能靠它:投影里的消息和转录里的是两个对象,
 * `parts` 已经被换掉,没有任何标志位可读(`ContentPart` 上刻意没有 metadata,
 * 理由见 `context-assembler.ts` 的 reminder 那一节)。所以判据是内容本身,
 * 而它和 `COMPACTED_TOOL_OUTPUT` 必须保持一致 —— 那边改了这里就失准,
 * 症状是面板上所有消息都显示成「原文」,而它们其实是空的。
 */
const COMPACTED_MARKERS = ['[compacted', '[context-window trim]']

function previewPart(part: ContentPart): string | undefined {
  const clean = (text: string): string => clampWithEllipsis(stripControlChars(text).trim(), PREVIEW_MAX)
  switch (part.type) {
    case 'text':
      return clean(part.text)
    case 'thinking':
      return '[thinking]'
    case 'tool_call':
      return `→ ${part.name}`
    case 'tool_result':
      return `← ${part.isError === true ? '[error] ' : ''}${clean(part.output.content)}`
    case 'subagent':
      return `[subagent] ${clean(part.summary ?? '')}`
    case 'image':
      return '[image]'
    case 'file_ref':
      return `[attachment] ${clean(part.path)}`
    case 'error':
      return `[run error] ${clean(part.error.message)}`
    case 'goal_status':
      return undefined
  }
}

function entryKind(message: AgentMessage, summaryId: string | undefined): ContextWindowEntryKind {
  if (summaryId !== undefined && message.id === summaryId) return 'summary'
  if (message.id.endsWith(':skeleton')) return 'skeleton'
  const folded = message.parts.some(
    (p) => p.type === 'text' && COMPACTED_MARKERS.some((marker) => p.text.startsWith(marker))
  )
  if (folded) return 'folded'
  const gutted = message.parts.some(
    (p) => p.type === 'tool_result' && COMPACTED_MARKERS.some((marker) => p.output.content.startsWith(marker))
  )
  return gutted ? 'folded' : 'verbatim'
}

/**
 * 投影 + 原转录 → 可显示的那一份。
 *
 * ★ `transcript` 是用来算**丢了谁**的:投影里没有、转录里有的那些 id。
 * 拿投影自己是算不出来的,而「少了哪几条」正是这个面板存在的全部理由。
 */
export function contextWindowView(input: {
  checkpointId: string
  projection: readonly AgentMessage[]
  transcript: readonly AgentMessage[]
  /** 摘要消息的 id = 检查点 id。没有模型摘要时缺省。 */
  summaryId?: string
}): ContextWindowView {
  const kept = new Set(input.projection.map((m) => m.id))
  const entries: ContextWindowEntry[] = input.projection.map((message) => ({
    id: message.id,
    role: message.role,
    kind: entryKind(message, input.summaryId),
    tokens: estimateMessages([message]),
    lines: message.parts
      .map(previewPart)
      .filter((line): line is string => line !== undefined && line !== '')
  }))
  return {
    checkpointId: input.checkpointId,
    entries,
    droppedMessageIds: input.transcript.filter((m) => !kept.has(m.id)).map((m) => m.id),
    messageTokens: estimateMessages(input.projection),
    transcriptTokens: estimateMessages(input.transcript)
  }
}
