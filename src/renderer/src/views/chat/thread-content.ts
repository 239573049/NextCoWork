import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly, visibleText } from '../../../../shared/agent/message'
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'
import type { LiveBlock, SubagentState } from '../../../../shared/agent/transcript'
import type { TimelineItem } from '../../../../shared/domain/tool-timeline'
import type { TurnPrompt } from './TurnActions'

export type AssistantBlock = {
  key: string
  part?: ContentPart
  liveBlock?: LiveBlock
  streaming: boolean
  cursor: boolean
}

export type ThreadRow =
  | { kind: 'user'; key: string; message: AgentMessage }
  | {
      kind: 'assistant'
      key: string
      blocks: AssistantBlock[]
      startedAt?: number
      endedAt?: number
      /** 产出这一轮的 run。用来查它落盘的用量;老对话没有归属,留 undefined。 */
      runId?: string
    }
  /**
   * 一次上下文压缩发生的位置。不是消息,是消息**之间**的一条线。
   * `foldedCount` 是上一条线到这条线之间的可见消息数 —— 也就是这一刀切掉的范围。
   */
  | { kind: 'divider'; key: string; checkpoint: ContextCheckpoint; foldedCount: number }

/** Tool receipts are invisible boundaries; consecutive model replies form one assistant turn. */
export function threadRows(
  messages: readonly AgentMessage[],
  live: readonly LiveBlock[],
  running: boolean,
  messageRuns: Readonly<Record<string, string>> = {},
  checkpoints: readonly ContextCheckpoint[] = []
): ThreadRow[] {
  const rows: ThreadRow[] = []
  let preceding = 'start'
  let precedingAt: number | undefined
  /*
    ★ **分隔行只落在两行之间,绝不切开一行。**

    命中锚点时先压进 `pending`,只在「马上要推一个真正的行」之前、或整段扫完之后
    才真的入列。这一个约束同时买下三样东西:

    1. 循环期间 `rows.at(-1)` **永远不可能是分隔行** —— 所以下面 `assistant()` 的
       合并判断和第「要不要补空回合」那句看到的东西和加这个功能之前一模一样,
       一轮永远不会被从中间切断。
    2. 行 key 不受影响:分隔行不动 `preceding`,自己用独立的 `compaction:` 前缀。
    3. `checkpoints` 为空时 `flush()` 是空操作,产出与改动前**逐字节相同**。

    代价是锚点落在一轮内部时,线会推迟到这一轮结束后才画。这是刻意的:
    宁可晚半轮,也不接受提交那一瞬行 key 从 `reply:a1` 变回 `reply:u1` —— 那会让
    整棵子树重新挂载(markdown 重渲、工具组的展开状态丢失、滚动跳一下)。
  */
  const anchored = checkpointsByAnchor(checkpoints)
  const pending: { checkpoint: ContextCheckpoint; foldedCount: number }[] = []
  const flush = (): void => {
    for (const item of pending) {
      rows.push({
        kind: 'divider', key: `compaction:${item.checkpoint.id}`,
        checkpoint: item.checkpoint, foldedCount: item.foldedCount
      })
    }
    pending.length = 0
  }
  const assistant = (): Extract<ThreadRow, { kind: 'assistant' }> => {
    const last = rows.at(-1)
    if (last?.kind === 'assistant') return last
    flush()
    const row: Extract<ThreadRow, { kind: 'assistant' }> = {
      kind: 'assistant', key: `reply:${preceding}`, blocks: [],
      ...(precedingAt === undefined ? {} : { startedAt: precedingAt })
    }
    rows.push(row)
    return row
  }

  let visible = 0
  let foldedBase = 0
  for (const message of messages) {
    /*
      ★ **锚点要在可见性过滤之外认。** 一轮内部触发的自动压缩,
      `coveredThroughMessageId` 多半指着一条工具回执 —— 界面上根本不存在的消息。
      跟着下面的 `continue` 一起跳过去的话,「工具回合之间压缩」那条线一条都画不出来,
      而且不报错:检查点在库里、顶部面板里也有,就是线不出现。
    */
    const shown = message.internal !== true && !isToolResultOnly(message)
    if (shown) {
      if (message.role === 'user') {
        flush()
        rows.push({ kind: 'user', key: message.id, message })
      } else {
        const row = assistant()
        message.parts.forEach((part, index) => {
          // The first assistant message follows the visible user message, so its
          // keys match the live reply. Later assistant messages in the same turn
          // use their own ids to avoid collisions across hidden tool receipts.
          const keyPrefix = row.blocks.length === 0 ? preceding : message.id
          row.blocks.push({ key: `${keyPrefix}:${index}`, part, streaming: false, cursor: false })
        })
        row.endedAt = message.createdAt
        /*
          ★ 一整轮的消息同属一个 run,所以取哪一条都一样 —— 但**不能只取第一条**:
          一轮里最早那条 assistant 消息可能是迁移之前落盘的(没有归属),
          而后面的有。取最后一个非空值,只要这一轮里有任何一条带了归属就查得到账。
        */
        const owner = messageRuns[message.id]
        if (owner !== undefined) row.runId = owner
      }
      preceding = message.id
      precedingAt = message.createdAt
      visible += 1
    }

    for (const checkpoint of anchored.get(message.id) ?? []) {
      // 折叠数在**命中锚点时**结算,而不是 flush 时 —— 否则推迟期间新消费的消息
      // 会被算进这一刀的范围里。
      pending.push({ checkpoint, foldedCount: visible - foldedBase })
      foldedBase = visible
    }
  }

  if (live.length > 0 || rows.at(-1)?.kind !== 'assistant') {
    const row = assistant()
    live.forEach((liveBlock, index) => {
      // The preceding visible message is known before this reply's committed ID.
      // Matching keys retain Markdown controls and tool-group choices on commit.
      // A later block means the earlier one has finished; only the tail can still grow.
      const streaming = running && index === live.length - 1
      row.blocks.push({ key: `${preceding}:${index}`, liveBlock, streaming,
        cursor: running && index === live.length - 1 && liveBlock.kind === 'text' })
    })
  }
  // ★ 必须排在 live 块之后:手动压缩锚在最后一条消息上,线该落在整段末尾。
  flush()
  return rows
}

/**
 * 按 `coveredThroughMessageId` 归拢检查点。
 * 锚点缺失的(压缩位置写进库之前的老数据)直接跳过 —— 它们由
 * `unanchoredCheckpoints` 交给顶部面板兜底。
 */
function checkpointsByAnchor(
  checkpoints: readonly ContextCheckpoint[]
): Map<string, ContextCheckpoint[]> {
  const byAnchor = new Map<string, ContextCheckpoint[]>()
  for (const checkpoint of [...checkpoints].sort((a, b) => a.windowIndex - b.windowIndex)) {
    const anchor = checkpoint.coveredThroughMessageId
    if (anchor === undefined) continue
    const bucket = byAnchor.get(anchor)
    if (bucket === undefined) byAnchor.set(anchor, [checkpoint])
    else bucket.push(checkpoint)
  }
  return byAnchor
}

/**
 * 在消息流里**锚不住**的检查点:没有位置字段的老数据,或者锚点那条消息
 * 已经被「删除这一轮」截掉了。它们画不出线,但笔记还得能看能改,
 * 所以仍旧交给顶部那个面板。
 */
export function unanchoredCheckpoints(
  messages: readonly AgentMessage[],
  checkpoints: readonly ContextCheckpoint[]
): ContextCheckpoint[] {
  const ids = new Set(messages.map((message) => message.id))
  return checkpoints.filter(
    (checkpoint) =>
      checkpoint.coveredThroughMessageId === undefined ||
      !ids.has(checkpoint.coveredThroughMessageId)
  )
}

/**
 * 引出某个助手回合的提问。
 *
 * 「重新生成」和「删除这一轮」都以它为锚点:前者把历史截断到这条提问之前再发一次,
 * 后者删掉从它开始的整段。所以拿不到提问的回合(会话开头补出来的空回合)
 * 两个操作都不提供 —— 没有可以退回去的地方。
 *
 * ★ **要跳过分隔行。** 压缩最常见的锚点就是刚发出的那条提问,线正好落在
 * 提问和回答之间;只看 `rows[index - 1]` 会拿到那条线、返回 undefined,
 * 症状是最新一轮的两个操作**不报错地消失**。
 */
export function promptOf(rows: readonly ThreadRow[], index: number): TurnPrompt | undefined {
  let cursor = index - 1
  while (rows[cursor]?.kind === 'divider') cursor -= 1
  const previous = rows[cursor]
  if (previous?.kind !== 'user') return undefined
  return { id: previous.message.id, text: visibleText(previous.message).trim() }
}

/**
 * 最后一个**回合**行的下标 —— 不是最后一个元素。
 *
 * ★ 手动压缩的线就落在整段末尾,那时 `rows.at(-1)` 是分隔行。照旧用
 * `index === rows.length - 1` 的话**没有任何一行**满足「末轮」:状态行、
 * 交互面板、错误提示整块不渲染,用时和用量一起退化成历史口径 —— 全程不报错。
 */
export function lastTurnIndex(rows: readonly ThreadRow[]): number {
  return rows.reduce((last, row, index) => (row.kind === 'divider' ? last : index), -1)
}

export type AssistantSegment =
  | { kind: 'block'; key: string; block: AssistantBlock }
  | { kind: 'process'; key: string; items: TimelineItem[] }

/**
 * 一个助手回合的散文正文,用于复制和导出。
 *
 * ★ **只取 text,思考过程和工具调用一律不要。** 用户点「复制」想要的是那段回答本身
 * —— 把 thinking 拼进去,粘到别处就是一大段自言自语,而它在界面上本来是折叠的。
 * 空块跳过,否则块与块之间会攒出成片的空行。
 */
export function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .map((b) => b.part?.type === 'text' ? b.part.text : b.liveBlock?.kind === 'text' ? b.liveBlock.text : '')
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .trim()
}

/** A visible assistant text block that can safely remain outside a process summary. */
export function isAssistantTextBlock(block: AssistantBlock): boolean {
  if (block.part?.type === 'text') return block.part.text.trim() !== ''
  return block.liveBlock?.kind === 'text' && block.liveBlock.text.trim() !== ''
}

/** Keep prose, images and errors in place; only adjacent process blocks share a timeline. */
export function assistantSegments(
  blocks: readonly AssistantBlock[],
  fallbackToolName: string,
  subagents: Readonly<Record<string, SubagentState>> = {}
): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const block of blocks) {
    const { part, liveBlock, key } = block
    let item: TimelineItem | undefined
    if (part?.type === 'tool_result') continue
    if (part?.type === 'text' && part.text.trim() === '') continue
    if (part?.type === 'thinking') {
      if (part.text.trim() === '') continue
      item = { key, kind: 'thinking', text: part.text, streaming: false }
    } else if (part?.type === 'tool_call') {
      if (part.name.toLowerCase() === 'task' && subagents[part.callId] !== undefined) {
        item = { key: part.callId, kind: 'subagent', callId: part.callId,
          summary: part.input && typeof part.input === 'object' && typeof (part.input as Record<string, unknown>).description === 'string'
            ? (part.input as Record<string, unknown>).description as string : undefined,
          state: subagents[part.callId] }
      } else {
        item = { key: part.callId, kind: 'tool', callId: part.callId, name: part.name, input: part.input }
      }
    } else if (part?.type === 'subagent') {
      item = { key: part.callId, kind: 'subagent', callId: part.callId, summary: part.summary, state: subagents[part.callId] }
    } else if (liveBlock?.kind === 'thinking') {
      if (!block.streaming && liveBlock.text.trim() === '') continue
      item = { key, kind: 'thinking', text: liveBlock.text, streaming: block.streaming }
    } else if (liveBlock?.kind === 'tool_use') {
      const liveCallId = liveBlock.callId
      if (liveBlock.name?.toLowerCase() === 'task' && liveCallId !== undefined && subagents[liveCallId] !== undefined) {
        item = { key: liveCallId, kind: 'subagent', callId: liveCallId,
          summary: subagents[liveCallId]?.description, state: subagents[liveCallId] }
      } else {
        item = { key: liveCallId ?? key, kind: 'tool', callId: liveCallId,
          name: liveBlock.name ?? fallbackToolName, input: liveBlock.text }
      }
    } else if (liveBlock?.kind === 'text' && liveBlock.text.trim() === '') {
      continue
    }

    if (item === undefined) {
      segments.push({ kind: 'block', key, block })
    } else {
      const last = segments.at(-1)
      if (last?.kind === 'process') last.items.push(item)
      else segments.push({ kind: 'process', key: `process:${item.key}`, items: [item] })
    }
  }
  return segments
}
