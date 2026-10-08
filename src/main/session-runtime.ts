/**
 * 会话运行时 —— 「这条会话下一轮什么时候开跑」的**唯一**决定者。
 *
 * 需求:Agent 在主进程跑,而「排队消息续跑」「后台子代理把结果交回主代理」
 * 「目标空闲时的检查」原先都要靠渲染层收到 `run_end` 之后再调一次 `send()`。
 * 没有窗口在看这条会话(切走了、最小化了、窗口重载到一半)时,这三件事就
 * 一件也不会发生 —— 而为了让它们发生,渲染层又不得不一直订阅着每个会话的
 * 全部正文。所以这三件事收到这里:主进程自己决定,渲染层只负责显示。
 *
 * 不满足会怎样:用户排了三条消息就去开会,回来发现第一轮跑完之后什么都没再发生;
 * 或者渲染层为了不漏掉 `run_end`,把每个开过的会话的全部转录都留在内存里。
 *
 * ## 三条不变式
 *
 * 1. **一条会话同一时刻只有一个 run。** 续跑必须等到上一个 run 的 driver
 *    `finally` 跑完(收尾落盘、释放会话互斥)才开始 —— `run_end` 事件**不是**
 *    这个时刻,它比收尾早(见 `RunRegistry.retainSessionForRun`)。所以入口是
 *    `runSettled`,由 `ipc/agent.ts` 在释放互斥之后调用,而不是监听 `run_end`。
 * 2. **只有正常结束才自动续跑。** `aborted` 是用户按了停止,`error` 自动续跑
 *    往往连着错 N 次、烧 N 轮 token。队列原样留着,等用户点「继续」。
 * 3. **冷启动不自动执行。** 进程刚起来时从 kv 读回的队列,只有在用户的下一个
 *    动作(发消息、插话、继续)之后才会动。
 *
 * ★ 本文件零 electron import,依赖全部注入 —— 无头测试直接驱动它。
 */
import type { AgentEvent, RunStatus } from '../shared/agent/event'
import type { ContentPart } from '../shared/agent/message'
import type { InterjectItem } from '../shared/agent/interject'
import type { RunRequest, SendOptions } from '../shared/agent/run-request'
import {
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_TEXT,
  SESSION_INPUT_VERSION,
  batchToParts,
  isLive,
  makeQueuedInput,
  mergeBatch,
  pickNextBatch,
  type QueuedInput,
  type SessionInputState,
  type SessionQueueOp,
  type SessionQueueResult,
  type SessionQueueSnapshot,
  type SubagentReportStatus
} from '../shared/domain/queued-input'

/** 运行时只用到 `RunHandle` 的这一小块 —— 测试拿假对象就能驱动。 */
export interface SessionRunHandle {
  readonly runId: string
  readonly sessionId: string
  readonly depth: number
  readonly status: RunStatus
  readonly signal: AbortSignal
  on(listener: (event: AgentEvent, seq: number) => void): () => void
  setInterject(items: readonly InterjectItem[]): void
  enqueueInternal(item: InterjectItem): void
}

/** 一个后台子代理交回来的东西。 */
export interface BackgroundReport {
  /** 父会话 */
  sessionId: string
  callId: string
  childRunId: string
  subagentType?: string
  /** 子代理最后一条助手消息的**全文**;取不到时为空串 */
  text: string
  /** 卡片上那截预览(前 240 字)。只挂在界面那一轨的 part 上 */
  summary?: string
}

export interface SessionRuntimeDeps {
  now(): number
  newId(): string
  readInput(sessionId: string): SessionInputState | null
  writeInput(sessionId: string, state: SessionInputState): void
  /** 这条会话此刻正在跑的**顶层** run */
  activeRun(sessionId: string): SessionRunHandle | undefined
  /** 有 run 或历史操作占着这条会话 —— 包括 `run_end` 之后、收尾落盘之前那一段 */
  isBusy(sessionId: string): boolean
  /** 启动一个不绑定任何窗口的顶层 run。被拒绝(会话忙、需要更新、目标已失效)时抛错 */
  launch(req: RunRequest): void
  emitQueue(snapshot: SessionQueueSnapshot): void
  emitReport(sessionId: string, callId: string, status: SubagentReportStatus): void
  /** 从库里的 Task 回执恢复一个子代理的交付物 —— 重启之后的手动汇报走这条 */
  readReport(sessionId: string, callId: string): (BackgroundReport & { reportStatus?: SubagentReportStatus }) | undefined
  persistReportStatus(sessionId: string, callId: string, status: SubagentReportStatus): void
  log(message: string, error?: unknown): void
}

/** 草稿按键级频率变化,走防抖;队列的增删改是离散动作,立即落盘。 */
export const DRAFT_DEBOUNCE_MS = 500
/** 会话被历史操作(手动压缩等)占着时,内部输入隔多久再试一次 */
export const DEFERRED_RETRY_MS = 1000
/** 最多重试多少次 —— 一个永远不释放的互斥不该让定时器永远转下去 */
export const DEFERRED_MAX_RETRIES = 120
/** 记住多少条会话的「上一次发送档位」。只有几百字节一条,但不该无界 */
export const LAST_OPTIONS_MAX = 256

const NO_SUMMARY = 'The background subagent finished without a summary.'

interface Entry {
  draft: string
  queued: QueuedInput[]
  timer: ReturnType<typeof setTimeout> | null
}

/** 一条等会话空出来再投递的内部输入(后台汇报、目标检查)。 */
interface DeferredInput {
  parts: ContentPart[]
  options: SendOptions
  goalId?: string
  done?: (ok: boolean) => void
}

type Delivery = 'interjected' | 'launched' | 'deferred' | 'failed'

export class SessionRuntime {
  private readonly entries = new Map<string, Entry>()
  private readonly lastOptions = new Map<string, SendOptions>()
  private readonly deferred = new Map<string, DeferredInput[]>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** 本进程里已经开始汇报的 `会话 + callId`。持久化的 reportStatus 管跨重启,这里管并发 */
  private readonly reporting = new Set<string>()
  /**
   * ★ 全局单调递增,而不是每会话各数各的:会话条目在空了之后会被丢掉,
   * 重新建出来时每会话计数会回到 0,渲染层就会把新快照当成旧的丢掉。
   */
  private rev = 0

  constructor(private readonly deps: SessionRuntimeDeps) {}

  // ═══════════════════════════════════════════════════════════════
  // 草稿与队列的持久化
  // ═══════════════════════════════════════════════════════════════

  /** 读回未发出的输入。没有可恢复的内容时返回 null(与旧的 `session:getInput` 同义) */
  getInput(sessionId: string): SessionInputState | null {
    const entry = this.load(sessionId)
    if (entry.draft === '' && entry.queued.length === 0) {
      this.evictIfIdle(sessionId, entry)
      return null
    }
    return this.stateOf(entry)
  }

  /**
   * 草稿由渲染层编辑,这里只负责落盘。
   *
   * ★ 草稿和队列落在**同一个 kv 键**里,所以每一次写都要写「当前的整份」:
   * 渲染层整份覆盖的话,一次迟到的草稿防抖会把主进程刚刚消费掉的队列写回去,
   * 同一条消息于是被续跑两次。
   */
  setDraft(sessionId: string, draft: string, immediate: boolean): void {
    const entry = this.load(sessionId)
    entry.draft = draft
    if (immediate) {
      this.write(sessionId, entry)
      return
    }
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.write(sessionId, entry)
    }, DRAFT_DEBOUNCE_MS)
  }

  /** 退出、整库替换之前:把还挂在防抖里的草稿写掉,而不是丢掉。 */
  flush(): void {
    for (const [sessionId, entry] of [...this.entries]) {
      if (entry.timer === null) continue
      clearTimeout(entry.timer)
      entry.timer = null
      this.write(sessionId, entry)
    }
  }

  /** 数据库整个换掉之后:内存里那份是旧库的,丢掉重读。不写回。 */
  reset(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
    }
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.entries.clear()
    this.deferred.clear()
    this.retries.clear()
    this.reporting.clear()
    this.lastOptions.clear()
  }

  // ═══════════════════════════════════════════════════════════════
  // 队列
  // ═══════════════════════════════════════════════════════════════

  queue(sessionId: string, op: SessionQueueOp): SessionQueueResult {
    const entry = this.load(sessionId)
    switch (op.kind) {
      case 'enqueue': {
        // ★ 软上限:超过就不是队列了,是便签本。**拒绝入队**,由调用方保留草稿 ——
        // 静默丢弃会让用户以为消息进了队列。
        if (entry.queued.length >= QUEUE_MAX_ITEMS) return { ...this.snapshot(sessionId, entry), accepted: false }
        entry.queued = [
          ...entry.queued,
          makeQueuedInput(this.deps.newId(), op.text.slice(0, QUEUE_MAX_TEXT), op.options, this.deps.now(), op.attachments)
        ]
        const result = this.commit(sessionId, entry)
        // 渲染层以为还在跑,其实那一轮已经收尾了 —— 这时入队就等于「接着发」。
        if (this.deps.activeRun(sessionId) === undefined) this.drain(sessionId)
        return result
      }
      case 'promote': {
        const item = entry.queued.find((q) => q.id === op.id)
        if (item === undefined) return { ...this.snapshot(sessionId, entry), accepted: false }
        /*
          ★ 不能直接用 now:毫秒分辨率下两次点击可能同值,而排序的正确性不该依赖
          「两次点击不会落在同一毫秒」。取 max(now, 已有最大值 + 1) 保证严格单调。
          ★ 取消引入时清掉 promotedAt:再次引入应当排到已引入者的队尾。
        */
        const maxAt = entry.queued.reduce((m, q) => Math.max(m, q.promotedAt ?? 0), 0)
        const at = Math.max(this.deps.now(), maxAt + 1)
        entry.queued = entry.queued.map((q) => q.id !== op.id
          ? q
          : q.status === 'promoted'
            ? { ...withoutPromotedAt(q), status: 'pending' as const }
            : { ...q, status: 'promoted' as const, promotedAt: at })
        const result = this.commit(sessionId, entry)
        // 空闲态被点插话 = 立即发送;运行中才是插话的正题,推给 run 的信箱
        if (this.deps.activeRun(sessionId) === undefined) this.drain(sessionId)
        else this.syncInterject(sessionId)
        return result
      }
      case 'edit': {
        // ★ 不动档位快照,也不动 promotedAt —— 编辑不改变加塞顺序
        entry.queued = entry.queued.map((q) => q.id === op.id ? { ...q, text: op.text.slice(0, QUEUE_MAX_TEXT) } : q)
        const result = this.commit(sessionId, entry)
        // run 信箱里存的是旧文本,必须重发覆盖
        this.syncInterject(sessionId)
        return result
      }
      case 'drop': {
        entry.queued = entry.queued.filter((q) => q.id !== op.id)
        const result = this.commit(sessionId, entry)
        this.syncInterject(sessionId)
        return result
      }
      case 'take': {
        const item = entry.queued.find((q) => q.id === op.id)
        if (item === undefined) return { ...this.snapshot(sessionId, entry), accepted: false }
        entry.queued = entry.queued.filter((q) => q.id !== op.id)
        const result = this.commit(sessionId, entry)
        this.syncInterject(sessionId)
        return { ...result, text: item.text }
      }
      case 'retagPermission': {
        entry.queued = entry.queued.map((q) => q.options.permissionMode === op.mode
          ? q
          : { ...q, options: { ...q.options, permissionMode: op.mode } })
        return this.commit(sessionId, entry)
      }
      case 'retagMode': {
        entry.queued = entry.queued.map((q) => q.options.mode === op.mode
          ? q
          : { ...q, options: { ...q.options, mode: op.mode } })
        return this.commit(sessionId, entry)
      }
      case 'resume': {
        this.drain(sessionId)
        return { ...this.snapshot(sessionId, this.load(sessionId)), accepted: true }
      }
    }
  }

  /**
   * run 结束后发出排队的下一批。返回是否真的起了一个新 run。
   *
   * ★ **先确认档位在,再动队列。** 反过来的话,没有档位时条目已经被移出队列,
   * 那几句话就凭空消失了。启动失败同样把条目放回队首。
   */
  private drain(sessionId: string): boolean {
    if (this.deps.isBusy(sessionId)) return false
    const entry = this.load(sessionId)
    const batch = pickNextBatch(entry.queued)
    if (batch.length === 0) {
      this.evictIfIdle(sessionId, entry)
      return false
    }
    // ★ 档位取**最早被引入**那条的快照:用户按他当时看到的设置写下这句话。
    const options = batch[0]?.options ?? this.lastOptions.get(sessionId)
    if (options === undefined) return false

    const merged = mergeBatch(batch)
    // 超限被排除的条目退回 pending —— 留在 promoted 会让下一轮又把它们排到最前
    const deferredIds = new Set(merged.deferredIds)
    const sent = batch.filter((q) => !deferredIds.has(q.id))
    const sentIds = new Set(sent.map((q) => q.id))
    const before = entry.queued
    entry.queued = before
      .filter((q) => !sentIds.has(q.id))
      .map((q) => deferredIds.has(q.id) ? { ...withoutPromotedAt(q), status: 'pending' as const } : q)
    this.commit(sessionId, entry)

    try {
      this.deps.launch({
        ...options,
        runId: this.deps.newId(),
        sessionId,
        input: batchToParts(merged),
        inputMessageId: this.deps.newId()
      })
      return true
    } catch (error) {
      this.deps.log(`[session] queued input could not start: ${sessionId}`, error)
      // 没发出去就原样放回 —— 宁可多等一轮,也不能让用户排的话消失
      entry.queued = [...sent, ...entry.queued.filter((q) => !sentIds.has(q.id))]
      this.commit(sessionId, entry)
      return false
    }
  }

  /**
   * 把当前全部 promoted 条目推给正在跑的 run,由它在下一个轮次边界注入。
   *
   * ★ 全量替换:取消引入就是重发一份不含它的全集(空数组也有意义)。
   * ★ 只推 promoted,pending 一条都不捎带 —— 否则任何人排队都会打断当前执行。
   */
  private syncInterject(sessionId: string): void {
    const active = this.deps.activeRun(sessionId)
    if (active === undefined) return
    const entry = this.load(sessionId)
    const items = pickNextBatch(entry.queued)
      .filter((q) => q.status === 'promoted')
      .map((q) => ({ id: q.id, parts: batchToParts(mergeBatch([q])) }))
      .filter((item) => item.parts.length > 0)
    active.setInterject(items)
  }

  /**
   * run 把插话注入成用户消息时复用了条目 id,所以一条同 id 的 `message_commit`
   * 就是「已送达」的回执 —— 这时才移出队列,run 半路挂了消息也不会丢。
   */
  private reapCommitted(sessionId: string, messageId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || !entry.queued.some((q) => q.id === messageId)) return
    entry.queued = entry.queued.filter((q) => q.id !== messageId)
    this.commit(sessionId, entry)
  }

  // ═══════════════════════════════════════════════════════════════
  // run 生命周期
  // ═══════════════════════════════════════════════════════════════

  /** 每个 run 启动时调用(`ipc/agent.ts` 的 `launch`)。只关心顶层 run。 */
  runStarted(handle: SessionRunHandle, req: RunRequest): void {
    if (handle.depth !== 0) return
    this.rememberOptions(req.sessionId, optionsOf(req))
    handle.on((event) => {
      if (event.type === 'message_commit' && event.message.role === 'user') {
        this.reapCommitted(handle.sessionId, event.message.id)
      }
    })
  }

  /**
   * driver 的 `finally` 跑完、会话互斥已经释放之后调用。
   *
   * 等着投递的内部输入(后台汇报、目标检查)先走;它起了新 run 的话,
   * 排队的用户消息留给**那个** run 收尾时再续。
   */
  runSettled(handle: SessionRunHandle): void {
    if (handle.depth !== 0) return
    if (this.flushDeferred(handle.sessionId)) return
    if (handle.status === 'done') this.drain(handle.sessionId)
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部输入:目标检查、后台子代理汇报
  // ═══════════════════════════════════════════════════════════════

  /**
   * 目标空闲检查。返回 false = 这次没送出去(目标已经换了、需要先装更新),
   * 由目标运行时按它自己的退避再试。
   */
  wakeGoal(sessionId: string, parts: ContentPart[], options: SendOptions, goalId: string): boolean {
    return this.deliverInternal(sessionId, { parts, options, goalId }) !== 'failed'
  }

  /**
   * 后台子代理跑完。`aborted` 不自动汇报:那基本是用户按了停止(级联到子代理)
   * 或者应用在退出 —— 此时自动开一轮新的对话,正好违背了「停下」这个意图。
   * 回执停在 pending,由用户自己点「处理」。
   */
  childFinished(report: BackgroundReport, status: RunStatus): void {
    if (status === 'aborted') {
      this.deps.emitReport(report.sessionId, report.callId, 'pending')
      return
    }
    this.report(report)
  }

  /**
   * 用户在卡片上点「处理」—— 重启之后、或者自动那一趟被挡住(blocked)之后。
   * `fallback` 是渲染层按工作区默认值拼的档位:本进程没见过这条会话发消息时,
   * 汇报靠它才发得出去。
   */
  reportManually(sessionId: string, callId: string, fallback?: SendOptions): SubagentReportStatus {
    const receipt = this.deps.readReport(sessionId, callId)
    if (receipt === undefined) return 'none'
    const status = receipt.reportStatus ?? 'pending'
    if (status !== 'pending' && status !== 'blocked') return status
    return this.report(receipt, fallback)
  }

  private report(report: BackgroundReport, fallback?: SendOptions): SubagentReportStatus {
    const key = `${report.sessionId}\u0000${report.callId}`
    if (this.reporting.has(key)) return 'injecting'
    const options = this.lastOptions.get(report.sessionId) ?? fallback
    /*
      ★ 连档位都没有时置 blocked,而**不是**静默 return:界面上那颗「处理」按钮
      和「结果待汇报给主代理」都还在,一个按下去什么都不发生的按钮不是诚实的界面。
    */
    if (options === undefined) {
      this.setReportStatus(report.sessionId, report.callId, 'blocked')
      return 'blocked'
    }
    this.reporting.add(key)
    this.setReportStatus(report.sessionId, report.callId, 'injecting')
    /*
      ★★ 发给主代理的是**全文**,不是卡片上那截 240 字的摘要。拿摘要当正文的话,
      一份「改了八个文件、逐条说明」的报告到主代理手上只剩开头一句 —— 不报错,只是做错。
      取不到全文才退回摘要:残缺的汇报也好过没有汇报。
    */
    const body = report.text.trim() !== '' ? report.text.trim() : report.summary ?? NO_SUMMARY
    const parts: ContentPart[] = [
      {
        type: 'text',
        text: `Background subagent result (${report.subagentType ?? 'subagent'}, ${report.childRunId}):\n\n${body}\n\nReview this result and continue the conversation if action is needed.`
      },
      /*
        ★ 第二个 part 只给界面看(两个编码器都丢弃它):让这条 internal 消息被认成
        「某个后台子代理的结果回传」,画一行可展开的汇报行。挂短摘要,不挂全文 ——
        全文已经在 text part 里落盘了,再存一份就是同一段话出现两次。
      */
      { type: 'subagent', callId: report.callId, childRunId: report.childRunId,
        ...(report.summary === undefined ? {} : { summary: report.summary }) }
    ]
    let outcome: SubagentReportStatus = 'injecting'
    this.deliverInternal(report.sessionId, {
      parts,
      options,
      done: (ok) => {
        // 持久化的回执管跨重启的「只汇报一次」;这里只挡本进程里的并发
        this.reporting.delete(key)
        outcome = ok ? 'reported' : 'pending'
        this.setReportStatus(report.sessionId, report.callId, outcome)
      }
    })
    return outcome
  }

  private setReportStatus(sessionId: string, callId: string, status: SubagentReportStatus): void {
    try {
      this.deps.persistReportStatus(sessionId, callId, status)
    } catch (error) {
      this.deps.log(`[session] could not persist report status: ${sessionId}`, error)
    }
    this.deps.emitReport(sessionId, callId, status)
  }

  /**
   * 投递一条内部输入:run 在跑就进它的信箱,会话正在收尾就排到收尾之后,
   * 空闲就开一个新 run。
   */
  private deliverInternal(sessionId: string, input: DeferredInput): Delivery {
    const active = this.deps.activeRun(sessionId)
    if (active !== undefined && active.status === 'running' && !active.signal.aborted) {
      active.enqueueInternal({
        id: this.deps.newId(),
        parts: input.parts,
        internal: true,
        ...(input.goalId === undefined ? {} : { goalId: input.goalId })
      })
      input.done?.(true)
      return 'interjected'
    }
    if (this.deps.isBusy(sessionId)) {
      const list = this.deferred.get(sessionId) ?? []
      list.push(input)
      this.deferred.set(sessionId, list)
      this.scheduleRetry(sessionId)
      return 'deferred'
    }
    return this.launchInternal(sessionId, input) ? 'launched' : 'failed'
  }

  private launchInternal(sessionId: string, input: DeferredInput): boolean {
    try {
      this.deps.launch({
        ...input.options,
        runId: this.deps.newId(),
        sessionId,
        input: input.parts,
        inputMessageId: this.deps.newId(),
        inputInternal: true,
        ...(input.goalId === undefined ? {} : { inputGoalId: input.goalId })
      })
      input.done?.(true)
      return true
    } catch (error) {
      this.deps.log(`[session] internal input could not start: ${sessionId}`, error)
      input.done?.(false)
      return false
    }
  }

  /** 会话空出来了:投递第一条等着的内部输入。起了新 run 返回 true */
  private flushDeferred(sessionId: string): boolean {
    const list = this.deferred.get(sessionId)
    if (list === undefined || list.length === 0) return false
    if (this.deps.isBusy(sessionId)) {
      this.scheduleRetry(sessionId)
      return false
    }
    this.clearRetry(sessionId)
    while (list.length > 0) {
      const next = list.shift()
      if (next === undefined) break
      const result = this.deliverInternal(sessionId, next)
      if (result === 'launched') {
        // 剩下的留给这个新 run:它在跑时投递会进它的信箱,收尾后再从这里继续
        if (list.length === 0) this.deferred.delete(sessionId)
        else this.scheduleRetry(sessionId)
        return true
      }
      if (result === 'deferred') return false
    }
    this.deferred.delete(sessionId)
    return false
  }

  /**
   * 历史操作(手动压缩)占着会话时不会有 `runSettled` 来叫醒等着的输入,
   * 所以另挂一个有上限的重试。
   */
  private scheduleRetry(sessionId: string): void {
    if (this.retries.has(sessionId)) return
    const tick = (attempt: number): void => {
      const timer = setTimeout(() => {
        this.retries.delete(sessionId)
        const list = this.deferred.get(sessionId)
        if (list === undefined || list.length === 0) return
        if (!this.deps.isBusy(sessionId)) {
          this.flushDeferred(sessionId)
          return
        }
        if (this.deps.activeRun(sessionId) !== undefined) {
          // run 在跑:把等着的输入直接塞进它的信箱
          this.flushIntoActive(sessionId)
          return
        }
        if (attempt + 1 >= DEFERRED_MAX_RETRIES) {
          this.deps.log(`[session] gave up delivering internal input: ${sessionId}`)
          this.deferred.delete(sessionId)
          for (const item of list) item.done?.(false)
          return
        }
        tick(attempt + 1)
      }, DEFERRED_RETRY_MS)
      ;(timer as { unref?: () => void }).unref?.()
      this.retries.set(sessionId, timer)
    }
    tick(0)
  }

  private flushIntoActive(sessionId: string): void {
    const list = this.deferred.get(sessionId) ?? []
    this.deferred.delete(sessionId)
    for (const item of list) this.deliverInternal(sessionId, item)
  }

  private clearRetry(sessionId: string): void {
    const timer = this.retries.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.retries.delete(sessionId)
  }

  private rememberOptions(sessionId: string, options: SendOptions): void {
    this.lastOptions.delete(sessionId)
    this.lastOptions.set(sessionId, options)
    if (this.lastOptions.size <= LAST_OPTIONS_MAX) return
    const oldest = this.lastOptions.keys().next().value
    if (oldest !== undefined) this.lastOptions.delete(oldest)
  }

  // ═══════════════════════════════════════════════════════════════
  // 条目
  // ═══════════════════════════════════════════════════════════════

  private load(sessionId: string): Entry {
    const existing = this.entries.get(sessionId)
    if (existing !== undefined) return existing
    const saved = this.deps.readInput(sessionId)
    const entry: Entry = {
      draft: saved?.draft ?? '',
      queued: (saved?.queued ?? []).filter(isLive),
      timer: null
    }
    this.entries.set(sessionId, entry)
    return entry
  }

  private stateOf(entry: Entry): SessionInputState {
    return { v: SESSION_INPUT_VERSION, draft: entry.draft, queued: entry.queued.filter(isLive), savedAt: this.deps.now() }
  }

  private snapshot(sessionId: string, entry: Entry): SessionQueueSnapshot {
    return { sessionId, queued: entry.queued.filter(isLive), rev: this.rev }
  }

  /** 队列变了:立即落盘、广播,返回带新 rev 的回执。 */
  private commit(sessionId: string, entry: Entry): SessionQueueResult {
    this.rev += 1
    const snapshot = { sessionId, queued: entry.queued.filter(isLive), rev: this.rev }
    this.write(sessionId, entry)
    this.deps.emitQueue(snapshot)
    return { ...snapshot, accepted: true }
  }

  private write(sessionId: string, entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    try {
      this.deps.writeInput(sessionId, this.stateOf(entry))
    } catch (error) {
      this.deps.log(`[session] could not persist input: ${sessionId}`, error)
    }
    this.evictIfIdle(sessionId, entry)
  }

  /** 空条目不常驻:开过几百个会话,这张表也只留着真有未发输入的那几个。 */
  private evictIfIdle(sessionId: string, entry: Entry): void {
    if (entry.timer === null && entry.draft === '' && entry.queued.length === 0) this.entries.delete(sessionId)
  }
}

function withoutPromotedAt(q: QueuedInput): QueuedInput {
  const { promotedAt: _promotedAt, ...rest } = q
  return rest
}

/**
 * 一次 run 的请求 → 下一次可以复用的档位。
 *
 * ★ 去掉 `planExecution` 与 `agentType`:前者是「这一轮执行哪份已批准的计划」,
 * 复用到一次后台汇报上就是把同一份计划再执行一遍;后者只属于子代理。
 */
function optionsOf(req: RunRequest): SendOptions {
  const {
    runId: _runId, sessionId: _sessionId, input: _input, inputMessageId: _inputMessageId,
    inputInternal: _inputInternal, inputGoalId: _inputGoalId, planExecution: _planExecution,
    agentType: _agentType, ...options
  } = req
  return options
}
