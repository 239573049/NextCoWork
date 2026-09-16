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
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Clock3, ListChecks, Pencil, PanelRight, X } from 'lucide-react'
import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { isToolResultOnly } from '../../../../shared/agent/message'
import { formatTokensPerSecond, runDurationOf, tokensPerSecond } from '../../../../shared/agent/duration'
import { formatTokenCount } from '../../../../shared/agent/tokens'
import { formatCostMicros } from '../../../../shared/domain/pricing'
import type { LiveBlock, SubagentState, TranscriptState } from '../../../../shared/agent/transcript'
import { ProviderIcon } from '../../components/brand/ProviderIcon'
import { AgentMarkdown } from '../../components/markdown'
import { Tooltip } from '../../components/ui/Tooltip'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { agentErrorText } from '../../i18n/agent'
import { MessageImage } from './MessageImage'
import { MentionText } from './MentionText'
import { MessageFileRef } from './MessageFileRef'
import { SubagentNode, SubagentReportRow, ThinkingBlock, ToolCallCard } from './parts'
import { useOpenSubagent } from './subagent-open'
import { InteractionPanel } from './InteractionPanel'
import type { PlanToolReceipt } from '../../../../shared/domain/plan-file'
import { readWorkspaceFile } from '../../services/workspace-files'
import { StatusLine } from './StatusLine'
import { ToolTimeline } from './ToolTimeline'
import { reportBackgroundChild, type SendOptions } from '../../stores/session'
import { RunProcessBlock } from './RunProcessBlock'
import { ContextCheckpointPanel } from './ContextCheckpointPanel'
import { CompactionDivider } from './CompactionDivider'
import { assistantSegments, assistantText, isAssistantTextBlock, lastTurnIndex, promptOf, threadRows, unanchoredCheckpoints, type AssistantBlock, type ThreadRow } from './thread-content'
import { TurnActions, type TurnPrompt } from './TurnActions'
import { decideWorkspace, statusOfItem } from '../../../../shared/domain/tool-timeline'

export const Thread = memo(function Thread({
  sessionId,
  transcript,
  runId,
  model,
  providerName,
  lastSeq,
  queued,
  compactError,
  reportOptions,
  onEditMessage,
  onDeleteTurn,
  workspaceId,
  onOpenPlan,
  onExecutePlan,
  readOnly = false
}: {
  sessionId?: string
  transcript: TranscriptState
  runId: string | null
  lastSeq: number
  queued: number
  /**
   * **别人的会话,只能看**(右侧的子代理面板)。关掉一切会写回去的东西:
   * 逐轮的重跑/删除/编辑、审批面板、后台任务中心里那颗「处理」。
   *
   * ★ 状态行**留着** —— 它一个 `<button>` 都没有,而「跑了多久、用了多少 token」
   * 正是打开这个面板的人要看的。
   */
  readOnly?: boolean
  /** 手动压缩的失败原因,由状态行显示。它在 store 里而不在 transcript 里。 */
  compactError?: string | null
  /**
   * 手动回传后台子代理结果时用的档位。
   *
   * ★ 必须由外面传进来:store 里的 `lastOptions` 只在 `send` 里写、不落盘,
   * 重启之后是 null —— 而跨重启正是「处理」这颗按钮唯一还有用的场景。
   */
  reportOptions?: SendOptions
  onEditMessage?: (id: string, text: string, continueRun: boolean) => Promise<void>
  /** 删除一整轮问答。传入的是引出该轮的 user 消息 id。 */
  onDeleteTurn?: (userMessageId: string) => Promise<void>
  workspaceId?: string
  onOpenPlan?: (path: string) => void
  onExecutePlan?: (ref: { planId: string; path: string }, source: 'current_session' | 'new_session') => void
  /** 助手消息上方那行 `供应商 / 模型`(截图:`RoutinAI / claude-fable-5-1`) */
  providerName: string | undefined
  /**
   * 最新一轮抬头显示的模型名 —— **发送那条消息时用户选中的别名**,由
   * `ChatView` 从 `lastOptions.model` 直接读出,不经过任何反查。只对
   * 最后一行成立;更早的历史轮次从 `transcript.runModel` 按各自的
   * `row.runId` 查(见下面的 `turnModel`)。
   */
  model: string | undefined
}): ReactNode {
  const { t } = useI18n()
  const { messages, live, tools, subagents, error, usage, runModel } = transcript
  const running = runId !== null
  const visible = messages.filter((m) => !m.internal && !isToolResultOnly(m))
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
      {/* ★ 审批面板在只读态里必须消失:这个 run 的审批归它的**父**对话管,
          而子代理这条路现在根本不会发起审批(见 `runtime.ts` 的 `approveWith`)。 */}
      {!readOnly && runId !== null && <InteractionPanel key={runId} runId={runId} workspaceId={workspaceId} onOpenPlan={onOpenPlan} onExecute={onExecutePlan} />}
      <StatusLine transcript={transcript} running={running} waitingForResponse={running && needsReply}
        lastSeq={lastSeq} queued={queued} compactError={compactError} />
    </div>
  )

  const rows = threadRows(messages, live, running, transcript.messageRuns, transcript.contextCheckpoints)
  /*
    ★ **不能是「最后一个元素」。** 手动压缩的分隔线就落在整段末尾,那时
    `rows.at(-1)` 是那条线 —— 按下标比的话没有任何一行算末轮,
    `feedback` 整块不渲染,而且全程不报错。
  */
  const lastTurn = lastTurnIndex(rows)
  /*
    ★ 这里**必须 useMemo**:`ContextCheckpointPanel` 内部是
    `useEffect(() => setItems(checkpoints), [checkpoints])`,依赖是数组引用。
    每次渲染喂一个新数组 = 每次渲染都 setState = 渲染死循环。
    (`rows` 反过来**不能**套 useMemo:memo 边界已经挡住了多余渲染,
     套上只会让 chat-view 那条「改草稿不重算」的 spy 断言变成假绿。)
  */
  const orphans = useMemo(
    () => unanchoredCheckpoints(messages, transcript.contextCheckpoints),
    [messages, transcript.contextCheckpoints]
  )

  return (
    <div className="relative min-h-0 flex-1">
    <div ref={viewport} className="scroll-thin fade-top h-full min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" data-testid="thread"
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
        <ContextCheckpointPanel checkpoints={orphans} />
        {rows.map((row, index) => {
          const isLast = index === lastTurn
          if (row.kind === 'divider') {
            return <CompactionDivider key={row.key} checkpoint={row.checkpoint} foldedCount={row.foldedCount} />
          }
          if (row.kind === 'user') {
            return <UserBubble key={row.key} message={row.message} onEdit={readOnly ? undefined : onEditMessage} disabled={running} />
          }
          if (row.kind === 'plan-receipt') {
            // 工作区未知就没法把计划正文读出来 —— 无正文的卡片只剩一句状态,
            // 不如不占这个位置。
            if (workspaceId === undefined) return null
            return <ResolvedPlanCard key={row.key} workspaceId={workspaceId} receipt={row.receipt} onOpenPlan={onOpenPlan} />
          }
          if (row.kind === 'subagent-report') {
            /*
              ★ 卡片状态按 `callId` 查 —— 汇报行自己只带摘要,而「是哪个子代理、
              能不能点开完整记录」都在 `subagents` 里。查不到(老转录)就退化成
              一行没有子代理名的通用文案,仍然比整条消息不存在强。
            */
            return <SubagentReportRow key={row.key} summary={row.summary} state={subagents[row.callId]} />
          }
          return (
            <AssistantTurn
              key={row.key}
              blocks={row.blocks}
              tools={tools}
              subagents={subagents}
              /*
                ★ **按行各取各的,别名版。** 只有最后一行才对得上 `ChatView` 传下来的
                `model`(那是最新一次发送时的选择,存在渲染进程内存里,没跑完也知道 ——
                不必等回包);更早的历史轮次必须查 `transcript.runModel`,否则会像
                修复前那样,所有历史行一起显示"最新一轮"选的模型。
              */
              model={turnModel(row, isLast ? model : undefined, runModel)}
              providerName={providerName}
              runStatus={isLast ? transcript.status : undefined}
              /*
                ★ **run 级的起止只属于最后一轮。** `transcript.runStartedAt` 说的是
                「当前(或刚结束的)那一次 run」,历史回合与它无关。以前无条件优先于
                `row.startedAt` 也看不出问题 —— 用时只在 RunProcessBlock 里显示,
                而那个块只对末轮渲染。一旦把用时铺到每一轮,满屏回合就会显示同一个数字。
                更早的回合只能用自己那段「提问 → 收尾发言」的时间差。
              */
              runStartedAt={isLast ? transcript.runStartedAt ?? row.startedAt : row.startedAt}
              runEndedAt={isLast ? transcript.runEndedAt ?? row.endedAt : row.endedAt}
              feedback={isLast ? feedback : undefined}
              // 助手回合永远紧跟在引出它的提问之后 —— threadRows 会把连续的模型
              // 回复并成一行,所以前一行要么是那条提问,要么(开局补的空回合)什么都没有。
              // 中间可能夹着一条压缩分隔线,`promptOf` 会跳过去。
              prompt={promptOf(rows, index)}
              isLast={isLast}
              running={running}
              /*
                ★ **两个来源,按轮次各取各的。** `transcript.usage` 是**当前**这一次
                run 流式累加出来的,只对最后一轮成立 —— 挂到每一轮上就是把同一个
                数字重复报四遍。更早的回合查 `runUsage`:那是从 `usage_records`
                聚合回来的落盘账,每个 run 一份,所以逐轮显示是准的。

                ★ 顺带这也是「重启后用量消失」的修法:内存里那份随进程一起没了,
                查表这条路不受重启影响。老对话(第 12 条迁移之前)的消息没有 run
                归属,`row.runId` 是 undefined,照旧不显示 —— 宁可不显示,
                也不按时间窗去猜它属于哪个 run。
              */
              usage={turnUsage(row, isLast && runId === null ? usage : undefined, transcript.runUsage)}
              onRegenerate={readOnly || onEditMessage === undefined
                ? undefined
                : (id, text) => onEditMessage(id, text, true)}
              onDeleteTurn={readOnly ? undefined : onDeleteTurn}
              readOnly={readOnly}
            />
          )
        })}
      </div>
    </div>
    <SubagentTaskCenter sessionId={sessionId} subagents={subagents} readOnly={readOnly} reportOptions={reportOptions} />
    </div>
  )
})

function ResolvedPlanCard({ workspaceId, receipt, onOpenPlan }: {
  workspaceId: string
  receipt: PlanToolReceipt
  onOpenPlan?: (path: string) => void
}): ReactNode {
  const { t } = useI18n()
  const [content, setContent] = useState('')
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void readWorkspaceFile(workspaceId, receipt.path).then((file) => {
        if (!cancelled && file.kind === 'text') setContent(file.content)
      }).catch(() => undefined)
    }
    load()
    const changed = (event: Event): void => {
      const detail = (event as CustomEvent<{ workspaceId?: string; path?: string }>).detail
      if (detail?.workspaceId === workspaceId && detail.path === receipt.path) load()
    }
    window.addEventListener('workspace-files-changed', changed)
    return () => { cancelled = true; window.removeEventListener('workspace-files-changed', changed) }
  }, [receipt.path, workspaceId])

  const actionKey = receipt.action === 'approve_current'
    ? 'agent.interaction.planApprovedCurrent'
    : receipt.action === 'approve_new_session'
      ? 'agent.interaction.planApprovedNew'
      : receipt.action === 'request_revision'
        ? 'agent.interaction.planRevisionRequested'
        : 'agent.interaction.planRejected'

  return <section className="rounded-xl border border-border bg-surface p-3" data-testid="plan-file-card">
    <div className="mb-2 flex items-center justify-between gap-3 text-[12px] text-fg-muted">
      <span>{t('agent.interaction.plan')}</span>
      <span>{t(actionKey as 'agent.interaction.planApprovedCurrent')}</span>
    </div>
    <button type="button" onClick={() => onOpenPlan?.(receipt.path)} aria-label={t('agent.interaction.openPlan')}
      className="group relative block h-[220px] w-full overflow-hidden rounded-lg border border-border bg-app p-3 text-left hover:border-accent/50">
      {content === '' ? <span className="text-[12px] text-fg-faint">{receipt.path}</span> : <AgentMarkdown content={content} />}
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-app to-transparent" />
      <span className="absolute right-2 bottom-2 rounded-pill bg-surface-raised px-2 py-1 text-[11px] text-fg-muted shadow-sm group-hover:text-fg">
        {t('agent.interaction.openFullPlan')}
      </span>
    </button>
  </section>
}

function SubagentTaskCenter({ sessionId, subagents, readOnly = false, reportOptions }: { sessionId?: string; subagents: Readonly<Record<string, SubagentState>>; readOnly?: boolean; reportOptions?: SendOptions }): ReactNode {
  const { t } = useI18n()
  const openSubagent = useOpenSubagent()
  const [open, setOpen] = useState(false)
  const entries = Object.values(subagents).filter((item) => item.background === true)
  if (entries.length === 0) return null
  const running = entries.filter((item) => item.status === 'running').length
  /* blocked = 「结果在库里,但当时没有可用的发送档位」。对用户来说它和 pending 是同一件事:等你点一下。 */
  const pending = entries.filter((item) => item.reportStatus === 'pending' || item.reportStatus === 'blocked').length
  /*
    ★ 以前这里是 `scrollIntoView` 跳到那张卡片上 —— 而后台子代理的卡片可能在
    几百轮之前,跳过去之后用户看到的还是那张什么都不说的摘要,得再点开它。
    现在和卡片走同一个动作:直接在右侧开它的完整记录。
    跳不动的(旧转录没有 `childSessionId`)就还是滚过去,聊胜于无。
  */
  const reveal = (item: SubagentState): void => {
    if (item.childSessionId !== undefined && openSubagent !== undefined) {
      openSubagent(item)
      return
    }
    document.querySelector(`[data-subagent-call-id="${CSS.escape(item.callId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
      <button type="button" aria-expanded={open} aria-label={t('chat.subagent.center.open')} onClick={() => setOpen((value) => !value)} className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised/95 px-3 py-1.5 text-[11.5px] text-fg-muted shadow-lg backdrop-blur transition hover:text-fg">
        <PanelRight size={13} />
        <span>{t('chat.subagent.center.title')}</span>
        {running > 0 && <span className="font-mono text-accent">{running}</span>}
        {pending > 0 && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
      {open && <div className="pointer-events-auto w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-card border border-border bg-surface-raised/98 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between border-b border-hairline px-3 py-2.5">
          <div><div className="text-[12px] font-medium text-fg">{t('chat.subagent.center.title')}</div><div className="mt-0.5 text-[10.5px] text-fg-faint">{t('chat.subagent.center.count', { count: entries.length })}</div></div>
          <button type="button" aria-label={t('common.close')} onClick={() => setOpen(false)} className="rounded p-1 text-fg-faint hover:bg-tint-hover hover:text-fg"><X size={13} /></button>
        </div>
        <div className="max-h-[min(52vh,420px)] overflow-y-auto p-1.5">
          {entries.map((item) => {
            const state = item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : (item.reportStatus === 'pending' || item.reportStatus === 'blocked') ? 'pending' : 'done'
            return <div key={item.callId} className="flex w-full items-start gap-2 rounded-[6px] px-2 py-2 text-left transition hover:bg-tint-hover/60">
              {state === 'running' ? <Clock3 size={13} className="mt-0.5 shrink-0 animate-pulse text-accent" /> : state === 'error' ? <CircleAlert size={13} className="mt-0.5 shrink-0 text-danger" /> : state === 'pending' ? <ListChecks size={13} className="mt-0.5 shrink-0 text-accent" /> : <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />}
              <button type="button" onClick={() => reveal(item)} className="min-w-0 flex-1 text-left"><span className="block truncate text-[11.5px] text-fg">{item.description ?? item.summary ?? t('chat.subagent.default')}</span><span className="mt-0.5 block truncate text-[10.5px] text-fg-faint">{item.currentTool ?? (state === 'pending' ? t('chat.subagent.report.pending') : t(`chat.subagent.status.${item.status}` as 'chat.subagent.status.running' | 'chat.subagent.status.done' | 'chat.subagent.status.error' | 'chat.subagent.status.aborted'))}</span></button>
              {!readOnly && state === 'pending' && sessionId !== undefined && <button type="button" onClick={() => void reportBackgroundChild(sessionId, item.callId, reportOptions)} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10">{t('chat.subagent.report.action')}</button>}
            </div>
          })}
        </div>
      </div>}
    </div>
  )
}

/**
 * 这一轮该显示哪份用量。
 *
 * 实时那份优先:当前 run 刚跑完时,它比数据库更全 —— `usage_records` 是按
 * **上游请求**记的,而一轮里最后那次请求的记录与 run 结束几乎同时落盘,
 * 抢在前面读表可能少算一次。历史轮次没有这个问题,直接查表。
 */
function turnUsage(
  row: Extract<ThreadRow, { kind: 'assistant' }>,
  live: TranscriptState['usage'],
  persisted: TranscriptState['runUsage']
): ReactNode {
  const usage = live ?? (row.runId === undefined ? undefined : persisted?.[row.runId])
  return usage === undefined ? undefined : <TaskUsage usage={usage} />
}

/**
 * 这一轮抬头该显示哪个模型别名。
 *
 * 和 `turnUsage` 的口径不同:用量要等 `message_end` 累计,只有 run 彻底
 * 跑完才可信;而"发送时选的模型"在按下发送那一刻就已确定,不必等 run 结束 ——
 * 所以调用方对 `live` 只用 `isLast` 判断,没有 `runId === null` 那道门槛。
 */
function turnModel(
  row: Extract<ThreadRow, { kind: 'assistant' }>,
  live: string | undefined,
  persisted: TranscriptState['runModel']
): string | undefined {
  return live ?? (row.runId === undefined ? undefined : persisted?.[row.runId])
}

function TaskUsage({ usage }: { usage: TranscriptState['usage'] }): ReactNode {
  const { t, locale } = useI18n()
  if (usage === undefined) return null
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreate = usage.cacheCreationInputTokens ?? 0
  const inputTotal = usage.inputTokens + cacheRead + cacheCreate
  const cacheRate = inputTotal > 0 ? cacheRead / inputTotal : 0
  /*
    ★ **不用旁边那个「用时」当分母。** 那是整轮墙钟,里面含工具执行和等授权的
    时间;`upstreamMs` 只累加真正在等模型的那几段,算出来的才是模型的输出速度
    (口径见 `tokensPerSecond`)。

    算不出来就整行不画:老对话没有这个数,一次 token 都没产出的轮次也没有。
    显示「平均 TPS 0.0」会被读成「慢得没边」,而事实是「无从谈起」。
  */
  const tps = tokensPerSecond(usage.outputTokens, usage.upstreamMs)
  /*
    ★ 和 TPS 同一个口径:算不出就整行不画,**不显示 0**。这里的「算不出」有两种,
    都由 `addCost` / `runUsageOf` 归成同一个表示:模型不在价目表,或者这一轮里
    故障切换跨了币种(没有汇率源,加起来是个看着合理的错数)。

    `null` 与 `undefined` 在展示层不必区分 —— 分开是累加那一侧的事,
    它要靠这个区别判断该不该把整轮锁死。
  */
  const cost = usage.cost == null ? undefined : formatCostMicros(usage.cost.micros, usage.cost.currency)
  // 压缩之后原始数字在界面上就没有别处可看了,挂到 title 上留一手
  const exact = (n: number): string => n.toLocaleString(locale)
  return (
    <Tooltip
      className="block"
      content={
        <>
          <div className="mb-1 font-medium">{t('chat.taskUsage')}</div>
          <div title={exact(inputTotal)}>
            {t('chat.taskUsageInput', { count: formatTokenCount(inputTotal) })}
          </div>
          <div title={exact(usage.outputTokens)}>
            {t('chat.taskUsageOutput', { count: formatTokenCount(usage.outputTokens) })}
          </div>
          {cacheRead > 0 && (
            <div title={exact(cacheRead)}>
              {t('chat.taskUsageCacheRead', { count: formatTokenCount(cacheRead) })}
            </div>
          )}
          {cacheCreate > 0 && (
            <div title={exact(cacheCreate)}>
              {t('chat.taskUsageCacheCreate', { count: formatTokenCount(cacheCreate) })}
            </div>
          )}
          <div>{t('chat.taskUsageCacheRate', { rate: `${(cacheRate * 100).toFixed(1)}%` })}</div>
          {tps !== undefined && <div>{t('chat.taskUsageTps', { tps: formatTokensPerSecond(tps) })}</div>}
          {cost !== undefined && <div>{t('chat.taskUsageCost', { amount: cost })}</div>}
        </>
      }
    >
      {/* ★ `tabIndex={0}` 不是多余的:这一整条只有文字、没有可聚焦元素,
          不给的话键盘用户走不到它身上,Tooltip 的 focus 触发也就无从发生。 */}
      <div
        tabIndex={0}
        data-testid="task-usage"
        className="w-fit cursor-help rounded-[4px] text-[11px] text-fg-faint outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {t('chat.taskUsageSummary', {
          input: formatTokenCount(inputTotal),
          output: formatTokenCount(usage.outputTokens)
        })}
        {cost !== undefined && ` · ${cost}`}
      </div>
    </Tooltip>
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
  const fileRefs = message.parts.filter(
    (p): p is Extract<ContentPart, { type: 'file_ref' }> => p.type === 'file_ref'
  )

  // 文本、图片、文件引用都没有才是真的空
  if (text === '' && images.length === 0 && fileRefs.length === 0) return null

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
          /*
            ★ 用 `MentionText` 而不是直接铺 `{text}`:输入框里 `@` 选出来的
            文件在草稿里是一段 markdown 链接,它在气泡里也得是同一个 chip ——
            否则发送那一下,用户眼里的 chip 会「变回」一串方括号,
            看起来像是发错了(而其实发出去的一直是同一个字符串)。

            ★ `break-words`:`whitespace-pre-wrap` 只在空白处断行,一段没有空格的
            长串(粘进来的 SQL、URL、base64)会整条冲出气泡右边被切掉。输入框
            (`MentionInput`)本来就带 `break-words`,这里不带的话,同一段文字在
            草稿里好好的、一发出去就断头 —— 又是那种「像是发错了」的错觉。
          */
          <p className="selectable text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">
            <MentionText text={text} />
          </p>
        )}
        {fileRefs.length > 0 && (
          <div className={cn('flex flex-col gap-1', text !== '' && 'mt-2')}>
            {fileRefs.map((f, i) => (
              <MessageFileRef key={`${f.path}:${String(i)}`} name={f.name} path={f.path} />
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', (text !== '' || fileRefs.length > 0) && 'mt-2')}>
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
  feedback,
  prompt,
  isLast,
  running,
  usage,
  onRegenerate,
  onDeleteTurn,
  readOnly
}: {
  blocks: readonly AssistantBlock[]
  tools: TranscriptState['tools']
  subagents: TranscriptState['subagents']
  model: string | undefined
  providerName: string | undefined
  runStatus: TranscriptState['status'] | undefined
  runStartedAt?: number
  runEndedAt?: number
  feedback?: ReactNode
  prompt?: TurnPrompt
  isLast: boolean
  running: boolean
  usage?: ReactNode
  onRegenerate?: (id: string, text: string) => Promise<void>
  onDeleteTurn?: (userMessageId: string) => Promise<void>
  readOnly: boolean
}): ReactNode {
  const { t } = useI18n()
  const [lastKnownStatus, setLastKnownStatus] = useState(runStatus ?? 'done')
  if (runStatus !== undefined && runStatus !== lastKnownStatus) setLastKnownStatus(runStatus)
  const segments = assistantSegments(blocks, t('chat.tool.name'), subagents)
  const lastProcessIndex = segments.reduce((last, segment, index) => segment.kind === 'process' ? index : last, -1)
  const processSegments = lastProcessIndex < 0 ? [] : segments.slice(0, lastProcessIndex + 1)
  const trailingSegments = lastProcessIndex < 0 ? segments : segments.slice(lastProcessIndex + 1)
  const processItems = processSegments.flatMap((segment) => segment.kind === 'process' ? segment.items : [])
  const errorCount = processItems.filter((item) => statusOfItem(item, tools) === 'error').length
  const hasRunningSubagent = processItems.some((item) => item.kind === 'subagent' && item.state?.status === 'running')
  const hasTrailingText = trailingSegments.some((segment) => segment.kind === 'block' && isAssistantTextBlock(segment.block))
  const outcome = lastKnownStatus === 'done' ? 'ok' : lastKnownStatus
  const decision = !hasRunningSubagent
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
    <div className="group/turn flex flex-col gap-2.5" data-testid="assistant-turn">
      <TurnHeader model={model} providerName={providerName} />
      {body}
      {/*
        操作条要等这一轮跑完再出现。流式过程中「复制」拿到的是半句话,
        「重新生成」更是要先中断当前 run —— 那是另一件事,输入框旁边的停止键管它。
      */}
      {/*
        ★ 只读态整条操作栏不出现 —— 不是「把重跑和删除禁掉」,是**一个按钮都不留**。
        复制和导出本身无害,但参考形态是「标题 + 正文」;留两颗按钮在那儿,
        这个面板就又变回了一个半能用的对话界面。用时与用量在顶上的身份栏里。
      */}
      {!readOnly && !(isLast && running) && (
        <TurnActions
          text={assistantText(blocks)}
          prompt={prompt}
          alwaysVisible={isLast}
          disabled={running}
          durationMs={durationMs}
          usage={usage}
          onRegenerate={onRegenerate}
          onDelete={onDeleteTurn}
        />
      )}
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
    // 只出现在用户消息里(ChatView 的 partsOf),渲染由 UserBubble 负责
    case 'file_ref':
      return null
    case 'error':
      return (
        <p className="selectable font-mono text-[12.5px] text-danger">
          {part.error.code}: {agentErrorText(part.error, t)}
        </p>
      )
  }
}
