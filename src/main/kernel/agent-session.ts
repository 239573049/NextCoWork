/**
 * AgentSession —— think → tool → observe 循环(方案 §4.8)。
 *
 * 这是「我们自己拥有这个循环」那个决定的兑现处(见方案 Context)。约 300 行,
 * 换来的是权限过滤、会话模式、子代理、中断收尾都真的归我们管。
 *
 * ★ 零 electron import,也**零时钟读取** —— `now` 一律走 `host.clock`。
 * 所以整个循环能在普通 vitest 里跑完,不启动 Electron、不联网、不看真时间。
 *
 * ★ session **不重试、不做故障切换**(方案 §5.3):那两件事在 `UpstreamRouter` 里。
 * 放在这里会重放已经执行过的工具调用 —— 一次「重试」把文件写两遍。
 */
import type { AgentError } from '../../shared/agent/error'
import { agentError } from '../../shared/agent/error'
import type { AgentMessage, ContentPart, ToolOutput } from '../../shared/agent/message'
import {
  assistantMessage,
  MAX_TOOL_OUTPUT_CHARS,
  orphanedToolCalls,
  toolResultMessage,
  truncateToolOutput,
  userMessage
} from '../../shared/agent/message'
import type { PermissionDecision } from '../../shared/agent/permission'
import type { RunRequest } from '../../shared/agent/run-request'
import { maxTurnsFor } from '../../shared/agent/run-request'
import type { ProviderStreamEvent, StopReason } from '../../shared/agent/stream'
import type { ToolInfo, ToolResult } from '../../shared/agent/tool'
import type { ModelAlias } from '../../shared/domain/provider'
import type { Skill } from '../../shared/domain/skill'
import { ulid } from '../../shared/util/id'
import { isAbortError } from './abort'
import { BlockAccumulator, type PendingCall } from './block-accumulator'
import { assemble } from './context-assembler'
import type { KernelHost } from './host'
import type { RunHandle } from './run-registry'
import type { SpawnSubagentFn, Tool, ToolContext, ToolRegistry } from './tool/registry'
import type { CanonicalRequest } from './upstream/canonical'

/**
 * session 需要上游的**全部**能力 —— 就这两个方法。
 *
 * ★ 刻意不写成 `UpstreamRouter` 类型:`UpstreamRouter` 结构上满足它,
 * 所以单测传一个十几行的假上游就能跑完整个循环,不必搭出供应商、凭证、健康表。
 * 这个窄口子是「无头 vitest 是后续每一步的回归网」(方案 §12 步骤 4)成立的前提。
 */
export interface SessionUpstream {
  stream(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>
  listModels(): ModelAlias[]
}

/**
 * 工具审批的接缝(方案 §4.5 / §4.6)。步骤 5 把 PermissionGate + InteractionGate
 * 接到这里;在那之前默认放行。
 *
 * 单个对象入参是为了以后加字段不改调用方 —— 步骤 5 要用它拼出
 * `PendingInteraction`,而那个形状需要 runId / callId / 工具元数据全套。
 */
export type ApproveFn = (req: {
  runId: string
  callId: string
  tool: Tool
  input: unknown
  signal: AbortSignal
}) => Promise<PermissionDecision>

export interface SessionDeps {
  host: KernelHost
  upstream: SessionUpstream
  tools: ToolRegistry
  workspaceRoot: string
  /**
   * 已有的转录。**session 不负责持久化** —— 它只把结果留在 `history` 里,
   * 由调用方决定写不写盘。步骤 6 的 SQLite 就接在这个缝上。
   */
  history?: readonly AgentMessage[]
  skills?: readonly Skill[]
  approve?: ApproveFn
  /**
   * 收窄本轮工具快照的**额外**闸门。
   *
   * ★ plan 模式的 `readOnlyOnly` **不走这里** —— 那是模式的定义,不是配置。
   * 这条缝只接一种来源:子代理定义文件里的 `tools:`(已归一化成 internalId)。
   * 缺省 = 不收窄。
   *
   * `snapshot()` 结构上只过滤、不新增,所以这个清单**永远不可能提权**:
   * 写一个不存在的名字进去,结果是少一个工具,不是多一个。
   */
  allowedTools?: readonly string[]
  /**
   * 子代理的角色提示词。★ **追加**在 `BASE_PROMPT` 之后,不替换它 ——
   * 换掉基础提示词的子代理会丢掉「被拒绝时不要试图绕开」那一类约束,
   * 而一个会绕开约束的子代理正是这整套权限设计最不想要的东西。
   */
  agentPrompt?: string
  /** 派子代理。缺省 = 这个环境里派不了(纯内核测试),`Task` 会当场说清楚。 */
  spawnSubagent?: SpawnSubagentFn
}

/** 别名表里查不到模型时的兜底。理由见 `aliasFor`。 */
const FALLBACK_CONTEXT_WINDOW = 200_000
const FALLBACK_MAX_OUTPUT = 8192

const INTERRUPTED = '[interrupted: the user stopped the run before this tool call finished]'

/** 工具执行期间的异常收敛(中断除外)。`defineTool` 已经做过一遍,但 MCP 工具是直接注册的。 */
function toolThrewError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

function toRunError(err: unknown): AgentError {
  if (isAbortError(err)) return agentError('aborted', '已中断')
  return agentError('unknown', err instanceof Error ? err.message : String(err))
}

export class AgentSession {
  private readonly messages: AgentMessage[]
  /**
   * ★ 当前轮次正在累积的块。中断时**唯一**能把半截回复救回来的东西 ——
   * 用户已经在屏幕上读到的字,不能因为他点了停止就凭空消失。
   */
  private pending: BlockAccumulator | null = null

  constructor(
    private readonly deps: SessionDeps,
    private readonly handle: RunHandle,
    private readonly req: RunRequest
  ) {
    this.messages = [...(deps.history ?? [])]
    // 空 input = 续跑(排队消息之外的场景,见 RunRequest.input)
    if (req.input.length > 0) {
      const now = deps.host.clock.now()
      /**
       * ★ 走 `commit` 而不是 `messages.push` —— 用户自己发的那条也要**发出去**。
       *
       * 只 push 的话它就只存在于主进程:渲染层的转录是事件流的投影,
       * 没有这条 commit,用户按下回车后自己的消息永远不出现在对话里。
       * 渲染层可以自己补一条,但那样同一条消息就有两个 id(一个渲染层 mint 的、
       * 一个主进程 mint 的),而步骤 6 落盘的是主进程那个 —— 重载之后会看到两条。
       *
       * 这里 emit 得到的时机是安全的:`startRun` 先建 handle 与泵、再调驱动,
       * 构造函数跑到这一行时事件已经有人接了。
       */
      this.commit(userMessage(ulid(now), [...req.input], now))
    }
  }

  /** 跑完之后的完整转录。调用方据此落盘。 */
  get history(): readonly AgentMessage[] {
    return this.messages
  }

  /**
   * ★ **不抛异常**。run 的结局一律经 `handle.finish` 表达 ——
   * 一个逃出去的异常会变成「run 无声消失」:UI 上转圈不停,而日志里只有一行栈。
   */
  async run(): Promise<void> {
    try {
      await this.loop()
    } catch (err) {
      /**
       * `handle.signal.aborted` 是 `isAbortError` 之外的第二道判断:工具或上游
       * 可能在中断时抛出一个**不像 AbortError 的**错误(比如 undici 把它包成
       * `TypeError: fetch failed`)。用户点了停止,就不该看到一个错误弹窗。
       */
      if (isAbortError(err) || this.handle.signal.aborted) {
        this.finalizeAbort()
        return
      }
      this.deps.host.logger.error('[session] run 失败', err)
      this.handle.finish('error', toRunError(err))
    }
  }

  // ─────────────────────────── 主循环 ───────────────────────────

  private async loop(): Promise<void> {
    const maxTurns = maxTurnsFor(this.req.mode)

    for (let turn = 0; turn < maxTurns; turn++) {
      const outcome = await this.turn()
      if (outcome === null) return // 这一轮已经把 run 收尾了
      await this.executeAll(outcome.calls, outcome.tools)
    }

    /**
     * 轮次耗尽。**不伪造一条「我做完了」的助手消息** —— 那会让用户以为
     * 模型给出了结论,而实际上它只是被我们掐断了。转录停在最后一条工具结果上,
     * 用户再发一条消息就能接着跑。
     */
    this.handle.finish(
      'error',
      agentError('unknown', `已达到最大轮次上限(${maxTurns} 轮),运行已停止。`)
    )
  }

  /**
   * 一轮:组装 → 请求 → 拼块 → 提交助手消息。
   *
   * 返回 null 表示 run 已经结束(正常收尾或出错);否则返回待执行的工具调用
   * 与**本轮下发给模型的那份工具快照**。
   */
  private async turn(): Promise<{ calls: PendingCall[]; tools: Map<string, Tool> } | null> {
    /**
     * ★ 每轮取一次快照(方案 §4.4)。同一份快照有两个用途:下发给模型的
     * 工具列表,和稍后按名字找回工具 —— 必须是同一份,否则会出现
     * 「下发的列表里有,执行时却找不到」的错位。
     */
    const advertised = this.deps.tools.snapshot({
      // ★ plan 模式的**真正实现**:过滤掉写工具,而不是在提示词里祈祷(§4.8)
      readOnlyOnly: this.req.mode === 'plan',
      /*
        子代理定义文件里的 `tools:`。★ 和上面那行是**两个不同的问题**,
        所以是两个字段而不是一个合并后的清单:`readOnlyOnly` 是模式的定义
        (plan 就是不写盘),`allowList` 是这个子代理被授予了什么。
        两个都在时取交集 —— 一个 plan 模式下的子代理仍然只能读。
      */
      ...(this.deps.allowedTools !== undefined ? { allowList: this.deps.allowedTools } : {}),
      /*
        ★ Composer 上那颗「联网搜索」药丸第一次真的控制住东西的地方。
        关掉时联网工具连下发都不下发,模型不会先白跑一轮再被拒。
      */
      network: this.req.webSearch
    })
    const byName = new Map(advertised.map((t) => [t.externalName, t]))
    // `execute` 是闭包,过不了结构化克隆 —— 请求体里不该带着它
    const infos: ToolInfo[] = advertised.map(({ execute: _execute, ...info }) => info)

    const alias = this.aliasFor(this.req.model)
    const { request, usage } = assemble({
      messages: this.messages,
      tools: infos,
      skills: this.deps.skills ?? [],
      ...(this.deps.agentPrompt !== undefined ? { agentPrompt: this.deps.agentPrompt } : {}),
      mode: this.req.mode,
      thinking: this.req.thinking,
      model: this.req.model,
      workspaceRoot: this.deps.workspaceRoot,
      now: this.deps.host.clock.now(),
      contextWindow: alias?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: alias?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT,
      supportsThinking: alias?.capabilities.thinking ?? false
    })

    // ★ 在**请求发出前**发,不在收到响应后发 —— 压力条要在这一轮真的挤爆之前
    // 就让用户看见(方案 §4.12)。
    this.handle.emit({ type: 'context_usage', ...usage })

    const acc = new BlockAccumulator()
    this.pending = acc
    let stopReason: StopReason = 'end_turn'
    let streamError: AgentError | undefined

    for await (const ev of this.deps.upstream.stream(request, this.handle.signal)) {
      this.handle.emit({ type: 'stream', delta: ev })
      acc.apply(ev)
      if (ev.type === 'message_end') stopReason = ev.stopReason
      // 路由器把总失败表达成一个**终止事件**而不是异常(见 router.stream),
      // 所以这里是正常的循环出口,不是 catch。
      else if (ev.type === 'error') streamError = ev.error
    }
    this.pending = null

    const { parts, calls } = acc.finalize()
    /**
     * ★ error part 也进转录。它只属于 UI 那一轨 —— encode/anthropic.ts 的
     * `toBlock` 对它返回 null,所以下一轮上行时会被丢掉,不会让模型
     * 开始为我们的 bug 道歉。而重载后 `attach` 回来的转录里,
     * 失败仍然看得见,不是一个消失了的 toast。
     */
    if (streamError !== undefined) parts.push({ type: 'error', error: streamError })
    this.commitAssistant(parts)

    if (streamError !== undefined) {
      this.handle.finish('error', streamError)
      return null
    }

    /**
     * `tool_use` 却一个可执行的调用都没有:所有 tool_call 块都没闭合
     * (流被掐断)。继续循环会**原样重发一次同样的请求** —— 大概率再来一次。
     * 收尾比空转诚实。
     */
    if (stopReason !== 'tool_use' || calls.length === 0) {
      if (stopReason === 'tool_use') {
        this.deps.host.logger.warn('[session] stopReason=tool_use 但没有已闭合的工具调用')
      }
      this.handle.finish('done')
      return null
    }

    return { calls, tools: byName }
  }

  // ─────────────────────────── 工具执行 ───────────────────────────

  /**
   * 串行执行本轮的全部工具调用(v1 不并行,方案 §10),结果合成**一条** user 消息。
   */
  private async executeAll(calls: PendingCall[], tools: Map<string, Tool>): Promise<void> {
    const parts: ContentPart[] = []
    try {
      for (const call of calls) {
        parts.push(await this.executeOne(call, tools))
      }
    } finally {
      /**
       * ★ `finally` 而不是只在成功路径上提交:中断发生在第 2 个工具执行途中时,
       * 第 1 个**已经真的做完了**。不在这里落进转录,它就会在收尾时被
       * `orphanedToolCalls` 当成孤儿补上一条「已中断」—— 做过的事被记成没做,
       * 而模型下一轮会据此重做一遍。
       */
      if (parts.length > 0) {
        const now = this.deps.host.clock.now()
        this.commit(toolResultMessage(ulid(now), parts, now))
      }
    }
  }

  private async executeOne(call: PendingCall, tools: Map<string, Tool>): Promise<ContentPart> {
    const { callId } = call

    if (!call.ok) {
      // 不去执行,把**原文**回给模型 —— 只说「参数错了」它无从下手
      return this.toolFailure(
        callId,
        `The tool arguments were not valid JSON (${call.reason}). This is what you sent:\n${call.raw}`
      )
    }

    const tool = tools.get(call.name)
    if (tool === undefined) {
      // 模型会编工具名;这一轮进行中工具也可能被下线。两种都是**工具错误**,不是崩溃。
      return this.toolFailure(
        callId,
        `There is no tool named ${call.name}. Pick one from the list of available tools.`
      )
    }

    // ★ 下发/回传/展示三处用的都是 externalName —— 三条轨道上必须是同一个名字,
    // 用户才能把审批弹窗、工具卡片和转录对上号。
    this.handle.emit({ type: 'tool_start', callId, toolName: tool.externalName, input: call.input })

    const decision = await this.approve(callId, tool, call.input)
    if (decision.kind === 'deny') {
      // 拒绝要让模型**看见**:系统提示词里写了「被拒绝时不要试图绕开」,
      // 而那句话的前提是它知道自己被拒了。
      return this.toolFailure(callId, decision.reason ?? 'The user denied this tool call.')
    }
    // allow_edited 的入参是用户改过的 —— 用原值执行等于无视用户的修改
    const input = decision.kind === 'allow_edited' ? decision.input : call.input

    let result: ToolResult
    try {
      result = await tool.execute(input, this.toolContext(callId))
    } catch (err) {
      /**
       * ★ 中断**原样抛出**,不伪装成工具失败(`define.test.ts` 钉住的契约)。
       * 伪装成失败的话,模型会看到「工具失败了」然后继续往下跑 ——
       * 用户点了停止,对话却还在动。
       */
      if (isAbortError(err)) throw err
      // 其余异常收敛成工具错误:`tool_failed` 进转录并继续循环(方案 §4.11)
      return this.toolFailure(callId, `Tool execution failed: ${toolThrewError(err)}`)
    }

    /**
     * 截断在**产出侧**(方案 §4.3)。这里不能直接 `truncateToolOutput(content)` ——
     * 内容没超限时它返回一个干净的 `{ content }`,会把工具自己标好的
     * `truncated` / `originalBytes` 抹掉(工具在更靠近数据的地方截断,标记更准)。
     */
    const output =
      result.output.content.length > MAX_TOOL_OUTPUT_CHARS
        ? truncateToolOutput(result.output.content)
        : result.output

    this.handle.emit({ type: 'tool_end', callId, output, isError: result.isError })
    return { type: 'tool_result', callId, output, isError: result.isError }
  }

  private toolContext(callId: string): ToolContext {
    return {
      workspaceRoot: this.deps.workspaceRoot,
      // ★ 必传:只断 SSE 不断工具,会留下一堆僵尸 shell 和还在写的文件(方案 §4.3)
      signal: this.handle.signal,
      permissionMode: this.req.permissionMode,
      depth: this.req.depth,
      callId,
      runId: this.req.runId,
      // ★ 递的是 deps.host 本身(结构上满足 ToolHost),不是拷贝出来的五个字段 ——
      //   拷贝会在换宿主后留下一份旧引用,正是 ctx 传递想避免的那件事
      host: this.deps.host,
      // 进度是易失的:单独的事件类型,永不写入转录
      emit: (progress) => this.handle.emit({ type: 'tool_progress', callId, progress }),
      /*
        ★ 没装启动器时**不放这个字段进去**,而不是放一个抛错的函数:
        `Task` 判的是 `ctx.spawnSubagent === undefined`,据此给出一句
        「这个环境里派不了子代理」的人话。放一个会抛的桩,模型看到的
        就变成一条内部错误信息了。
      */
      ...(this.deps.spawnSubagent !== undefined ? { spawnSubagent: this.deps.spawnSubagent } : {})
    }
  }

  private async approve(callId: string, tool: Tool, input: unknown): Promise<PermissionDecision> {
    if (this.deps.approve === undefined) return { kind: 'allow_once' }
    return this.deps.approve({
      runId: this.req.runId,
      callId,
      tool,
      input,
      signal: this.handle.signal
    })
  }

  /** 工具错误也要发 `tool_end`,否则 UI 上那张卡片会永远转圈 */
  private toolFailure(callId: string, message: string): ContentPart {
    const output: ToolOutput = { content: message }
    this.handle.emit({ type: 'tool_end', callId, output, isError: true })
    return { type: 'tool_result', callId, output, isError: true }
  }

  // ─────────────────────────── 中断收尾(方案 §4.8) ───────────────────────────

  /**
   * ★ 方案 §4.8 五件事里的**第 4 件**。前三件由 RunHandle.abort 与 InteractionGate 做,
   * 只有这一件必须在这里 —— 因为只有 session 知道转录长什么样。
   *
   * **漏掉它,下一轮请求就是 400**:Anthropic 要求每个 `tool_use` 都必须在紧随的
   * user 消息里有配对的 `tool_result`。而中断恰恰最容易在「工具已经开始、还没回来」
   * 的那一刻发生。报错会指向消息数组,看起来像 adapter 的 bug ——
   * 这是手写 Agent 循环最常见的自伤。
   */
  private finalizeAbort(): void {
    // 1) 半截回复。BlockAccumulator 会丢掉未闭合的 tool_call 块,
    //    所以这一步**不会**制造出新的孤儿。
    const acc = this.pending
    this.pending = null
    if (acc !== null) this.commitAssistant(acc.finalize().parts)

    // 2) 补 tool_result。此时剩下的孤儿只有一种:已闭合、已开始执行、没跑完的。
    const orphans = orphanedToolCalls(this.messages)
    if (orphans.length > 0) {
      const output: ToolOutput = { content: INTERRUPTED }
      const parts: ContentPart[] = orphans.map((o) => ({
        type: 'tool_result',
        callId: o.callId,
        output,
        isError: true
      }))
      for (const o of orphans) {
        // 没有这条,UI 上那张工具卡片会停在「执行中」直到下次重载
        this.handle.emit({ type: 'tool_end', callId: o.callId, output, isError: true })
      }
      const now = this.deps.host.clock.now()
      this.commit(toolResultMessage(ulid(now), parts, now))
    }

    this.handle.finish('aborted')
  }

  // ─────────────────────────── 小工具 ───────────────────────────

  /**
   * ★ 查不到别名时**不在这里报错**,用兜底参数照常组装。
   *
   * 让 `UpstreamRouter` 的 `noCandidateError` 成为唯一的权威错误:它分得清
   * 「没有配置这个别名」「所有供应商都在冷却中」「没有已启用的供应商」,
   * 而 session 只知道「表里没有」。两处都报的话,用户会随机收到信息量少的那一条。
   */
  private aliasFor(model: string): ModelAlias | undefined {
    return this.deps.upstream.listModels().find((m) => m.alias === model)
  }

  private commitAssistant(parts: ContentPart[]): void {
    // 空 parts 的消息会被上游拒绝(`all messages must have non-empty content`),
    // 而中断在第一个 delta 之前发生时它就是空的。
    if (parts.length === 0) return
    const now = this.deps.host.clock.now()
    this.commit(assistantMessage(ulid(now), parts, now))
  }

  /** 落盘边界(方案 §4.2):也是 RunRegistry 裁剪冗余 delta 的那个点 */
  private commit(message: AgentMessage): void {
    this.messages.push(message)
    this.handle.emit({ type: 'message_commit', message })
  }
}
