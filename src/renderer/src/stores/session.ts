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
import type { PermissionMode } from '../../../shared/agent/permission'
import type { AgentEvent } from '../../../shared/agent/event'
import { isToolResultOnly, userMessage, type AgentMessage, type ContentPart } from '../../../shared/agent/message'
import type { SendOptions } from '../../../shared/agent/run-request'
import {
  applyEvents,
  applyChildEvent,
  emptyTranscript,
  hasRun,
  subagentsFromMessages,
  toolsFromMessages,
  type TranscriptState
} from '../../../shared/agent/transcript'
import type { QueuedInput } from '../../../shared/domain/queued-input'
import {
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_TEXT,
  SESSION_INPUT_VERSION,
  batchToParts,
  isLive,
  makeQueuedInput,
  mergeBatch,
  partsToAttachments,
  pickNextBatch
} from '../../../shared/domain/queued-input'
import type { AgentEventEnvelope } from '../../../shared/ipc/contract'
import { hasSeqGap } from '../../../shared/ipc/contract'
import { ulid } from '../../../shared/util/id'
import { abortRun, attachRun, interjectRun, onAgentEvent, startRun } from '../services/agent'
import { getSessionInput, persistSessionInput } from '../services/app'
import { compactContext as compactSessionContext } from '../services/context'
import { replaceHistory } from '../services/sessions'
import { getSession } from '../services/sessions'

/**
 * ★ 类型本体已挪到 `shared/agent/run-request.ts` —— 队列条目要逐条冻结它,
 * 而 shared 不能反向依赖渲染层。这里 re-export 保持既有引用点不变。
 */
export type { SendOptions }

export interface SessionState {
  sessionId: string
  /** ★ 一个会话同一时刻只有一个 run(方案 §8)。null = 空闲 */
  activeRunId: string | null
  /** 已应用的最后一个 seq。防漂移就靠它 */
  lastSeq: number
  transcript: TranscriptState
  /**
   * 生成期间用户可以继续输入并入队(截图:「当前回复完成后按队列继续执行」)。
   *
   * ★ 从 `string[]` 升格为结构化条目:截图要求逐条插话/编辑/删除,
   * 而字符串数组里**两条内容相同的消息不可区分**。只含非终态条目。
   */
  queuedInputs: QueuedInput[]
  /**
   * 上一次发送用的档位/模型/模式。
   *
   * ★ 队列条目现在**各自带 `options`**,续跑读的是条目自己的快照,不是这个字段。
   * 它只剩两个用途:队列条目意外没有快照时的兜底,以及 UI 回显。
   *
   * ★★ **「重新生成」不读它** —— 那是用户此刻发起的新 run,该用此刻的药丸值。
   * 曾经读过,症状是:切了模型再点重新生成,跑的还是上一次那个模型。
   */
  lastOptions: SendOptions | null
  /** 输入框草稿 —— 切 Tab 不能丢,**进程重启也不能丢**(落盘,见 §8) */
  draft: string
  /** 手动压缩上下文进行中。圆环据此转圈,并挡住第二次双击。 */
  compacting: boolean
  /** 上一次手动压缩的失败原因,成功或再次发起时清掉。 */
  compactError: string | null

  send: (text: string, opts: SendOptions, parts?: ContentPart[]) => Promise<void>
  stop: () => Promise<void>
  /**
   * 手动压缩上下文(输入框那个圆环双击)。
   *
   * ★ **只在空闲时可用**:正在跑的那个 run 已经把自己的上下文投影冻在主进程里,
   * 此刻落检查点它不会读到,界面读数却已经跳了 —— 两边从此对不上。
   */
  compactContext: () => Promise<void>
  setDraft: (v: string) => void
  /** 插话 —— toggle:pending ⇄ promoted。不发起任何请求 */
  promoteInput: (id: string) => void
  editInput: (id: string, text: string) => void
  /**
   * 权限档位药丸切换时调用:还没被消费的排队消息**改用新档位**,
   * 而不是继续背着入队那一刻冻结的旧档位。
   *
   * ★ 只改 `permissionMode` 这一个字段,不动 `options` 里的模型/思考强度/联网开关 ——
   * 那几个字段「逐条冻结」的既有设计(见 `queued-input.ts` 头注)仍然成立,
   * 这里是刻意为「审批档位」单独开的例外:用户切到完全访问,图的就是不想再被后面
   * 排着的每一条追问打断,那份意图理应立刻覆盖到整条队列,而不是只对新排的消息生效。
   */
  retagQueuedPermission: (mode: PermissionMode) => void
  /**
   * 编辑一条用户消息。`continueRun` = 从这条起重跑(界面上的「重新生成」)。
   *
   * ★ `options` 是**此刻**药丸上的档位/模型,不是这条消息当初发送时的那份 ——
   * 见实现里的注释。
   */
  editMessage: (id: string, text: string, continueRun: boolean, options: SendOptions) => Promise<void>
  /** 删掉一整轮问答(user 消息 + 它引出的全部回复与工具回执)。 */
  deleteTurn: (userMessageId: string) => Promise<void>
  dropInput: (id: string) => void
  /** 「⋯ → 撤回到输入框」:出队并回填草稿 */
  moveInputToDraft: (id: string) => void
  applyEnvelope: (env: AgentEventEnvelope) => void
  applyEvents: (events: AgentEvent[]) => void
  /** Apply a child run's telemetry to its parent Task card. */
  applyChildEvents: (childRunId: string, events: AgentEvent[], firstSeq?: number) => void
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
    compacting: false,
    compactError: null,

    async send(text, opts, parts) {
      const s = get()
      // ★ 不变式:一个会话同一时刻只有一个 run。用户连按两次回车就能并发起两个 run,
      // 共享同一份转录 → 消息交错。这几行就是那条不变式的全部实现。
      if (s.activeRunId !== null) {
        // ★ 软上限:超过就不是队列了,是便签本。**拒绝入队并保留草稿** ——
        // 静默丢弃会让用户以为消息进了队列。
        if (s.queuedInputs.length >= QUEUE_MAX_ITEMS) return
        set({
          queuedInputs: [
            ...s.queuedInputs,
            // ★ 逐条冻结 options:排队 5 分钟里改两次模型,三条消息该有三份档位。
            //   ★ 附件也必须一起存 —— 不存的话,生成期间带图发的那条消息
            //     续跑时会只剩文字,图静默消失,而用户明明看到自己发了图。
            makeQueuedInput(
              ulid(),
              text.slice(0, QUEUE_MAX_TEXT),
              opts,
              Date.now(),
              parts === undefined ? [] : partsToAttachments(parts)
            )
          ],
          draft: ''
        })
        persistInput(sessionId, true)
        return
      }

      // ★ 渲染层 mint runId,**订阅在前、启动在后**(方案 §3 规则 2)。
      // registerRun 把 runId → sessionId 的映射登记好,这样第一个事件回来时
      // 泵知道该投给谁 —— 而 startRun 的 await 还没返回。
      const runId = ulid()
      // 先把最终会发给主进程的 parts 固定下来。附件和纯文本都必须在这条
      // 乐观消息里完整呈现,否则用户会先看到与实际请求不同的内容。
      const input = parts ?? [{ type: 'text' as const, text }]
      const inputMessageId = ulid()
      const now = Date.now()
      const inputMessage = userMessage(inputMessageId, [...input], now)
      registerRun(runId, sessionId, opts.workspaceId)
      set({
        activeRunId: runId,
        lastSeq: 0,
        // ★ 只清「本轮」的部分。`messages` 和 `tools` 必须留着 —— 它们是**整段对话**,
        // 不是这一个 run 的产物。整个 `emptyTranscript()` 换上去的话,发第二条消息
        // 就会把第一轮的问答从屏幕上抹掉。
        //
        transcript: {
          ...emptyTranscript(),
          messages: [...s.transcript.messages, inputMessage],
          tools: s.transcript.tools,
          // Background children can outlive the parent turn. Keep their cards
          // visible when the user starts another parent turn in this session.
          subagents: s.transcript.subagents,
          // 历史轮次的账,和 `messages` 一样属于整段对话而不是这一个 run。
          ...conversationScoped(s.transcript),
          runStartedAt: now
        },
        lastOptions: opts,
        draft: ''
      })
      persistInput(sessionId, true)

      try {
        await startRun({ ...opts, runId, sessionId, input, inputMessageId })
      } catch (err) {
        unregisterRun(runId)
        set((state) => ({
          activeRunId: null,
          // IPC 启动失败时主进程不会确认这条消息,所以撤掉本地乐观副本。
          // 用 ID 删除而不是按末尾位置删除,避免并发的历史刷新改变数组顺序。
          transcript: {
            ...state.transcript,
            messages: state.transcript.messages.filter((message) => message.id !== inputMessageId),
            live: [],
            status: 'done',
            runStartedAt: undefined,
            runEndedAt: undefined
          }
        }))
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

    async compactContext() {
      const s = get()
      if (s.activeRunId !== null || s.compacting) return
      set({ compacting: true, compactError: null })
      try {
        const { checkpoint, inputTokens } = await compactSessionContext(s.sessionId)
        set((st) => ({
          transcript: {
            ...st.transcript,
            contextCheckpoints: [
              ...st.transcript.contextCheckpoints.filter((c) => c.id !== checkpoint.id),
              checkpoint
            ],
            /*
              ★ 换成**估算值**,而不是等下一轮真实 usage 回来。
              等的话,用户压完看到读数纹丝不动,只会再点两次 ——
              而每一次都是一次真实的摘要请求。估算与真实的差距(系统提示词、
              工具 schema 不在内)远小于「界面看起来没反应」的代价。
            */
            lastInputTokens: inputTokens
          }
        }))
      } catch (err) {
        set({ compactError: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ compacting: false })
      }
    },

    setDraft(v) {
      set({ draft: v })
      // ★ 按键级频率,走防抖。丢失窗口 ≤500ms,代价是半个词
      persistInput(sessionId, false)
    },

    /**
     * 插话 —— **toggle**。用户点第二次的意图明确就是取消,报错或无操作都不对。
     *
     * ★ 取消时清掉 `promotedAt`:再次引入应当排到已引入者的**队尾**,
     * 而不是凭借第一次点击的时刻插回中间。
     */
    promoteInput(id) {
      const s = get()
      const item = s.queuedInputs.find((q) => q.id === id)
      if (item === undefined) return

      // ★ **不能直接用 Date.now()。** 它是毫秒分辨率,而排序的正确性不该依赖
      //   「两次点击不会落在同一毫秒」。同值时 sort 稳定退化成入队序 ——
      //   于是先插的乙、后插的甲会按甲、乙发出去,与用户点击顺序相反。
      //   取 max(now, 已有最大值 + 1) 保证严格单调,同时保住时间戳语义
      //   (UI 仍可拿它显示「刚刚引入」),且重启恢复后新插话依然排在旧的之后。
      const maxAt = s.queuedInputs.reduce((m, q) => Math.max(m, q.promotedAt ?? 0), 0)
      const at = Math.max(Date.now(), maxAt + 1)

      const next = s.queuedInputs.map((q) =>
        q.id === id
          ? q.status === 'promoted'
            ? { ...q, status: 'pending' as const, promotedAt: undefined }
            : { ...q, status: 'promoted' as const, promotedAt: at }
          : q
      )
      set({ queuedInputs: next })
      persistInput(sessionId, true)

      // ★ 空闲态被点插话:条目本不该存在于队列(空闲时 send 直接发)。
      //   若因竞态残留,等价于「立即发送」,而不是让它永远躺在那儿。
      if (s.activeRunId === null) drainQueue(sessionId)
      // ★ 运行中才是插话的正题:推给主进程,由它在下一个轮次边界注入。
      //   取消引入走的也是这一句 —— 全量替换,少了那条就等于撤回。
      else syncInterject(sessionId)
    },

    editInput(id, text) {
      const s = get()
      // ★ 不重置 options(档位仍是入队时刻的快照),也不重置 promotedAt
      //   (编辑不改变加塞顺序)。
      set({
        queuedInputs: s.queuedInputs.map((q) =>
          q.id === id ? { ...q, text: text.slice(0, QUEUE_MAX_TEXT) } : q
        )
      })
      persistInput(sessionId, true)
      // 编辑一条已引入的条目:主进程信箱里存的是旧文本,必须重发覆盖。
      syncInterject(sessionId)
    },

    retagQueuedPermission(mode) {
      const s = get()
      if (s.queuedInputs.length === 0) return
      set({
        queuedInputs: s.queuedInputs.map((q) =>
          q.options.permissionMode === mode ? q : { ...q, options: { ...q.options, permissionMode: mode } }
        )
      })
      persistInput(sessionId, true)
    },

    async editMessage(id, text, continueRun, options) {
      const s = get()
      if (s.activeRunId !== null) return
      const index = s.transcript.messages.findIndex((message) => message.id === id && message.role === 'user')
      if (index < 0) return
      const original = s.transcript.messages[index]
      if (original === undefined) return
      // Keep attachments and other structured parts, while replacing the
      // visible text as one canonical part so stale text fragments cannot
      // survive an edit.
      const parts: ContentPart[] = [
        ...(text === '' ? [] : [{ type: 'text' as const, text }]),
        ...original.parts.filter((part) => part.type !== 'text')
      ]
      const edited = userMessage(original.id, parts, original.createdAt)
      const messages = continueRun
        ? s.transcript.messages.slice(0, index)
        : s.transcript.messages.map((message, i) => i === index ? edited : message)
      await replaceHistory(sessionId, messages)
      set((state) => ({
        transcript: {
          ...state.transcript,
          messages: continueRun ? messages : state.transcript.messages.map((message, i) => i === index ? edited : message),
          live: continueRun ? [] : state.transcript.live,
          tools: continueRun ? {} : state.transcript.tools,
          subagents: continueRun ? {} : state.transcript.subagents,
          ...(continueRun ? { status: 'done' as const, error: undefined, usage: undefined } : {})
        }
      }))
      if (continueRun) {
        /*
          ★★ 用**调用方此刻传进来的**档位,不是 `lastOptions`。
          「重新生成」/「编辑后续跑」是用户**此刻发起的一次新 run**,不是重放
          过去那次的意图 —— 而"换个模型再试一次"恰恰是按重新生成最主要的理由。
          这里读 `lastOptions` 的话,用户切了模型再点重新生成,跑的还是上一次
          那个模型,且界面上没有任何迹象说明为什么。
        */
        await get().send(text, options, parts)
      }
    },

    /**
     * 删掉一整轮。
     *
     * ★ **删除的单位是「跨度」,不是「一条消息」。** 一轮问答在存储里是
     * `user` → `assistant`(含 tool_call)→ `user`(其实是 tool_result 回执)
     * → `assistant` … 这样一长串。只删可见的那两条,留下来的 tool_result
     * 会失去与之配对的 tool_call —— 那对 Anthropic 形状是**非法请求**,
     * 下一次发消息才会炸,而那时早已看不出是这次删除干的。
     *
     * 所以跨度从这条 user 消息起,一直吃到**下一条可见的 user 消息之前**。
     * `isToolResultOnly` 正是「可见」的判据,与 Thread 的过滤同源。
     */
    async deleteTurn(userMessageId) {
      const s = get()
      if (s.activeRunId !== null) return
      const messages = s.transcript.messages
      const start = messages.findIndex((m) => m.id === userMessageId && m.role === 'user')
      if (start < 0) return
      let end = start + 1
      while (end < messages.length) {
        const m = messages[end]
        if (m !== undefined && m.role === 'user' && !isToolResultOnly(m)) break
        end += 1
      }
      const next = [...messages.slice(0, start), ...messages.slice(end)]
      await replaceHistory(sessionId, next)
      // 删到尾巴时,残留的 usage/error 说的是一个已经不存在的回合。
      const trailing = end >= messages.length
      set((state) => ({
        transcript: {
          ...state.transcript,
          messages: next,
          ...(trailing ? { error: undefined, usage: undefined, runStartedAt: undefined, runEndedAt: undefined } : {})
        }
      }))
    },

    dropInput(id) {
      set({ queuedInputs: get().queuedInputs.filter((q) => q.id !== id) })
      persistInput(sessionId, true)
      // 删掉一条已引入的条目 = 从主进程信箱里撤回它。
      syncInterject(sessionId)
    },

    moveInputToDraft(id) {
      const s = get()
      const item = s.queuedInputs.find((q) => q.id === id)
      if (item === undefined) return
      set({
        queuedInputs: s.queuedInputs.filter((q) => q.id !== id),
        // 已有草稿时接在后面,不覆盖 —— 覆盖会吞掉用户正在写的半句话
        draft: s.draft === '' ? item.text : `${s.draft}\n\n${item.text}`
      })
      persistInput(sessionId, true)
      // 撤回到草稿同样是「它不再是插话了」。
      syncInterject(sessionId)
    },

    applyEnvelope(env) {
      const s = get()
      if (env.runId !== s.activeRunId) return
      if (env.seq <= s.lastSeq) return

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
      // ★ 先收队列再续跑。反过来的话,`drainQueue` 会看见一条刚刚已经被注入、
      //   只是还没从队列里摘掉的条目,把同一句话再发一遍。
      reapInjected(sessionId, env.events)
      if (endedCleanly(env.events)) drainQueue(sessionId)
    },

    applyEvents(events) {
      set({
        transcript: applyEvents(get().transcript, events),
        ...settleRun(get().activeRunId, events)
      })
      reapInjected(sessionId, events)
      if (endedCleanly(events)) drainQueue(sessionId)
    },

    applyChildEvents(childRunId, events, firstSeq) {
      set((state) => ({
        transcript: events.reduce(
          (current, event, index) => applyChildEvent(
            current,
            childRunId,
            event,
            firstSeq === undefined ? undefined : firstSeq + index
          ),
          state.transcript
        )
      }))
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
 * run 是否**正常**跑完。
 *
 * ★ 只有 `done` 才自动续跑。`aborted` 时用户按的是停止 —— 他要的是接管控制权,
 * 此时自动发出下一条等于无视那个意图;`error` 时自动灌入下一条往往连着错 N 次
 * 并烧掉 N 轮 token。两种情况队列都**留在原地**,由用户点「继续执行」。
 */
function endedCleanly(events: readonly AgentEvent[]): boolean {
  return events.some((e) => e.type === 'run_end' && e.status === 'done')
}

/**
 * run 结束后自动发出排队的下一批 —— 截图里生成中的占位符写的就是
 * 「当前回复完成后按队列继续执行」。
 *
 * 不写进 `settleRun`,是因为那里只能返回状态补丁,而这里要发起一次新的 `send()`。
 */
function drainQueue(sessionId: string): void {
  const store = stores.get(sessionId)
  if (!store) return
  const s = store.getState()
  if (s.activeRunId !== null) return

  const batch = pickNextBatch(s.queuedInputs)
  if (batch.length === 0) return

  const merged = mergeBatch(batch)
  // 超限被排除的条目**退回队列**并降回 pending —— 它们没被发出去,
  // 留在 promoted 会让下一轮又把它们排到最前,而用户以为已经发了。
  const deferred = new Set(merged.deferredIds)
  const sentIds = new Set(batch.filter((q) => !deferred.has(q.id)).map((q) => q.id))

  store.setState({
    queuedInputs: s.queuedInputs
      .filter((q) => !sentIds.has(q.id))
      .map((q) => (deferred.has(q.id) ? { ...q, status: 'pending' as const, promotedAt: undefined } : q))
  })
  persistInput(sessionId, true)

  // ★ 档位取**最早被引入**那条的快照:用户按他当时看到的设置写下这句话。
  //   `lastOptions` 只在条目自身没有快照时兜底(理论上不会发生)。
  const opts = batch[0]?.options ?? s.lastOptions
  if (opts === null || opts === undefined) return

  void s.send(merged.text, opts, batchToParts(merged)).catch((err: unknown) => {
    console.error('[agent] 队列续跑失败:', err)
  })
}

/**
 * 用户手动继续 —— 中断/报错/进程重启后队列不会自己动,由这里接手。
 * 与自动续跑走同一条路径,不存在第二套发送逻辑。
 */
export function resumeQueue(sessionId: string): void {
  drainQueue(sessionId)
}

// ═══════════════════════════════════════════════════════════════
// 插话 —— run 跑着的时候把消息塞进去
// ═══════════════════════════════════════════════════════════════

/**
 * 把当前全部 promoted 条目推给正在跑的 run。
 *
 * ## 为什么「插话」必须走这条路,而不是只改本地状态
 *
 * 原实现里 promote 是**纯本地**的:它只把条目排到 `pickNextBatch` 的最前面,
 * 真正发出去要等当前 run 整个跑完。用户看到的却是一颗写着「已插话」的按钮 ——
 * 于是点完之后一切照旧,模型继续跑它的工具,那句话一个字都没进去。
 * **界面承诺了插入,实现做的是排序。**
 *
 * 现在 promote 会把条目送到主进程的信箱,由 `AgentSession` 在下一个轮次边界
 * (一次 API 响应 + 它的工具全部执行完)注入成用户消息,然后带着它再请求一次。
 *
 * ## 仍然只发 promoted,不捎带 pending
 *
 * 与 `pickNextBatch` 同一条规矩,理由也一样:pending 是「排队等着」,
 * 用户没有表达「现在就说」。这里再加一层 —— 把 pending 也灌进去等于
 * 任何人排队都会打断当前执行,那就没有队列可言了。
 *
 * ## 失败只记日志
 *
 * 主进程侧 run 已结束时会静默忽略(见 `interjectRun`),条目原样留在队列里,
 * 由 run 结束后的 `drainQueue` 发出去 —— 没有任何东西丢失,不值得打扰用户。
 */
function syncInterject(sessionId: string): void {
  const store = stores.get(sessionId)
  if (!store) return
  const s = store.getState()
  const runId = s.activeRunId
  if (runId === null) return

  // ★ 用 `pickNextBatch` 而不是自己 filter:promoted 的取用顺序(promotedAt 升序、
  //   缺失时退化成入队序)只该有一个定义。但空闲态那条 pending 兜底在这里
  //   **必须排除** —— 那条兜底属于「run 结束后发下一条」,不属于插话。
  const items = pickNextBatch(s.queuedInputs)
    .filter((q) => q.status === 'promoted')
    .map((q) => ({ id: q.id, parts: batchToParts(mergeBatch([q])) }))
    .filter((item) => item.parts.length > 0)

  void interjectRun(runId, items).catch((err: unknown) => {
    console.error('[agent] 同步插话失败:', err)
  })
}

/**
 * 主进程确认注入之后,把对应条目移出队列。
 *
 * ★ **判据是「提交的用户消息 id 等于队列条目 id」** —— 注入时刻主进程复用了
 * 条目 id 当消息 id,正是为了让这个判据存在(见 `shared/agent/interject.ts`)。
 * 于是「恰好一次」不依赖任何新事件、任何新状态:
 * 收到 commit 才移出,没收到就还在队列里等 `drainQueue`。
 *
 * 重放同样安全:⌘R 之后 attach 把 `message_commit` 重发一遍,队列再收敛一次,
 * 而第二次是 no-op(条目早已不在)。
 */
function reapInjected(sessionId: string, events: readonly AgentEvent[]): void {
  const store = stores.get(sessionId)
  if (!store) return
  const s = store.getState()
  if (s.queuedInputs.length === 0) return

  const committed = new Set(
    events
      .filter((e) => e.type === 'message_commit' && e.message.role === 'user')
      .map((e) => (e.type === 'message_commit' ? e.message.id : ''))
  )
  const next = s.queuedInputs.filter((q) => !committed.has(q.id))
  if (next.length === s.queuedInputs.length) return

  store.setState({ queuedInputs: next })
  persistInput(sessionId, true)
}

// ═══════════════════════════════════════════════════════════════
// 持久化 —— 未发出的输入是全应用唯一没有第二份副本的数据(设计 §8)
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 已发出的内容在转录里有据可查,**只有未发出的输入是唯一副本** ——
 * 进程一死就永久消失,用户连「我刚才写了什么」都无从追溯。
 */
function persistInput(sessionId: string, immediate: boolean): void {
  const store = stores.get(sessionId)
  if (!store) return
  const s = store.getState()
  persistSessionInput(
    sessionId,
    {
      v: SESSION_INPUT_VERSION,
      draft: s.draft,
      // 只落非终态 —— 终态条目本就已经移出数组,这层过滤是对不变式的兜底
      queued: s.queuedInputs.filter(isLive),
      savedAt: Date.now()
    },
    immediate
  )
}

/** 已发起过 hydrate 的会话。重复调用是无害的,但白费一次 IPC */
const hydrated = new Set<string>()

/**
 * 回填草稿与队列。
 *
 * ★ **回填必须带守卫**:IPC 往返期间用户可能已经打字或已经发送了。
 * 无条件 `setState` 会用旧快照盖掉刚敲进去的内容 —— 这是持久化最常见的翻车方式。
 * 同 `tabs.ts` 那条 `persisted.tabs.length > 0` 守卫的精神。
 *
 * ★ **恢复后不自动续跑**:即便队列非空且空闲,也不调 `drainQueue` ——
 * 用户重启应用时绝不期待它自己开始发消息。进程死亡本质上就是一次异常中断,
 * 与 aborted 同等对待,由界面上的「继续执行」交还给用户。
 */
async function hydrateInput(sessionId: string): Promise<void> {
  try {
    const saved = await getSessionInput(sessionId)
    if (saved === null) return

    const store = stores.get(sessionId)
    if (!store) return
    const s = store.getState()
    if (s.draft !== '' || s.queuedInputs.length > 0 || s.activeRunId !== null) return

    store.setState({ draft: saved.draft, queuedInputs: saved.queued })
  } catch (err) {
    // 回填失败不该拦住会话可用 —— 最坏结果是少一份草稿
    console.error('[agent] 恢复未发出的输入失败:', err)
  }
}

/**
 * 会话级(而非 run 级)的转录状态。
 *
 * ★ 每一处 `...emptyTranscript()` 都是在「只清本轮」,而这两张表和 `messages`
 * 一样是**整段对话**的属性 —— 漏带一处,症状是发下一条消息、或者重挂一次快照
 * 之后,上面所有历史轮次的用量读数**一起消失**,而当前这一轮是好的。
 * 抽成函数就是不想在三个地方各记一次。
 */
function conversationScoped(t: TranscriptState): Pick<TranscriptState, 'runUsage' | 'messageRuns' | 'lastInputTokens'> {
  return {
    ...(t.runUsage === undefined ? {} : { runUsage: t.runUsage }),
    ...(t.messageRuns === undefined ? {} : { messageRuns: t.messageRuns }),
    // 上下文占用是**整段对话**的属性:新一轮还没发出请求之前,
    // 圆环该继续显示上一轮结束时的读数,而不是空着。
    ...(t.lastInputTokens === undefined ? {} : { lastInputTokens: t.lastInputTokens })
  }
}

/** 重启后从 SQLite 回填已提交消息；流式 run 期间只合并缺少的 id。 */
async function hydrateHistory(sessionId: string, authoritative = false): Promise<void> {
  try {
    const detail = await getSession(sessionId)
    const store = stores.get(sessionId)
    if (!store) return
    store.setState((s) => {
      // IPC 往返期间可能刚好启动了新的 run；不要用旧数据库快照覆盖
      // 正在流式显示的内容。
      if (s.activeRunId !== null
        || [...runIndex.values()].some((r) => r.sessionId === sessionId)
        || [...childRunIndex.values()].some((r) => r.sessionId === sessionId)) return s

      const databaseIds = new Set(detail.messages.map((m) => m.id))
      // 正常情况下当前 renderer 消息都已经先于事件写入数据库；这里只
      // 追加极短竞态窗口里尚未返回的本地消息，并且始终把数据库的
      // `ordinal` 顺序放在前面，绝不按 createdAt 重新排序。
      const localOnly = authoritative
        ? []
        : s.transcript.messages.filter((m) => !databaseIds.has(m.id))
      const messages = [...detail.messages, ...localOnly]
      return {
        ...s,
        transcript: {
          ...s.transcript,
          messages,
          live: [],
          tools: toolsFromMessages(messages, s.transcript.tools),
          subagents: subagentsFromMessages(messages, s.transcript.subagents),
          contextCheckpoints: detail.contextCheckpoints ?? s.transcript.contextCheckpoints,
          // 重启之后逐轮用量的唯一来源。内存里那份 `usage` 只说得清当前 run,
          // 这两张表说的是整段对话的账,来自 SQLite。
          runUsage: detail.runUsage ?? s.transcript.runUsage,
          messageRuns: detail.messageRuns ?? s.transcript.messageRuns,
          status: 'done',
          runStartedAt: undefined,
          runEndedAt: undefined
        }
      }
    })
  } catch (err) {
    // 新 Tab 可能还没有主进程会话记录；真正发送时 runtime 会补齐。
    if (err instanceof Error && /会话不存在|不存在该会话|session.*not found/i.test(err.message)) {
      const store = stores.get(sessionId)
      store?.setState((s) => {
        if (s.activeRunId !== null
          || [...runIndex.values()].some((r) => r.sessionId === sessionId)
          || [...childRunIndex.values()].some((r) => r.sessionId === sessionId)) return s
        return {
          ...s,
          transcript: {
            ...s.transcript,
            messages: [],
            live: [],
            tools: {},
            subagents: {},
            status: 'done',
            error: undefined,
            usage: undefined,
            contextUsage: undefined,
            runStartedAt: undefined,
            runEndedAt: undefined
          }
        }
      })
    } else {
      console.error('[agent] 加载会话历史失败:', err)
    }
  }
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
    const active = [...runIndex.values()].find((run) => run.sessionId === sessionId)
    if (active !== undefined) {
      s.setState({ activeRunId: active.runId })
      void ensureActiveRunRestored(sessionId, active.runId)
    }
  }
  if (!hydrated.has(sessionId)) {
    hydrated.add(sessionId)
    void hydrateInput(sessionId)
    void hydrateHistory(sessionId)
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
  for (const r of childRunIndex.values()) if (r.sessionId === sessionId) return false
  const deleted = stores.delete(sessionId)
  if (deleted) hydrated.delete(sessionId)
  return deleted
}

/**
 * 草稿 Tab 铸出真 sessionId 那一刻,把它在渲染层的家当搬过去。
 *
 * ★ **搬的是草稿文本,而这不是整洁癖。** 触发绑定的两件事之一是「贴第一个附件」,
 * 而绑定会改 `tab.ref.sessionId` → `views/registry.tsx` 的 key 跟着 `chatKey` 变
 * → ChatView 整棵子树重挂,输入框从新键的 store 里取 draft。不搬的话,用户
 * 刚打的半句话会在贴图那一瞬间凭空消失,而屏幕上没有任何东西解释发生了什么。
 *
 * 队列不用搬:草稿没有 run,`send` 在空闲态直接发,`queuedInputs` 必然是空的。
 *
 * ★ 旧存档要**立即**清(`immediate = true`)。留着的话,下一个恰好复用这个 tabId
 * 的草稿(重启后 Tab id 是从盘里读回来的,它会一直是同一个)会把这段文字捡回来,
 * 表现是一张本该干净的白纸上莫名其妙有半句上辈子的话。
 */
export function adoptDraftSession(draftKey: string, sessionId: string): void {
  if (draftKey === sessionId) return
  const draftStore = stores.get(draftKey)
  const draft = draftStore?.getState().draft ?? ''
  if (draft !== '') sessionStore(sessionId).setState({ draft })
  persistSessionInput(draftKey, { v: SESSION_INPUT_VERSION, draft: '', queued: [], savedAt: Date.now() }, true)
  releaseSession(draftKey)
}

/**
 * 主进程完成导入、恢复或清理后广播 `sessions:changed` 时调用。
 * 侧边栏列表会重新加载，但已经打开的 Tab 也必须同步数据库，否则
 * 删除历史后仍会继续显示旧 transcript。
 */
export async function refreshHydratedSessions(): Promise<void> {
  const ids = [...stores.keys()]
  await Promise.all(ids.map(async (sessionId) => {
    if ([...runIndex.values()].some((r) => r.sessionId === sessionId)) return
    await hydrateHistory(sessionId, true)
  }))
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
/** Child run id → the parent session that owns the Task card. */
const childRunIndex = new Map<string, RunIndexEntry>()

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

function rememberChildRuns(
  parentRunId: string,
  events: readonly AgentEvent[],
  owner?: RunIndexEntry
): void {
  const parent = runIndex.get(parentRunId) ?? owner
  if (parent === undefined) return
  for (const event of events) {
    if (event.type !== 'subagent_start') continue
    childRunIndex.set(event.childRunId, {
      runId: event.childRunId,
      sessionId: parent.sessionId,
      workspaceId: parent.workspaceId
    })
  }
}

/**
 * 首屏把主进程还活着的 run 补回索引(`Bootstrap.activeRuns`)。
 * 冷启动是空的 —— 「永不恢复运行中状态」(方案 §9);非空只发生在 ⌘R 重载:
 * 主进程没重启,run 还在跑,而渲染层刚刚失忆。
 */
export function adoptActiveRuns(runs: readonly RunIndexEntry[]): void {
  for (const r of runs) {
    runIndex.set(r.runId, r)
    const store = stores.get(r.sessionId)
    if (store !== undefined && store.getState().activeRunId === null) {
      store.setState({ activeRunId: r.runId })
      void ensureActiveRunRestored(r.sessionId, r.runId)
    }
  }
  publishRunIndex()
}

export interface ActiveSubagentIndexEntry {
  runId: string
  parentRunId: string
  sessionId: string
  workspaceId: string
  status?: 'running' | 'done' | 'error' | 'aborted'
  startedAt?: number
}

/**
 * Restore child-topic routing after a renderer reload. Top-level active runs
 * are restored by `adoptActiveRuns`; this separate index deliberately does
 * not feed the running indicators because a child is not a conversation run.
 */
export function adoptActiveSubagents(entries: readonly ActiveSubagentIndexEntry[]): void {
  const detachedParents = new Map<string, ActiveSubagentIndexEntry>()
  for (const entry of entries) {
    childRunIndex.set(entry.runId, {
      runId: entry.runId,
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId
    })
    if (!runIndex.has(entry.parentRunId)) detachedParents.set(entry.parentRunId, entry)
  }

  // A parent that is still running will be restored by adoptActiveRuns once
  // its lazy session store is opened. Only ended parents need a detached
  // attach here so their Task card can be reconstructed immediately.
  for (const [parentRunId, entry] of detachedParents) {
    const store = sessionStore(entry.sessionId)
    if (store.getState().activeRunId !== null) continue
    void restoreDetachedParent(entry.sessionId, parentRunId, entry).then(() => {
      const children = entries.filter((child) => child.parentRunId === parentRunId)
      return Promise.all(children.map((child) => restoreChildSnapshot(child)))
    })
  }

  // Active parents are restored by the normal run path. Wait for that attach
  // before replaying each child's own log, otherwise the parent Task card may
  // not exist yet and the child telemetry would have nowhere to land.
  for (const entry of entries) {
    if (!detachedParents.has(entry.parentRunId)) {
      sessionStore(entry.sessionId)
      void ensureActiveRunRestored(entry.sessionId, entry.parentRunId).then(() => restoreChildSnapshot(entry))
    }
  }
}

async function restoreChildSnapshot(entry: ActiveSubagentIndexEntry): Promise<void> {
  try {
    const store = stores.get(entry.sessionId)
    if (store === undefined) return
    const existing = Object.values(store.getState().transcript.subagents)
      .find((subagent) => subagent.childRunId === entry.runId)
    // Parent telemetry already records the last child event it observed. Ask
    // for only the tail after that cursor to avoid replaying the same tool
    // calls and token usage a second time after a reload.
    const sinceSeq = existing?.childSeq ?? 0
    const snap = await attachRun(entry.runId, sinceSeq)
    const firstSeq = snap.seq - snap.events.length + 1
    store.getState().applyChildEvents(entry.runId, snap.events, firstSeq)
    if (snap.status !== 'running') childRunIndex.delete(entry.runId)
  } catch (err) {
    // The child can finish and be reaped between bootstrap and this attach.
    // The live route remains useful if a final envelope is still delivered.
    console.warn(`[agent] child attach failed: ${entry.runId}`, err)
  }
}

async function restoreDetachedParent(
  sessionId: string,
  parentRunId: string,
  owner: ActiveSubagentIndexEntry
): Promise<void> {
  try {
    const detail = await getSession(sessionId).catch(() => undefined)
    const snap = await attachRun(parentRunId, 0)
    const store = stores.get(sessionId)
    if (store === undefined) return
    store.setState((s) => {
      // A user may have started a new turn while the detached snapshot was in
      // flight. Preserve that live turn rather than replacing it with old data.
      if (s.activeRunId !== null) return s
      const base = {
        ...emptyTranscript(),
        messages: s.transcript.messages,
        tools: s.transcript.tools,
        subagents: s.transcript.subagents,
        ...conversationScoped(s.transcript)
      }
      const transcript = applyEvents(base, snap.events)
      const messages = [...new Map([...(detail?.messages ?? []), ...transcript.messages]
        .map((m) => [m.id, m])).values()]
      return {
        transcript: {
          ...transcript,
          messages,
          tools: { ...transcript.tools, ...toolsFromMessages(messages, transcript.tools) },
          subagents: subagentsFromMessages(messages, transcript.subagents),
          ...(snap.startedAt === undefined ? {} : { runStartedAt: snap.startedAt }),
          ...(snap.endedAt === undefined ? {} : { runEndedAt: snap.endedAt })
        },
        lastSeq: snap.seq,
        activeRunId: null
      }
    })
    rememberChildRuns(parentRunId, snap.events, {
      runId: parentRunId,
      sessionId: owner.sessionId,
      workspaceId: owner.workspaceId
    })
  } catch (err) {
    // The child may finish and be reaped between bootstrap and this attach.
    // Its persisted parent history remains usable; leave the route in place
    // until the next child envelope tells us it has ended.
    console.warn(`[agent] detached parent attach failed: ${parentRunId}`, err)
  }
}

/**
 * 补齐:拿快照重建,而不是试图往回补那几条。
 *
 * ★ 重放出来的 seq **可能不连续**(主进程在 message_commit 处裁掉了被取代的 delta),
 * 所以这里绝不能对 snapshot.events 再跑一遍 gap 检查 —— 直接应用,
 * 然后把 lastSeq 置成 snapshot.seq。对它再查一次连续性会导致无限 resync。
 */
async function restoreActiveRun(sessionId: string, runId: string): Promise<void> {
  const detail = await getSession(sessionId).catch(() => undefined)
  await resync(sessionId, runId, 0, detail?.messages)
}

const restoreInFlight = new Map<string, Promise<void>>()

function ensureActiveRunRestored(sessionId: string, runId: string): Promise<void> {
  const existing = restoreInFlight.get(runId)
  if (existing !== undefined) return existing
  const pending = restoreActiveRun(sessionId, runId).finally(() => {
    if (restoreInFlight.get(runId) === pending) restoreInFlight.delete(runId)
  })
  restoreInFlight.set(runId, pending)
  return pending
}

async function resync(sessionId: string, runId: string, sinceSeq: number, history?: AgentMessage[]): Promise<void> {
  const store = stores.get(sessionId)
  if (!store) return
  console.warn(`[agent] seq 不连续,attach 补齐 · run=${runId} since=${sinceSeq}`)
  try {
    const snap = await attachRun(runId, sinceSeq)
    const current = store.getState()
    if (current.activeRunId !== runId) return
    // An incremental snapshot may overlap events received while attach was in
    // flight. Ask again from the new cursor instead of counting usage twice.
    if (sinceSeq !== 0 && current.lastSeq > sinceSeq && current.lastSeq < snap.seq) {
      await resync(sessionId, runId, current.lastSeq, history)
      return
    }
    store.setState((s) => {
      if (s.activeRunId !== runId) return s
      const base = sinceSeq === 0
        ? {
            ...emptyTranscript(),
            messages: s.transcript.messages,
            tools: s.transcript.tools,
            subagents: s.transcript.subagents,
            ...conversationScoped(s.transcript),
            ...(s.transcript.runStartedAt === undefined ? {} : { runStartedAt: s.transcript.runStartedAt })
          }
        : s.transcript
      const transcript = s.lastSeq >= snap.seq ? s.transcript : applyEvents(base, snap.events)
      const messages = [...new Map([...(history ?? []), ...transcript.messages].map((m) => [m.id, m])).values()]
      return {
        transcript: {
          ...transcript, messages,
          tools: { ...transcript.tools, ...toolsFromMessages(messages, transcript.tools) },
          subagents: subagentsFromMessages(messages, transcript.subagents),
          ...(transcript.runStartedAt === undefined && snap.startedAt !== undefined
            ? { runStartedAt: snap.startedAt }
            : {}),
          ...(snap.endedAt !== undefined ? { runEndedAt: snap.endedAt } : {})
        },
        lastSeq: Math.max(s.lastSeq, snap.seq),
        activeRunId: snap.status === 'running' ? runId : null
      }
    })
    rememberChildRuns(runId, snap.events)
    reapInjected(sessionId, snap.events)
    if (snap.status !== 'running') unregisterRun(runId)
    // ★ 重载后主进程的信箱仍然是对的(它没死),但**这个渲染层的队列刚从
    //   kv 里回填出来**,两边可能已经不一致(重载前那一瞬间的取消/编辑)。
    //   重发一次当前全集,让主进程以渲染层为准 —— 全量替换语义在这里第二次
    //   还本:恢复路径不需要任何专门的对账逻辑。
    else syncInterject(sessionId)
    if (snap.status === 'done') drainQueue(sessionId)
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
    const child = childRunIndex.get(env.runId)
    if (child !== undefined) {
      const firstSeq = env.seq - env.events.length + 1
      stores.get(child.sessionId)?.getState().applyChildEvents(env.runId, env.events, firstSeq)
      if (env.events.some((event) => event.type === 'run_end')) childRunIndex.delete(env.runId)
      continue
    }
    const sessionId = runIndex.get(env.runId)?.sessionId
    if (sessionId === undefined) continue
    rememberChildRuns(env.runId, env.events)
    stores.get(sessionId)?.getState().applyEnvelope(env)
  }
}
