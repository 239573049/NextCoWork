/**
 * RunRegistry —— 方案 §4.7:用它,而不是用 AsyncIterable 做事实来源。
 *
 * `AgentSession.run(): AsyncIterable<AgentEvent>` 写起来漂亮,但在 IPC 边界上是陷阱:
 *
 * 1. **异步迭代器只能被订阅一次** —— 主窗 + 快捷小窗看同一个 run 就没救了;
 * 2. **无法重放** —— 渲染层重载,run 还在主进程好好跑着(这正是主进程内核的全部意义),
 *    但 UI 失忆了;
 * 3. **背压反转** —— `webContents.send` 是 fire-and-forget 且无界的,
 *    生成器的背压作用于空气。
 *
 * ★ 本文件**零 electron import**。合批与推送是 `src/main/ipc/agent.ts` 的事,
 * 这里只管「事件发生了」。
 */
import type { AgentError } from '../../shared/agent/error'
import type { AgentEvent, RunSnapshot, RunStatus } from '../../shared/agent/event'
import type { PendingInteraction } from '../../shared/agent/interaction'
import type { RunRequest } from '../../shared/agent/run-request'

export type RunListener = (event: AgentEvent, seq: number) => void
export type Unsubscribe = () => void

/** 日志条目带自己的 seq —— 裁剪之后 seq 与下标不再一一对应(见 trim 的注释) */
interface LogEntry {
  seq: number
  event: AgentEvent
}

/**
 * 硬上限,兜底用。正常情况下 trim 会在每个 message_commit 处把日志压得远小于它;
 * 这个数只防「一个 run 跑了一万轮工具却一条消息都没提交」的极端情况。
 */
const MAX_LOG_ENTRIES = 2000

export interface AbortReason {
  /** 'user' = 点了停止;'parent' = 父 run 级联下来;'shutdown' = app 退出 */
  by: 'user' | 'parent' | 'shutdown'
}

export class RunHandle {
  readonly runId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly parentRunId: string | undefined
  readonly depth: number

  status: RunStatus = 'running'
  /** 已分配的最后一个 seq。**永远单调递增**,不受裁剪影响 */
  seq = 0

  readonly pendingInteractions: PendingInteraction[] = []
  readonly children = new Set<string>()

  private readonly log: LogEntry[] = []
  private readonly listeners = new Set<RunListener>()
  private readonly controller = new AbortController()

  constructor(req: RunRequest) {
    this.runId = req.runId
    this.sessionId = req.sessionId
    this.workspaceId = req.workspaceId
    this.parentRunId = req.parentRunId
    this.depth = req.depth
  }

  /** ★ 必传给每个工具的 ctx.signal(方案 §4.3)—— 只断 SSE 不断工具会留下僵尸进程 */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  // ─── 发射 ───

  emit(event: AgentEvent): number {
    if (this.status !== 'running' && event.type !== 'run_end') {
      // run 结束后还有事件漏进来,说明某处的收尾漏了 —— 丢掉但不静默
      console.warn(`[run] ${this.runId} 已是 ${this.status},丢弃迟到事件 ${event.type}`)
      return this.seq
    }

    const seq = ++this.seq
    this.log.push({ seq, event })

    // 待决交互表跟着事件走,attach 时才有东西可还原(方案 §4.6)
    if (event.type === 'interaction_request') {
      this.pendingInteractions.push(event.interaction)
    } else if (event.type === 'interaction_resolved') {
      const i = this.pendingInteractions.findIndex((p) => p.id === event.id)
      if (i >= 0) this.pendingInteractions.splice(i, 1)
    } else if (event.type === 'subagent_start') {
      this.children.add(event.childRunId)
    } else if (event.type === 'message_commit') {
      this.trimSupersededDeltas()
    } else if (event.type === 'run_end') {
      this.status = event.status
    }

    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log.splice(0, this.log.length - MAX_LOG_ENTRIES)
    }

    for (const l of this.listeners) l(event, seq)
    if (event.type === 'run_end') this.listeners.clear()
    return seq
  }

  /**
   * ★ 裁剪策略:message_commit 一到,它**之前**的 stream delta 就是冗余的 ——
   * 提交的消息已经包含了那些 delta 拼出来的全部内容。
   *
   * 这让裁剪对「重放能否还原 UI」是**无损**的:重放拿到的是
   * 结构性事件 + 已提交的完整消息 + 最后一次提交之后的增量 delta,正好够重画。
   * 单纯从头砍的环形缓冲做不到这一点(会在转录中间留一个真的洞)。
   *
   * 代价是 seq 在日志里不再连续 —— 所以 LogEntry 要自带 seq,
   * 而重放用 filter 而不是 slice。
   */
  private trimSupersededDeltas(): void {
    // 刚 push 进来的 commit 在末位,所以从 length-2 起往回清。
    // 倒序遍历 + 就地 splice 是安全的:splice(i) 不影响任何 < i 的下标。
    for (let i = this.log.length - 2; i >= 0; i--) {
      const entry = this.log[i]
      if (entry === undefined) continue
      // 撞到上一个提交就停。这是**扫描边界,不是正确性守卫** ——
      // 更早的 delta 在那次提交时已经清过了,去掉这行结果一样,只是每次提交
      // 都要扫全表。(所以没有测试覆盖它,别去找。)
      if (entry.event.type === 'message_commit') break
      // 只清 delta。tool_start / tool_end / interaction_* 是**结构性**的,
      // 留着几乎不占地方,而重放时 UI 要靠它们重建工具卡片。
      if (entry.event.type === 'stream') this.log.splice(i, 1)
    }
  }

  // ─── 订阅(多消费者) ───

  on(listener: RunListener): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  // ─── 重放 ───

  /**
   * sinceSeq 之后的事件。渲染层重载后用它补齐。
   *
   * ★ 重放出来的 seq 可能不连续(见 trimSupersededDeltas)——
   * 渲染层**不能**对重放事件跑「seq !== lastSeq + 1」的补齐逻辑,
   * 应用完之后直接把 lastSeq 置成 snapshot.seq。
   */
  since(sinceSeq: number): AgentEvent[] {
    return this.log.filter((e) => e.seq > sinceSeq).map((e) => e.event)
  }

  snapshot(sinceSeq: number): RunSnapshot {
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      ...(this.parentRunId !== undefined ? { parentRunId: this.parentRunId } : {}),
      depth: this.depth,
      status: this.status,
      seq: this.seq,
      events: this.since(sinceSeq),
      pendingInteractions: [...this.pendingInteractions],
      children: [...this.children]
    }
  }

  // ─── 中断 ───

  /**
   * ★ 这里只做方案 §4.8 五件事里的第 1、3、5 件(取消 SSE、取消工具、级联子 run)。
   * 第 2 件(拒绝待决交互)由 InteractionGate 挂在同一个 signal 上(步骤 5),
   * 第 4 件(给未闭合的 tool_call 补 tool_result)由 AgentSession 做(步骤 4)——
   * 因为只有它知道转录长什么样。**漏掉第 4 件下一轮请求就是 400。**
   */
  abort(_reason: AbortReason): void {
    if (this.status !== 'running') return
    this.controller.abort()
  }

  finish(status: RunStatus, error?: AgentError): void {
    if (this.status !== 'running') return
    this.emit(error ? { type: 'run_end', status, error } : { type: 'run_end', status })
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>()

  create(req: RunRequest): RunHandle {
    const existing = this.runs.get(req.runId)
    // ★ runId 由渲染层 mint,重复就是 bug(连按两次回车)。
    // 静默复用比抛错危险:两个 run 共享一份转录,消息会交错(方案 §8)。
    if (existing) throw new Error(`run 已存在: ${req.runId}`)

    const handle = new RunHandle(req)
    this.runs.set(req.runId, handle)

    if (req.parentRunId !== undefined) {
      this.runs.get(req.parentRunId)?.children.add(req.runId)
    }
    return handle
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId)
  }

  /** 外层工作区 Tab 的运行中角标就是数这个 —— 数据源是 registry,不是任何 UI 状态 */
  runningIn(workspaceId: string): RunHandle[] {
    return [...this.runs.values()].filter(
      (r) => r.workspaceId === workspaceId && r.status === 'running'
    )
  }

  activeRunIds(): string[] {
    return [...this.runs.values()].filter((r) => r.status === 'running').map((r) => r.runId)
  }

  /**
   * 某个 run 名下**还在跑**的子 run。
   *
   * ★ 数的是「还在跑的」,不是 `handle.children.size` —— 后者是**累计**的
   * (`children` 只加不减),用它当并发闸门的话,一次 run 里派满 N 个子代理之后
   * 就再也派不出第五个了,哪怕它们早就全部结束。
   */
  activeChildrenOf(runId: string): RunHandle[] {
    const parent = this.runs.get(runId)
    if (!parent) return []
    return [...parent.children]
      .map((id) => this.runs.get(id))
      .filter((h): h is RunHandle => h !== undefined && h.status === 'running')
  }

  activeChildCount(runId: string): number {
    return this.activeChildrenOf(runId).length
  }

  /** 级联中断(方案 §4.8 第 5 件):父 run 停,子 run 一起停 */
  abort(runId: string, cascade: boolean, reason: AbortReason = { by: 'user' }): void {
    const handle = this.runs.get(runId)
    if (!handle) return
    if (cascade) {
      for (const childId of handle.children) {
        this.abort(childId, true, { by: 'parent' })
      }
    }
    handle.abort(reason)
  }

  abortAll(reason: AbortReason = { by: 'shutdown' }): void {
    for (const id of this.activeRunIds()) this.abort(id, false, reason)
  }

  /** 已结束且没人订阅的 run 可以回收。步骤 6 之后转录在 SQLite 里,内存日志就没用了。 */
  reap(): number {
    let n = 0
    for (const [id, h] of this.runs) {
      if (h.status !== 'running' && h.listenerCount === 0) {
        this.runs.delete(id)
        n++
      }
    }
    return n
  }
}

export const runs = new RunRegistry()

// ═══════════════════════════════════════════════════════════════
// 测试专用适配器(方案 §4.7)
// ═══════════════════════════════════════════════════════════════

/** 收齐一个 run 的全部事件。步骤 4 的无头 vitest 快照就靠它。 */
export function collect(h: RunHandle): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const acc: AgentEvent[] = h.since(0)
    if (h.status !== 'running') {
      resolve(acc)
      return
    }
    const off = h.on((event) => {
      acc.push(event)
      if (event.type === 'run_end') {
        off()
        resolve(acc)
      }
    })
  })
}

/**
 * ⚠️ 只给测试用。异步生成器的 `finally` **只在消费者调用 `.return()` 时才执行** ——
 * `for await` + `break` 会调用,手写 `.next()` 泵不会。所以生产路径一律用 `on()`。
 */
export async function* toAsyncIterable(h: RunHandle): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = h.since(0)
  let notify: (() => void) | null = null
  let ended = h.status !== 'running'

  const off = h.on((event) => {
    queue.push(event)
    if (event.type === 'run_end') ended = true
    notify?.()
  })

  try {
    while (true) {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) yield next
      }
      if (ended) return
      await new Promise<void>((r) => {
        notify = r
      })
      notify = null
    }
  } finally {
    off()
  }
}
