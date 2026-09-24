import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly, visibleText } from '../../../../shared/agent/message'
import { compactBoundaryOf, type CompactBoundary } from '../../../../shared/agent/compaction'
import type { LiveBlock, SubagentState } from '../../../../shared/agent/transcript'
import type { PlanToolReceipt } from '../../../../shared/domain/plan-file'
import type { TimelineItem } from '../../../../shared/domain/tool-timeline'
import { MAX_PARTIAL_JSON_CHARS, parsePartialJson } from './partial-json'
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
   *
   * 需求:压缩边界现在**就住在转录里**(一条 internal user 消息上的
   * `compact_boundary` 块,见 `shared/agent/compaction.ts`),不再来自另一张
   * 检查点表。因此这条线的位置天然正确:删轮 / 编辑重跑把那条消息删掉,线随之消失,
   * 不会再出现「线还在、模型其实拿的是全量」这种零报错的错位。
   */
  | { kind: 'divider'; key: string; boundary: CompactBoundary; messageId: string; foldedCount: number }
  /**
   * 一个后台子代理的结果**回到主线的那一刻**。
   *
   * ★★ 这条消息是 `internal` 的 —— 它发给模型,但以前在界面上**整条不存在**。
   * 于是用户看到的是:主代理毫无来由地开口,讲一件几百轮之前派出去的事,
   * 唯一的线索是滚动区深处那张老卡片上的一行小字。看不见输入的输出,
   * 比看不见输出更难解释。
   *
   * 这一行只占一行的高度(谁、什么时候回来的),全文收在里面,点开才展开 ——
   * 它终究不是用户说的话,不该长得像一条提问。
   */
  /**
   * 一次计划审批**落槌的那一刻**(批准 / 要求修改 / 放弃)。
   *
   * ★★ 这张卡以前不在对话流里,而是渲染在所有回合**之后** —— 于是它永远贴在
   * 整段最底部,紧挨着输入框。批准发生在几十轮之前也一样,看上去像一张关不掉的
   * 常驻卡片,而它其实是一条历史记录。现在它回到产生它的那条工具回执的位置上,
   * 底部随之空出来。
   *
   * 承载它的消息是一条工具回执(界面上不可见),所以这一行和后台汇报一样:
   * 是**一条消息**,不是消息之间的一条线,因此同样要推进 `preceding` ——
   * 否则它前后两个 assistant 行会共用同一个 key。
   */
  | { kind: 'plan-receipt'; key: string; receipt: PlanToolReceipt }
  | {
      kind: 'subagent-report'
      key: string
      message: AgentMessage
      callId: string
      childRunId: string
      summary?: string
    }

/** Tool receipts are invisible boundaries; consecutive model replies form one assistant turn. */
export function threadRows(
  messages: readonly AgentMessage[],
  live: readonly LiveBlock[],
  running: boolean,
  messageRuns: Readonly<Record<string, string>> = {}
): ThreadRow[] {
  const rows: ThreadRow[] = []
  let preceding = 'start'
  let precedingAt: number | undefined
  /*
    ★ **分隔行就落在边界消息所在的位置，必要时把一轮切成两行。**

    这里曾经是反过来的 —— 命中位置先压进一个 `pending`，等到「下一行真正开始」才入列，
    因此一轮永远不会被切断。那条约束在**一轮里有下一条可见消息**时只是「线晚半轮」，
    但工具循环里根本没有那个下一条:一整个会话可以是 1 条提问 + 50 条工具回执，
    它们全部并进同一个 assistant 行，`assistant()` 一直命中复用分支、从不入列，
    于是线一路挂到末尾那次收尾入列 —— 落在 live 块之后，**钉在整段最底部**，
    而且要等用户发下一条消息才归位。又因为 `lastTurnIndex` 会跳过分隔行，
    状态行挂在它前面那个 assistant 行上，观感就是「运行中…」下面压着一条压缩线。

    现在遇到边界消息就直接入列，后续内容另起一个 assistant 行。关键是这**不会**引起
    当初担心的那种重挂:行 key 取创建那一瞬的 `preceding`，而切开前后两行创建时的
    `preceding` 必定不同 —— 两次「新建 assistant 行」之间隔着至少一条可见消息，
    而可见消息一定推进 `preceding`。流式那一行更是从创建到提交都拿同一个
    `preceding`(工具回执不可见、不推进它)，key 全程不变。有用例钉这一点。
  */
  const planRows = latestPlanReceipts(messages)
  const assistant = (): Extract<ThreadRow, { kind: 'assistant' }> => {
    const last = rows.at(-1)
    // 末尾是分隔行时**必须**新建:复用线之前那一行等于把压缩后的内容塞回线上方。
    if (last?.kind === 'assistant') return last
    const row: Extract<ThreadRow, { kind: 'assistant' }> = {
      kind: 'assistant', key: `reply:${preceding}`, blocks: [],
      ...(precedingAt === undefined ? {} : { startedAt: precedingAt })
    }
    rows.push(row)
    return row
  }
  /** 最后一个**回合**行 —— 要不要补空回合看的是它，不是 `rows.at(-1)`。 */
  const lastTurnRow = (): ThreadRow | undefined => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row !== undefined && row.kind !== 'divider') return row
    }
    return undefined
  }

  let visible = 0
  let foldedBase = 0
  for (const message of messages) {
    /*
      ★ 边界消息**先于可见性过滤**结算,并且结算完就 `continue`。

      它是一条 `internal` user 消息(摘要正文住在它的 text 块里),照常走下面的分支
      会被 `shown` 挡掉 —— 那样一条压缩线都画不出来,而且不报错:模型那边确实只拿到了
      边界之后的内容,界面却看不出这里断过。`continue` 是因为它**不是一条消息**,
      是消息之间的一条线:让它推进 `preceding` 或计进 `visible`,折叠计数就会多一条。
    */
    const boundary = compactBoundaryOf(message)
    if (boundary !== undefined) {
      rows.push({
        kind: 'divider', key: `compaction:${message.id}`,
        boundary, messageId: message.id, foldedCount: visible - foldedBase
      })
      foldedBase = visible
      continue
    }
    const shown = message.internal !== true && !isToolResultOnly(message)
    /*
      ★ 后台汇报**是**一条消息,不是消息之间的一条线 —— 所以它和可见消息一样
      推进 `preceding`。不推进的话,它后面那个 assistant 行会和它前面那个
      共用同一个 `reply:${preceding}` key(`assistant()` 只看 `rows.at(-1)`,
      隔着一行就不复用了),两行同 key。分隔线没有这个问题,因为
      「两次新建 assistant 行之间隔着至少一条可见消息」——这一行打破了它。
    */
    const report = shown ? undefined : backgroundReportOf(message)
    if (report !== undefined) {
      rows.push({
        kind: 'subagent-report', key: `report:${message.id}`, message,
        callId: report.callId, childRunId: report.childRunId,
        ...(report.summary === undefined ? {} : { summary: report.summary })
      })
      preceding = message.id
      precedingAt = message.createdAt
      visible += 1
    }
    if (shown) {
      if (message.role === 'user') {
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

    /*
      ★ 计划回执**排在提出它的那条消息之后**:「这是刚才那个计划的下场」,
      所以得在计划正文下面,不是上面。同一个计划只留最后一条 —— 一个计划从
      「要求修改」走到「已批准」会留下两条,两张 220px 的卡片摞在一起说的却是
      同一件事的两个阶段。挑选在 `latestPlanReceipts` 里做完。
    */
    for (const receipt of planRows.get(message.id) ?? []) {
      rows.push({ kind: 'plan-receipt', key: `plan:${receipt.planId}`, receipt })
      preceding = message.id
      precedingAt = message.createdAt
      visible += 1
    }
  }

  /*
    ★ 判断依据是最后一个**回合**行，不是 `rows.at(-1)`。边界消息是整段最后一条时
    (手动压缩)末尾就是分隔行，照旧看 `rows.at(-1)` 会在线**下面**再补一个空回合 ——
    一条压缩线孤零零地夹在两段之间，下面跟着一个什么都没有的回合。
  */
  if (live.length > 0 || lastTurnRow()?.kind !== 'assistant') {
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
  return rows
}

/**
 * 认出一条「后台子代理结果回传」。
 *
 * 标记就是那个 `subagent` part —— 它是一条**只存在于界面这一轨**的通道
 * (两个上游编码器都把它丢掉),所以拿它当标记不会多给模型一个字。
 * 只认 internal 的:助手消息里的 `subagent` part 是卡片,不是汇报。
 */
/**
 * 每个计划最后那条回执落在哪条消息上。返回 `消息 id → 回执`,只含胜出的那些。
 *
 * 回执是工具结果正文的**第一行 JSON**([plan-file.ts](../../../main/kernel/tool/builtin/plan-file.ts))。
 * 别的工具输出压根不是 JSON,`JSON.parse` 抛出来就是「这条不是回执」,不是错误。
 *
 * ★★ **锚在提出计划的那条消息上,不是装着回执的那条。**
 *
 * 看上去后者更直接,但它会**落到整段最底部**,正是这次要修的毛病:点「在当前
 * 会话执行」时,渲染进程当场就 `send('实施已批准的计划。')` 开了新一轮,而主
 * 进程那边计划工具才刚从审批闸门里返回、结果还没写进库。两条消息按落盘先后
 * 排队,新提问常常赢 —— 回执于是排在新一轮**之后**,卡片又贴回了输入框上面。
 *
 * 发起那条消息(带同 `callId` 的 `tool_call`)在用户点批准**之前**就落盘了,
 * 不参与这场竞争。老转录里找不到它时退回装回执的那条 —— 位置不理想,
 * 总比整张卡消失强。
 */
function latestPlanReceipts(
  messages: readonly AgentMessage[]
): Map<string, PlanToolReceipt[]> {
  const ACTIONS = ['approve_current', 'approve_new_session', 'request_revision', 'reject']
  const proposedIn = new Map<string, string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') proposedIn.set(part.callId, message.id)
    }
  }
  const winner = new Map<string, { messageId: string; receipt: PlanToolReceipt }>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_result' || part.isError) continue
      const firstLine = part.output.content.split('\n', 1)[0] ?? ''
      try {
        const value = JSON.parse(firstLine) as Partial<PlanToolReceipt>
        if (value.type !== 'plan_file' || typeof value.planId !== 'string' || typeof value.path !== 'string') continue
        if (!ACTIONS.includes(value.action ?? '')) continue
        const messageId = proposedIn.get(part.callId) ?? message.id
        winner.set(value.planId, { messageId, receipt: value as PlanToolReceipt })
      } catch {
        // Other tool outputs are intentionally not JSON.
      }
    }
  }
  const byMessage = new Map<string, PlanToolReceipt[]>()
  for (const { messageId, receipt } of winner.values()) {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), receipt])
  }
  return byMessage
}

function backgroundReportOf(
  message: AgentMessage
): Extract<ContentPart, { type: 'subagent' }> | undefined {
  if (message.internal !== true) return undefined
  return message.parts.find(
    (part): part is Extract<ContentPart, { type: 'subagent' }> => part.type === 'subagent'
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
 *
 * ★ **还要跳过线上方那个助手行。** 锚点落在一轮内部(工具回执)时,这条线把
 * 一轮切成了两行,提问在**更上面**。两个助手行之间必定隔着一条线 —— 否则它们
 * 早就并成一行了 —— 所以「线的上方是助手行」这一个形状足以认出被切开的同一轮,
 * 不会误跳到上一轮的回答上去。
 */
export function promptOf(rows: readonly ThreadRow[], index: number): TurnPrompt | undefined {
  let cursor = index - 1
  // 计划回执行和压缩线一样会把一轮切成两行,提问在更上面 —— 同一个跳法。
  while (rows[cursor]?.kind === 'divider' || rows[cursor]?.kind === 'plan-receipt') {
    cursor -= 1
    if (rows[cursor]?.kind === 'assistant') cursor -= 1
  }
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

/**
 * 半截入参里的 `description`(`Task` 那句「3-5 个词的说明」)。
 *
 * 流式阶段 live 块里装的是**原始 JSON 前缀字符串**,所以这里先过一遍容错解析;
 * 还没写到 description 就返回 undefined —— 卡片自己有兜底标题,
 * 宁可先显示那句通用的,也不摆一段半个词的说明。
 */
function descriptionOf(source: string): string | undefined {
  const parsed = parsePartialJson(source.slice(0, MAX_PARTIAL_JSON_CHARS))
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const description = (parsed as Record<string, unknown>)['description']
  return typeof description === 'string' && description !== '' ? description : undefined
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
      /*
        需求：`Task` 的参数还在流的那几秒里就用**子代理卡片本体**渲染,而不是
        先画一张通用工具卡、等 `subagent_start` 到了再整个换成另一种卡片 ——
        换的那一下恰好发生在用户盯着看的时刻,而两种卡片高度、图标、布局都不同。
        状态还没有时打上 `pending`:没有这个标记的话卡片会走 `state` 缺省那条路,
        显示成「已完成」(见 `SubagentNode`)。
      */
      if (liveBlock.name?.toLowerCase() === 'task' && liveCallId !== undefined) {
        const state = subagents[liveCallId]
        item = {
          key: liveCallId,
          kind: 'subagent',
          callId: liveCallId,
          summary: state?.description ?? descriptionOf(liveBlock.text),
          ...(state === undefined ? { pending: true } : { state })
        }
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
