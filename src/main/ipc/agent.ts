/**
 * Agent IPC —— RunRegistry 与渲染层之间的那一层。
 *
 * 这个文件存在的唯一理由是**合批**(方案 §8):一个 token 一条 IPC 消息,
 * 每条都要付一次结构化克隆 + 一次主线程跳转。快速流式下这是肉眼可见的卡顿,
 * 而且卡的是主进程 —— 连带整个应用一起卡。
 *
 * 合批逻辑刻意**不**放进 RunRegistry:内核零 electron import,
 * 而「往哪个 webContents 推」是彻头彻尾的 electron 概念。
 */
import type { AgentEvent, RunSnapshot } from '../../shared/agent/event'
import type { RunRequest } from '../../shared/agent/run-request'
import { IpcError } from './errors'
import { RunHandle, runs } from '../kernel/run-registry'
import { runAgent } from '../runtime'
import { runTopic, windows, type WindowContext } from '../window/registry'

/**
 * 16ms ≈ 一帧。方案 §8 给的是 16–33ms:再快没意义(渲染层反正等 rAF),
 * 再慢就能看出打字延迟了。
 */
const FLUSH_MS = 16
/** 单批上限。工具吐出几万行时,时间窗内能攒出一个大到卡住克隆的批。 */
const MAX_BATCH = 64

/**
 * ★ 只有这三种 delta 值得攒。其余事件都是**结构性**的 ——
 * 消息提交、工具起止、待决交互、run 结束 —— 它们要么改变 UI 结构,
 * 要么用户正等着它出现。攒起来只会让界面显得迟钝,省不下几条消息。
 *
 * 这同时实现了方案 §8 的「内容块边界立即 flush」:块边界事件本身就不可合批。
 */
function isCoalescable(e: AgentEvent): boolean {
  if (e.type !== 'stream') return false
  const t = e.delta.type
  return t === 'text_delta' || t === 'thinking_delta' || t === 'tool_call_delta'
}

/**
 * 一个 run 一个泵。
 *
 * ★ 批内 seq 必须连续 —— 信封只带最后一个 seq,渲染层用
 * `envelopeFirstSeq()` 反推第一个。所以**攒进 buf 的事件一个都不能丢**,
 * 哪怕当前没有窗口在看。想省这个开销就得整批跳过(见 flush 里的注释)。
 *
 * 这条不变式的另一半在 `shared/ipc/contract.ts` 的 `hasSeqGap()` —— 改这里的
 * `seq: this.lastSeq` 就必须同时改那边,否则渲染层每收一批就 attach 一次。
 */
class RunPump {
  private buf: AgentEvent[] = []
  private lastSeq = 0
  private timer: NodeJS.Timeout | null = null
  private readonly topic: string

  constructor(private readonly handle: RunHandle) {
    this.topic = runTopic(handle.runId)
    handle.on((event, seq) => this.push(event, seq))
  }

  private push(event: AgentEvent, seq: number): void {
    this.buf.push(event)
    this.lastSeq = seq

    if (!isCoalescable(event) || this.buf.length >= MAX_BATCH) {
      this.flush()
      if (event.type === 'run_end') pumps.delete(this.handle.runId)
      return
    }
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buf.length === 0) return

    const events = this.buf
    this.buf = []

    // 没人订阅时**整批丢弃**,而不是逐条丢:run 继续跑,日志继续记,
    // 窗口回来时走 attach 重放。这就是 hasSubscribers 存在的意义 ——
    // 停的是推送,不是 run。
    if (!windows.hasSubscribers(this.topic)) return

    windows.emitToTopic(this.topic, 'agent:event', {
      runId: this.handle.runId,
      seq: this.lastSeq,
      events
    })
  }
}

const pumps = new Map<string, RunPump>()

// ═══════════════════════════════════════════════════════════════
// handlers
// ═══════════════════════════════════════════════════════════════

/**
 * 驱动一个 run 的东西。默认是真的 `AgentSession`(经 `runtime.runAgent`)。
 *
 * ★ 这个接缝之所以存在,是因为**假发射器与真 session 对 `RunHandle` 的用法完全一致** ——
 * 那正是「第 3 步就能看到端到端流式」成立的原因,现在它反过来还有用:
 * `agent-pump.test.ts` 传一个确定性的假发射器进来,把**泵**单独拎出来测。
 * 拿真 session 测合批窗口是碰运气 —— 它的事件时序取决于上游怎么切片。
 *
 * 做成参数而不是一个可写的模块变量:后者要在每个测试后复位,
 * 而忘了复位的那个测试会莫名其妙地跑起真上游来。
 */
export type RunDriver = (handle: RunHandle, req: RunRequest) => void | Promise<void>

/**
 * ★ 订阅在前、启动在后(方案 §3 规则 2)。
 *
 * runId 由渲染层 mint 正是为了这个顺序成立:两件事都在这个同步块里做完,
 * 中间插不进任何一个事件(定时器和 IO 回调没法跟同步代码交错)。
 * 如果 runId 是 agent:run 的返回值,渲染层就只能在 await 之后才知道要订阅谁,
 * 而那时首批事件早发完了。
 */
export function startRun(req: RunRequest, ctx: WindowContext, driver: RunDriver = runAgent): void {
  windows.subscribe(runTopic(req.runId), ctx.sender)

  const handle = runs.create(req)
  pumps.set(req.runId, new RunPump(handle))

  void driver(handle, req)
}

/**
 * 重放。⌘R 重载窗口、或第二个窗口来看同一个 run,都走这里。
 *
 * ★ 三步的顺序是有讲究的:
 * 1. **先 flush** —— 泵里攒着的事件已经在日志里了。不先冲掉,
 *    它们会既出现在快照里、又在稍后推给这个刚订阅的窗口,变成重复。
 * 2. 再订阅;
 * 3. 最后取快照。2、3 之间同样插不进事件。
 */
export function attachRun(req: { runId: string; sinceSeq: number }, ctx: WindowContext): RunSnapshot {
  const handle = runs.get(req.runId)
  // 已被 reap 掉、或渲染层记着一个上辈子的 runId。让它拿到明确的错误,
  // 而不是一个空快照 —— 空快照会被当成「run 存在但没事件」,UI 就永远转圈了。
  if (!handle) throw new IpcError('unknown', `run 不存在: ${req.runId}`)

  pumps.get(req.runId)?.flush()
  windows.subscribe(runTopic(req.runId), ctx.sender)
  return handle.snapshot(req.sinceSeq)
}

export function abortRun(req: { runId: string; cascade: boolean }): void {
  runs.abort(req.runId, req.cascade, { by: 'user' })
}

/** app 退出前:停掉所有 run,冲掉所有泵。留着的 setTimeout 会拖住退出。 */
export function shutdownRuns(): void {
  runs.abortAll({ by: 'shutdown' })
  for (const pump of pumps.values()) pump.flush()
  pumps.clear()
}
