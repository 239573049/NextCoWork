/**
 * per-session store —— 方案 §8。
 *
 * 两件事在这里同时成立,而它们互为因果:
 *
 * 1. **流式文本必须住在这里,不能住在全局 store**。放全局的话,每个 token 都会
 *    让订阅了全局 store 的 Tab 栏、侧边栏跟着重渲染 —— 一秒钟几十次全树 diff。
 * 2. **懒创建、工作区关闭时销毁**。会话可能有几百个,每个都建 store 是白占内存。
 *
 * 加上主进程侧 16–33ms 合批和这里的 rAF 再缓冲,就是全部的流式性能方案。
 * 不做 ack/流控 —— 真背压是研究课题(方案 §10)。
 */
import { create, type UseBoundStore, type StoreApi } from 'zustand'
import type { AgentEvent } from '../../../shared/agent/event'
import type { RunRequest } from '../../../shared/agent/run-request'
import {
  applyEvents,
  emptyTranscript,
  hasRun,
  type TranscriptState
} from '../../../shared/agent/transcript'
import type { AgentEventEnvelope } from '../../../shared/ipc/contract'
import { hasSeqGap } from '../../../shared/ipc/contract'
import { ulid } from '../../../shared/util/id'
import { abortRun, attachRun, onAgentEvent, startRun } from '../services/agent'

export type SendOptions = Omit<RunRequest, 'runId' | 'sessionId' | 'input'>

export interface SessionState {
  sessionId: string
  /** ★ 一个会话同一时刻只有一个 run(方案 §8)。null = 空闲 */
  activeRunId: string | null
  /** 已应用的最后一个 seq。防漂移就靠它 */
  lastSeq: number
  transcript: TranscriptState
  /** 生成期间用户可以继续输入并入队(截图:「当前回复完成后按队列继续执行」) */
  queuedInputs: string[]
  /**
   * 上一次发送用的档位/模型/模式。出队续跑时要复用它 ——
   * **不能读当时的 UI 值**:用户可能在排队期间改了模型下拉,
   * 而排队那条消息是按他当时看到的设置写的。
   */
  lastOptions: SendOptions | null
  /** 输入框草稿 —— 切 Tab 不能丢 */
  draft: string

  send: (text: string, opts: SendOptions) => Promise<void>
  stop: () => Promise<void>
  setDraft: (v: string) => void
  applyEnvelope: (env: AgentEventEnvelope) => void
  applyEvents: (events: AgentEvent[]) => void
}

type SessionStore = UseBoundStore<StoreApi<SessionState>>

function createSessionStore(sessionId: string): SessionStore {
  return create<SessionState>((set, get) => ({
    sessionId,
    activeRunId: null,
    lastSeq: 0,
    transcript: emptyTranscript(),
    queuedInputs: [],
    lastOptions: null,
    draft: '',

    async send(text, opts) {
      const s = get()
      // ★ 不变式:一个会话同一时刻只有一个 run。用户连按两次回车就能并发起两个 run,
      // 共享同一份转录 → 消息交错。这几行就是那条不变式的全部实现。
      if (s.activeRunId !== null) {
        set({ queuedInputs: [...s.queuedInputs, text], draft: '' })
        return
      }

      // ★ 渲染层 mint runId,**订阅在前、启动在后**(方案 §3 规则 2)。
      // registerRun 把 runId → sessionId 的映射登记好,这样第一个事件回来时
      // 泵知道该投给谁 —— 而 startRun 的 await 还没返回。
      const runId = ulid()
      registerRun(runId, sessionId, opts.workspaceId)
      set({
        activeRunId: runId,
        lastSeq: 0,
        // ★ 只清「本轮」的部分。`messages` 和 `tools` 必须留着 —— 它们是**整段对话**,
        // 不是这一个 run 的产物。整个 `emptyTranscript()` 换上去的话,发第二条消息
        // 就会把第一轮的问答从屏幕上抹掉。
        //
        // 用户这条消息不在这里补 —— 主进程会为它发 `message_commit`
        // (见 AgentSession 构造函数),这边补一条就成了两条 id 不同的同一句话。
        transcript: {
          ...emptyTranscript(),
          messages: s.transcript.messages,
          tools: s.transcript.tools
        },
        lastOptions: opts,
        draft: ''
      })

      try {
        await startRun({ ...opts, runId, sessionId, input: [{ type: 'text', text }] })
      } catch (err) {
        unregisterRun(runId)
        set({ activeRunId: null })
        throw err
      }
    },

    async stop() {
      const runId = get().activeRunId
      if (runId === null) return
      // 状态不在这里改 —— 等 run_end 事件回来。中断路径上主进程还要做收尾
      // (方案 §4.8 的五件事),UI 抢先置成 idle 就看不到那个过程了。
      await abortRun(runId, true)
    },

    setDraft(v) {
      set({ draft: v })
    },

    applyEnvelope(env) {
      const s = get()
      if (env.runId !== s.activeRunId) return

      // ★ 防漂移(方案 §3 规则 1)。这个 ±1 不在这里手算 —— 它与合批泵
      // 造信封的那行是**一对**,两边对「seq 指哪个事件」的理解必须完全一致。
      if (hasSeqGap(env, s.lastSeq)) {
        void resync(sessionId, env.runId, s.lastSeq)
        return
      }

      set({
        transcript: applyEvents(s.transcript, env.events),
        lastSeq: env.seq,
        ...settleRun(env.runId, env.events)
      })
      drainQueue(sessionId)
    },

    applyEvents(events) {
      set({
        transcript: applyEvents(get().transcript, events),
        ...settleRun(get().activeRunId, events)
      })
      drainQueue(sessionId)
    }
  }))
}

/**
 * run 走到终局时的收尾:把会话置回空闲,**并把它从运行中索引里摘掉**。
 *
 * ★ **两件事必须一起做,所以这个函数不是纯的** —— 名字里的 settle 就是这个意思。
 * 「运行中」那颗圆点读的是 `runIndex`(全局、不随 Tab 开关消失),而输入框和状态行
 * 读的是会话 store 的 `activeRunId`。**两份状态,得同时收。**
 *
 * 曾经只收了后一半:`unregisterRun` 只写在 `send` 的 catch 里,于是
 * **只有启动失败的 run 会被摘掉**,正常跑完的那些圆点一直亮着 —— 外层工作区 Tab、
 * 内层对话 Tab、侧边栏会话行同时挂着三颗,直到关掉工作区才消。
 * 状态行明明写着「已完成」,旁边圆点还在转,是截图里一眼就看出来的那种错。
 *
 * 出队续跑不在这里,由 `drainQueue` 接手 —— 它得能调 `send()`。
 */
function settleRun(runId: string | null, events: readonly AgentEvent[]): Partial<SessionState> {
  if (!events.some((e) => e.type === 'run_end')) return {}
  if (runId !== null) unregisterRun(runId)
  return { activeRunId: null }
}

/**
 * run 结束后自动发出排队的下一条 —— 截图里生成中的占位符写的就是
 * 「当前回复完成后按队列继续执行」。
 *
 * 不写进 `settleRun`,是因为那里只能返回状态补丁,而这里要发起一次新的 `send()`。
 */
function drainQueue(sessionId: string): void {
  const store = stores.get(sessionId)
  if (!store) return
  const s = store.getState()
  const [next, ...rest] = s.queuedInputs
  if (s.activeRunId !== null || next === undefined || s.lastOptions === null) return
  store.setState({ queuedInputs: rest })
  void s.send(next, s.lastOptions).catch((err: unknown) => {
    console.error('[agent] 队列续跑失败:', err)
  })
}

// ═══════════════════════════════════════════════════════════════
// 注册表 + 单一事件泵
// ═══════════════════════════════════════════════════════════════

const stores = new Map<string, SessionStore>()

export function sessionStore(sessionId: string): SessionStore {
  let s = stores.get(sessionId)
  if (!s) {
    s = createSessionStore(sessionId)
    stores.set(sessionId, s)
  }
  return s
}

/**
 * 工作区退场时,放掉这个会话在渲染层占的内存(主要是整段转录)。
 * 不放的话,开过的几百个会话会一直挂着。
 *
 * ★ **正在跑的会话放不掉,返回 `false`。** 这是方案 §8 那条试金石的下半段:
 * *run 活在主进程的 RunRegistry 里,渲染层这边关掉几个 Tab、乃至关掉整个工作区,
 * 都不该让它消失。* 曾经这里是连 `runIndex` 里的条目一起删的 —— 那等于**渲染层
 * 单方面忘掉一个还在跑的 run**:事件泵按 runId 反查会话查不到,事件被静默丢弃,
 * 重新打开工作区看到的是一段停在半路、而且再也不会动的转录。
 *
 * 判「在不在跑」读的是 `runIndex`,不是某个 store 的 `activeRunId`:⌘R 重载后
 * `adoptActiveRuns` 只补了索引,那个会话的 store 还没有人碰过(它是懒创建的),
 * 此刻 `activeRunId` 是 null,但 run 千真万确活着。
 */
export function releaseSession(sessionId: string): boolean {
  for (const r of runIndex.values()) if (r.sessionId === sessionId) return false
  return stores.delete(sessionId)
}

/**
 * 这个会话有没有被用过 —— 「点侧边栏的『新建对话』时能不能重用现成的那一个」的判据。
 *
 * ★ **不能拿 `sessionStore(id)` 来问。** 那个函数是懒创建的,用它探测会把每个
 * chat Tab 的 store 都建出来,正好把本文件开头第 2 条(懒创建、关工作区时销毁)
 * 反过来变成「开过的会话全都常驻」。所以这里直接查注册表:**查不到就是没碰过**。
 *
 * 判据用的是 `ChatView` 决定画哪一屏的那个 `hasRun` —— 于是「屏幕上显示着问候语
 * 的那些对话」和「这里认为可以重用的那些」是同一批,两边不会各说各话。
 *
 * 草稿和排队中的输入另算:输入框里躺着半句话的会话不算空,用户这时候点
 * 「新建对话」要的是干净的一屏,而不是回到自己刚才写了一半的地方。
 */
export function isSessionUntouched(sessionId: string): boolean {
  const store = stores.get(sessionId)
  if (store === undefined) return true
  const s = store.getState()
  return (
    !hasRun(s.transcript, s.activeRunId !== null) &&
    s.draft.trim() === '' &&
    s.queuedInputs.length === 0
  )
}

/**
 * 运行中 run 的索引 —— Tab 上那个「运行中」圆点的数据源。
 *
 * ★ **它是 RunRegistry 的投影,不是 UI 状态**(方案 §8)。判断模型对不对的
 * 试金石就在这:*关掉最后一个正在观看某个运行中会话的 Tab,run 依然活着,
 * 且外层工作区 Tab 上仍显示角标。* 角标读这张表,而这张表不关心有没有 Tab 开着。
 *
 * 单独一个 store 而不是塞进 `useWindowStore`:它每个 run 起止各变一次,
 * 而 `useWindowStore` 一动整条 Tab 栏就重渲染。
 */
export interface RunIndexEntry {
  runId: string
  sessionId: string
  workspaceId: string
}

const runIndex = new Map<string, RunIndexEntry>()

/** 快照数组。zustand 靠引用比较,所以每次变更换一个新数组。 */
export const useRunIndex = create<RunIndexEntry[]>(() => [])

function publishRunIndex(): void {
  useRunIndex.setState([...runIndex.values()], true)
}

function registerRun(runId: string, sessionId: string, workspaceId: string): void {
  runIndex.set(runId, { runId, sessionId, workspaceId })
  publishRunIndex()
}
function unregisterRun(runId: string): void {
  runIndex.delete(runId)
  publishRunIndex()
}

/**
 * 首屏把主进程还活着的 run 补回索引(`Bootstrap.activeRuns`)。
 * 冷启动是空的 —— 「永不恢复运行中状态」(方案 §9);非空只发生在 ⌘R 重载:
 * 主进程没重启,run 还在跑,而渲染层刚刚失忆。
 */
export function adoptActiveRuns(runs: readonly RunIndexEntry[]): void {
  for (const r of runs) runIndex.set(r.runId, r)
  publishRunIndex()
}

/**
 * 补齐:拿快照重建,而不是试图往回补那几条。
 *
 * ★ 重放出来的 seq **可能不连续**(主进程在 message_commit 处裁掉了被取代的 delta),
 * 所以这里绝不能对 snapshot.events 再跑一遍 gap 检查 —— 直接应用,
 * 然后把 lastSeq 置成 snapshot.seq。对它再查一次连续性会导致无限 resync。
 */
async function resync(sessionId: string, runId: string, sinceSeq: number): Promise<void> {
  const store = stores.get(sessionId)
  if (!store) return
  console.warn(`[agent] seq 不连续,attach 补齐 · run=${runId} since=${sinceSeq}`)
  try {
    const snap = await attachRun(runId, sinceSeq)
    store.setState((s) => ({
      transcript: applyEvents(s.transcript, snap.events),
      lastSeq: snap.seq,
      activeRunId: snap.status === 'running' ? runId : null
    }))
  } catch (err) {
    console.error('[agent] attach 失败:', err)
  }
}

/**
 * 全应用**一个** IPC 监听器,按 runId 分发。
 *
 * 每个 store 各自订阅也能跑,但那样每条事件都要过 N 个回调,
 * 且退订责任分散到 N 个地方 —— 而漏退订正是 HMR 下监听器叠加的成因(方案 §3 规则 4)。
 */
let unsubscribe: (() => void) | null = null
let pending: AgentEventEnvelope[] = []
let raf = 0

export function startAgentEventPump(): () => void {
  if (unsubscribe) return unsubscribe

  const off = onAgentEvent((env) => {
    pending.push(env)
    // rAF 再缓冲:主进程已经合过一次批,这里再对齐到帧。
    // 一帧内到达的多个批合成一次 set() —— 也就是一次 React 渲染。
    if (raf === 0) raf = requestAnimationFrame(drain)
  })

  unsubscribe = () => {
    off()
    if (raf !== 0) cancelAnimationFrame(raf)
    raf = 0
    pending = []
    unsubscribe = null
  }
  return unsubscribe
}

function drain(): void {
  raf = 0
  const batch = pending
  pending = []
  for (const env of batch) {
    const sessionId = runIndex.get(env.runId)?.sessionId
    if (sessionId === undefined) continue
    stores.get(sessionId)?.getState().applyEnvelope(env)
  }
}
