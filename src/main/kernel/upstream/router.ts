/**
 * UpstreamRouter —— 方案 §5.1 的中枢:**归一化与治理是一个纯模块**,
 * 内核在进程内直接调它,HTTP 网关(步骤 13)只是同一个模块上的一层薄协议壳。
 *
 * 天真的做法是内核有自己的 provider 抽象、网关另写一套协议转换 —— 那就有
 * 两份停止原因映射、两份工具定义互转、两份 SSE 解析,并且它们会**缓慢地不一致**。
 *
 * ★ 这个文件里最重要的一行是 `sawContent` 的那个判断,见 §5.3。
 */
import type { AgentError } from '../../../shared/agent/error'
import { agentError } from '../../../shared/agent/error'
import { bearerOf } from '../../../shared/domain/credential'
import { CredentialAuthError, CredentialResolver } from './credential-resolver'
import type { ProviderStreamEvent, StopReason, TokenUsage } from '../../../shared/agent/stream'
import type { ResolvedModelThinking } from '../../../shared/domain/model-runtime'
import { resolveModelThinking } from '../../../shared/domain/model-runtime'
import { modelBindingsFor } from '../../../shared/domain/model-selection'
import { REQUEST_PATH } from '../../../shared/domain/baseurl'
import type { ModelAlias, ProviderHealth, ThinkingConfig, UpstreamProvider, UpstreamProtocol } from '../../../shared/domain/provider'
import { anthropicCacheTtlOf, effectiveModelProtocol } from '../../../shared/domain/provider'
import { applyRequestPatches, RequestPatchError } from '../../../shared/domain/request-patch'
import {
  applyThinkingAdapter,
  enforceThinkingPreference,
  ThinkingAdapterError,
  type ThinkingAdapterInput
} from '../../../shared/domain/thinking-adapter'
import { abortableSleep, isAbortError } from '../abort'
import { estimateTokens } from '../context-assembler'
import { userAgent } from '../user-agent'
import type { KernelHost } from '../host'
import type { UnpricedUsageAttempt } from '../../../shared/domain/usage'
import { ulid } from '../../../shared/util/id'
import {
  joinUpstreamUrl,
  type CanonicalRequest,
  type UpstreamRequestContext
} from './canonical'
import { anthropicErrorToAgentError } from './decode/anthropic'
import { interruptedResponse, openAIErrorToAgentError } from './decode/openai-common'
import { applyAnthropicRequestOptions } from './encode/anthropic'
import { decodeUpstream, encodeUpstream } from './codec'
import { upstreamTransport, authHeader } from './transport'
import { ImageInputError, prepareRequestImages } from './images'

/** 每个 provider 最多试几次(含首次)。第 3 次还不行,换下一个 provider 比继续磕更有用。 */
const MAX_ATTEMPTS = 3
/**
 * 纯连接层错误(fetch 本身抛出,比如 `net::ERR_HTTP2_PROTOCOL_ERROR`、DNS 失败、
 * 握手中断)不是「这家供应商不行」,是「这台机器这一刻连不上网」——换下一个 provider
 * 大概率也是同一个病因,真正管用的是**多等一会儿再碰**。所以给它比 `MAX_ATTEMPTS`
 * 更多的机会,而不是三次就判它「换家」或者干脆报错干瞪眼(方案 §4.2 的失败态本该
 * 是「明确没救了」,一次 HTTP2 协议错误显然算不上)。
 */
const MAX_NETWORK_ATTEMPTS = 6
const DEFAULT_BASE_DELAY_MS = 500
/**
 * 限流(429)专用的退避基数,和上面那个**刻意不是一个数**。
 *
 * ★★ 500ms 起步的指数退避对 5xx / 网络抖动是对的 —— 那类故障是瞬时的,退得越快
 * 恢复越快。**限流不是**:配额窗口是分钟级的,0.5s、1s 退回去只是再撞两次墙,
 * 三次机会两秒内用光,然后报一条「超出速率限制」——用户看到的是「重试根本没发生」。
 * 上游给了 `Retry-After` 就一切以它为准(见 `retryDelayFor`),这个数只在**没给**
 * 的时候兜底,而 Azure / 各家网关经常不给。
 */
const DEFAULT_RATE_LIMIT_FLOOR_MS = 4_000
/**
 * 退避的硬上限。`Retry-After: 3600` 是真会出现的(配额按小时重置),照着睡
 * 一小时和卡死没有区别 —— 截断到一分钟,让用户在状态行上看见还在退避,
 * 再由他决定要不要换一家或者停掉。
 */
const MAX_RETRY_DELAY_MS = 60_000
/** 连续失败到这个数就判不健康 */
const UNHEALTHY_AFTER = 3
const COOLDOWN_MS = 30_000
const ANTHROPIC_USER_ID_MAX = 512

/**
 * 配置来源。步骤 6 之后由 SQLite 提供,现在由内存 store 提供 ——
 * 路由器不关心它们从哪来,只关心「现在这一刻的配置是什么」。
 * 用函数而不是快照数组:设置页改完 provider 立刻生效,不必重建路由器。
 */
export interface ProviderConfigSource {
  providers(): readonly UpstreamProvider[]
  aliases(): readonly ModelAlias[]
  /** ★ 旁路开关落在路由器,不落在 HTTP 壳(方案 §5.6) */
  failoverEnabled(): boolean
}

interface Candidate {
  provider: UpstreamProvider
  alias: ModelAlias
}

function thinkingConfigFor(req: CanonicalRequest, c: Candidate, protocol: UpstreamProtocol): ThinkingConfig | undefined {
  if (c.alias.thinkingConfig !== undefined) return c.alias.thinkingConfig
  if (req.thinkingBudget !== undefined) return { mode: 'budget', defaultEnabled: true }
  if (req.reasoning?.explicit !== true || req.reasoning.enabled) return undefined
  // Old model imports defaulted capabilities.thinking to false and had no
  // ThinkingConfig. Known toggle protocols still support an explicit Off.
  if (protocol === 'anthropic'
    || /(?:^|\/)(?:deepseek|deep-seek|glm|chatglm|hy3|hy4)[/:._-]/iu.test(c.alias.upstreamModel)
    || c.alias.capabilities.thinking) return { mode: 'toggle', defaultEnabled: false }
  return undefined
}

function reasoningFor(req: CanonicalRequest, alias: ModelAlias): ResolvedModelThinking | undefined {
  if (req.thinkingLevel !== undefined && alias.thinkingConfig !== undefined) {
    return resolveModelThinking(req.thinkingLevel, alias.thinkingConfig,
      Math.min(req.maxOutputTokens, alias.maxOutputTokens), alias.reasoningEfforts)
  }
  if (req.reasoning !== undefined) return req.reasoning
  if (req.thinkingBudget === undefined || alias.thinkingConfig?.mode === 'unsupported') return undefined
  return {
    mode: alias.thinkingConfig?.mode ?? 'budget',
    enabled: true,
    explicit: true,
    budgetTokens: req.thinkingBudget
  }
}

/**
 * ★ 「第一个内容字节」的定义。
 *
 * `message_start` **不算** —— 它不携带任何内容,此时重试不会产生重复输出。
 * 从 text/thinking/tool_call/opaque 中任何一个开始,消费者手里就有了半条消息,
 * 换个 provider 重来就会出现重复文字和错位的工具调用。
 */
function isContent(e: ProviderStreamEvent): boolean {
  switch (e.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_call_start':
    case 'tool_call_delta':
    case 'tool_call_end':
    case 'block_opaque':
    case 'message_end':
      return true
    default:
      return false
  }
}

/**
 * `Retry-After` 可以是秒数,也可以是 HTTP 日期。
 *
 * ★ 尊重它不是礼貌问题:限流时按自己的退避表硬撞,只会让冷却期不断延长
 * (很多上游把「限流期间的请求」也计入配额)。
 */
export function parseRetryAfter(raw: string | null, now: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), 60_000)
  return undefined
}

/** 一次尝试的结局。generator 的返回值 —— 用 `yield*` 一句话拿到。 */
type Outcome =
  | { kind: 'ok' }
  /** 失败。`sawContent` 决定还能不能重试/切换 —— §5.3 那条边界 */
  | { kind: 'failed'; error: AgentError; sawContent: boolean }

export interface UpstreamRouterOptions {
  baseDelayMs?: number
  /** 限流退避的基数。见 `DEFAULT_RATE_LIMIT_FLOOR_MS`;测试压成 0 就不会真的睡。 */
  rateLimitFloorMs?: number
  /** Synchronous sink; failures are isolated so telemetry can never fail a request. */
  onUsageAttempt?: (record: UnpricedUsageAttempt) => void
  /**
   * 某条凭证被刷新(或被标成需要重新登录)了。
   *
   * ★ 内核拿不到窗口,所以这是**注入回调**,和上面 `onUsageAttempt` 同一个套路。
   * 设置页据此把「已登录」改成「登录已失效」—— 不推的话,用户要关掉再打开设置页
   * 才知道自己已经掉线了。
   */
  onCredentialChanged?: (credentialRef: string) => void
}

export class UpstreamRouter {
  private readonly healthMap = new Map<string, ProviderHealth>()
  /**
   * 「这一家在这个时刻之前别再发请求了」—— 被限流之后立起来的闸门。
   *
   * ★★ 它的价值**整个在于这个类是进程内单例**(`runtime.ts` 的 `getRouter()`):
   * 主代理和它派出去的每一个子代理共用同一个实例,于是任意一条流吃到 429,
   * 其余几条**在发请求之前**就会被挡住。没有它,四个并发子代理是各自独立退避的:
   * 同时撞、同时退、再同时撞,把本来够用的配额彼此打光,而每一条看到的都只是
   * 「我被限流了」,没有任何一条知道是自己人干的。
   *
   * ★ 只记 `rate_limit`。5xx / 网络错误是**这一条请求**的事,拿它去挡住别的流
   * 会把一次偶发抖动放大成全局停顿。
   */
  private readonly rateLimitGate = new Map<string, { until: number; reason: string }>()
  private readonly baseDelayMs: number
  private readonly rateLimitFloorMs: number
  private readonly onUsageAttempt: ((record: UnpricedUsageAttempt) => void) | undefined
  /**
   * ★ 在构造函数里自己建,**不作为必填参数** —— 于是 gateway 和现有全部测试里那些
   * `new UpstreamRouter(host, config)` 一行都不用改。
   */
  private readonly credentials: CredentialResolver

  constructor(
    private readonly host: KernelHost,
    private readonly config: ProviderConfigSource,
    opts: UpstreamRouterOptions = {}
  ) {
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.rateLimitFloorMs = opts.rateLimitFloorMs ?? DEFAULT_RATE_LIMIT_FLOOR_MS
    this.onUsageAttempt = opts.onUsageAttempt
    this.credentials = new CredentialResolver(host, opts.onCredentialChanged)
  }

  listModels(): ModelAlias[] {
    const enabled = new Set(
      this.config.providers().filter((p) => p.enabled).map((p) => p.id)
    )
    return this.config.aliases().filter((a) => enabled.has(a.providerId) && a.enabled !== false)
  }

  /**
   * 「这个别名 + 这个供应商」最终落在哪一条绑定上 —— 路由器之外的调用方
   * (`agent-session` 校验上下文、`session-title` 挑思考档、`runtime` 校验
   * 审核模型)都必须走这里,而不是自己 `listModels().find((m) => m.alias === x)`。
   *
   * ★ 自己 find 的话取的是数组第一条,而路由器取的是 priority 最小的那条 ——
   * 两者只是碰巧一致。分家之后的症状是:界面按 A 的上下文窗口做校验,
   * 请求却发给了 B,而且不报错。
   *
   * ★★ **不过健康冷却**(所以不复用 `candidates()`):它回答的是「这个选择指向
   * 哪一条绑定」,不是「现在该试谁」。冷却期内返回 undefined 会让上下文长度校验
   * 被静默跳过 —— 那是个只在供应商刚挂过之后才复现的幽灵 bug。
   */
  resolveModel(model: string, modelProviderId?: string): ModelAlias | undefined {
    return modelBindingsFor(
      this.config.aliases(), this.config.providers(), model, modelProviderId
    )[0]
  }

  health(): ProviderHealth[] {
    return [...this.healthMap.values()]
  }

  resetHealth(providerId?: string): void {
    if (providerId === undefined) {
      this.healthMap.clear()
      this.rateLimitGate.clear()
    } else {
      this.healthMap.delete(providerId)
      // 「重置健康状态」在用户眼里就是「当它没挂过,现在就重试」——
      // 留着限流闸门会让那一下点击看起来毫无反应(它会安静地睡满剩下的退避)。
      this.rateLimitGate.delete(providerId)
    }
  }

  /**
   * 候选集:同一个 alias 可能由多个 provider 提供 —— **这正是别名表存在的理由**,
   * 没有它就谈不上「切到下一个」。
   *
   * ★★ `modelProviderId` 有值 = 用户在药丸里**显式选了那一家**,这是一条**硬约束**:
   * 候选集被压到最多一条,于是下面那两层 for(换供应商 / 重试)天然只在这一家里
   * 打转,`provider_switch` 也永远不会发出来。**锁死语义整个由候选集表达**,
   * 不要去 `stream()` 里加 `if (pinned)` 分支 —— 那会造出第二个真相来源。
   */
  private candidates(model: string, modelProviderId?: string): Candidate[] {
    const byId = new Map(this.config.providers().map((p) => [p.id, p]))
    /*
      ★★ 收集与排序**整个借给** `model-selection.ts` —— 渲染层的药丸用的是同一个
      函数。这是整套设计的支点:药丸上显示的那家,和这里真正发请求的那家,由同一段
      代码算出。以前两边各写一遍(那边取数组第一条、这边按 priority 排),只是碰巧
      一致,一旦分家就是「界面说 A、请求发给 B」且不报任何错 —— 正是用户报的那个 bug。

      `modelProviderId` 有值 = 用户显式选了那一家,那边会把候选压到最多一条,
      于是下面两层 for(换供应商 / 重试)天然只在这一家里打转,`provider_switch`
      也永远不会发出来。**锁死语义整个由候选集表达**,不要去 `stream()` 里加
      `if (pinned)` 分支 —— 那会造出第二个真相来源。
    */
    const list: Candidate[] = modelBindingsFor(
      this.config.aliases(), this.config.providers(), model, modelProviderId
    ).map((alias) => ({ provider: byId.get(alias.providerId)!, alias }))

    // 旁路模式:直取优先级最高的一个,不做健康评分、不做切换。延迟最低、路径最短。
    // ★ `failoverEnabled` 出厂就是 false,所以这条短路才是绝大多数用户实际走的
    //   路径 —— provider 过滤必须发生在它**之前**(已经在上面那个函数里了)。
    if (!this.config.failoverEnabled()) return list.slice(0, 1)

    /*
      ★ 钉住时跳过冷却过滤。冷却的意义是「绕开一家坏的」,而锁死之后**无处可绕**:
      过滤掉唯一那条候选,用户会收到「所有供应商都在冷却中」—— 他明明只选了一家,
      而且界面上没有任何「再试一次」的入口,看起来就是应用坏了。
      `MAX_ATTEMPTS` 加指数退避已经护得住配额。健康分照常记(`recordFailure` 不动),
      设置页那个健康指示器仍然准确。
    */
    if (modelProviderId !== undefined) return list

    const now = this.host.clock.now()
    const usable = list.filter((c) => {
      const h = this.healthMap.get(c.provider.id)
      return h === undefined || h.cooldownUntil === undefined || h.cooldownUntil <= now
    })
    // 健康度只在同优先级内部起作用 —— 优先级是用户的显式意图,不该被评分推翻
    usable.sort((a, b) => {
      const d = a.provider.priority - b.provider.priority
      if (d !== 0) return d
      return (this.healthMap.get(b.provider.id)?.score ?? 1) - (this.healthMap.get(a.provider.id)?.score ?? 1)
    })
    return usable
  }

  private healthOf(id: string): ProviderHealth {
    let h = this.healthMap.get(id)
    if (!h) {
      h = { providerId: id, healthy: true, score: 1, consecutiveFailures: 0, lastCheckedAt: 0 }
      this.healthMap.set(id, h)
    }
    return h
  }

  private recordSuccess(id: string, latencyMs: number): void {
    const h = this.healthOf(id)
    h.healthy = true
    h.consecutiveFailures = 0
    // 恢复比衰减快,但要多次成功才回到 1 —— 一次侥幸成功不该抹掉刚才连挂三次的事实
    h.score = Math.min(1, h.score * 1.5 + 0.1)
    h.lastLatencyMs = latencyMs
    h.lastCheckedAt = this.host.clock.now()
    delete h.cooldownUntil
    delete h.lastError
    // 一次成功 = 配额确实回来了。留着闸门只会让后面那几条流白等一场。
    this.rateLimitGate.delete(id)
  }

  /**
   * 这次失败该退避多久。
   *
   * ★ 上游给了 `Retry-After` 就**只听它的**,不套下面那个下限:它知道配额窗口
   * 什么时候重置,我们不知道。(`retry-after: 0` 是合法的「立刻再来」,别抬成 4 秒。)
   */
  private retryDelayFor(err: AgentError, attempt: number): number {
    if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, MAX_RETRY_DELAY_MS)
    const base = err.code === 'rate_limit' ? this.rateLimitFloorMs : this.baseDelayMs
    return Math.min(base * 2 ** attempt, MAX_RETRY_DELAY_MS)
  }

  /** 闸门还剩多久;没被挡住就是 0。 */
  private gateWaitFor(providerId: string): { waitMs: number; reason: string } {
    const gate = this.rateLimitGate.get(providerId)
    if (gate === undefined) return { waitMs: 0, reason: '' }
    const waitMs = gate.until - this.host.clock.now()
    if (waitMs <= 0) {
      this.rateLimitGate.delete(providerId)
      return { waitMs: 0, reason: '' }
    }
    return { waitMs, reason: gate.reason }
  }

  private recordFailure(id: string, err: AgentError): void {
    const h = this.healthOf(id)
    h.consecutiveFailures += 1
    h.score = h.score * 0.5
    h.lastError = err.message
    h.lastCheckedAt = this.host.clock.now()
    if (h.consecutiveFailures >= UNHEALTHY_AFTER) {
      h.healthy = false
      h.cooldownUntil = this.host.clock.now() + COOLDOWN_MS
    }
  }

  /**
   * 一次 HTTP 尝试。yield 归一化事件,**返回**结局。
   *
   * 拆成独立 generator 是为了让上面那层的重试/切换逻辑能用一行 `yield*` 读完,
   * 而不是三层嵌套的 try/for/for。
   */
  private async *attempt(
    c: Candidate,
    req: CanonicalRequest,
    signal: AbortSignal,
    context: UpstreamRequestContext,
    attemptNumber: number
  ): AsyncGenerator<ProviderStreamEvent, Outcome> {
    let sawContent = false
    const protocol = effectiveModelProtocol(c.provider, c.alias)
    const startedAt = this.host.clock.now()
    const endpoint = joinUpstreamUrl(c.provider.baseUrl, REQUEST_PATH[protocol])
    let httpStatus: number | null = null
    let responseModel: string | null = null
    let stopReason: StopReason | null = null
    let timeToFirstTokenMs: number | null = null
    let thinkingText = ''
    let toolCalls = 0
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let recorded = false

    const finish = (outcome: Outcome): Outcome => {
      if (recorded) return outcome
      recorded = true
      const endedAt = this.host.clock.now()
      const explicitThinking = usage.reasoningTokens
      const rawThinkingEstimate =
        explicitThinking === undefined && thinkingText !== ''
          ? estimateTokens(thinkingText)
          : null
      // Reasoning is a subset of outputTokens. Text-based estimation can be
      // higher than the provider tokenizer, so never let the diagnostic
      // breakdown contradict the provider's billable output total.
      const estimatedThinking =
        rawThinkingEstimate === null
          ? null
          : usage.outputTokens > 0
            ? Math.min(rawThinkingEstimate, usage.outputTokens)
            : rawThinkingEstimate
      const error = outcome.kind === 'failed' ? outcome.error : null
      try {
        this.onUsageAttempt?.({
          id: ulid(endedAt),
          at: startedAt,
          runId: context.runId ?? `run_${ulid(startedAt)}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId ?? '',
          attempt: attemptNumber,
          providerId: c.provider.id,
          providerName: c.provider.name,
          protocol,
          endpoint,
          alias: req.model,
          upstreamModel: c.alias.upstreamModel,
          responseModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadInputTokens ?? 0,
          cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
          cacheWrite1hTokens: usage.cacheCreation1hInputTokens ?? 0,
          thinkingTokens: explicitThinking ?? estimatedThinking,
          thinkingTokensEstimated: explicitThinking === undefined && estimatedThinking !== null,
          latencyMs: Math.max(0, endedAt - startedAt),
          timeToFirstTokenMs,
          ok: outcome.kind === 'ok',
          httpStatus: httpStatus ?? error?.status ?? null,
          errorKind: error?.code ?? null,
          errorMessage: error?.message.slice(0, 4096) ?? null,
          stopReason,
          toolCalls,
          toolErrors: 0
        })
      } catch (error) {
        this.host.logger.warn('[usage] 写入请求记录失败，请求本身不受影响', error)
      }
      return outcome
    }

    try {
      signal.throwIfAborted()
      const cred = await this.credentials.resolve(c.provider.credentialRef, signal)
      if (cred === null) {
        return finish({
          kind: 'failed',
          sawContent,
          error: agentError('auth', `供应商「${c.provider.name}」还没有配置密钥`, { retryable: false })
        })
      }
      /*
        ★ 两种凭证在**鉴权头这一点上是同构的**:OAuth 的 access token 就是塞进
        `Authorization: Bearer` 的那个串,正是 `encodeOpenAIResponses` 已经在写的头。
        所以 `encodeUpstream` 的签名一个字不用改 —— OAuth 多出来的那些东西
        (账号头、body 强制字段)走 `transport`,在最终线上边界合并。
      */
      const apiKey = bearerOf(cred)
      const cacheTtl = anthropicCacheTtlOf(c.provider)
      const prepared = await prepareRequestImages(req, this.host, context, signal)
      const enc = encodeUpstream(protocol, prepared, c.alias.upstreamModel, apiKey, {
        userId: context.workspaceId,
        cacheTtl
      })
      const thinkingInput: ThinkingAdapterInput = {
        protocol,
        upstreamModel: c.alias.upstreamModel,
        config: thinkingConfigFor(req, c, protocol),
        reasoning: reasoningFor(req, c.alias),
        maxOutputTokens: req.maxOutputTokens,
        // Legacy bindings without a request adapter must retain automatic
        // model-specific thinking detection. Explicit adapters still win;
        // protocol remains the wire/protocol default for patch validation.
        preset: c.alias.requestAdapter?.preset ?? 'auto',
        ...(c.alias.reasoningEfforts !== undefined
          ? { reasoningEfforts: c.alias.reasoningEfforts }
          : {})
      }
      const adaptedBody = applyThinkingAdapter(enc.body, thinkingInput)
      const patchedBody = applyRequestPatches(
        adaptedBody,
        c.alias.requestAdapter?.patches,
        c.alias.requestAdapter?.preset ?? protocol
      )
      const guardedBody = enforceThinkingPreference(patchedBody, thinkingInput)
      // Model-level patches are allowed to customise ordinary parameters, but
      // Provider-owned Anthropic identity/cache fields are re-applied at the
      // final wire boundary. This keeps metadata.user_id mandatory and makes a
      // Provider's off/5m/1h choice authoritative even for legacy aliases with
      // broad custom patches.
      const anthropicBody = protocol === 'anthropic' ? applyAnthropicRequestOptions(guardedBody, {
        userId: context.workspaceId,
        cacheTtl
      }) : guardedBody
      /*
        ★ 凭证决定的那部分请求形状(额外的头、被钉死的 body 字段)在这里合并 ——
        和上面那段英文注释是**同一条规矩的第二个实例**:供应商自己的硬约束
        压过模型级自定义。API Key 凭证走的是恒等变换,老供应商逐字节不变。
      */
      const transport = upstreamTransport({ ...c.provider, protocol }, cred, { ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) })
      const body = transport.body(anthropicBody)
      const url = joinUpstreamUrl(c.provider.baseUrl, enc.path)
      const payload = JSON.stringify(body)
      const send = (extraHeaders: Record<string, string>): Promise<Response> => {
        const headers: Record<string, string> = {
          // 自报家门排在最前面:任何一个 encode / transport 想自己写 UA 都压得过它
          'user-agent': userAgent(),
          ...enc.headers,
          ...transport.headers
        }
        // ★ 删在合并 extraHeaders 之前:那一个是 401 之后重发的鉴权头,不该被这里带走
        for (const name of transport.dropHeaders ?? []) delete headers[name]
        return this.host.fetch(url, {
          method: 'POST',
          headers: { ...headers, ...extraHeaders, accept: 'text/event-stream' },
          body: payload,
          signal
        })
      }

      let res = await send({})
      /*
        ★★ **401 之后强制刷新一次,就一次。**

        主动的过期检查(`CredentialResolver` 的 SKEW)覆盖不了两种情况:本机时钟偏,
        以及服务端**主动吊销**。两者的表现都是一个「凭证看着没过期却 401」。

        ★ 为什么不交给外层那个重试循环:`openAIErrorToAgentError` 把 401 归为
        `auth` 且 `retryable: false`(见 `decode/openai-common.ts`),外层于是会
        **切到下一个 provider** —— 而下一家根本不提供这个别名的话,最终错误是
        `no_healthy_provider`,一句和真实原因(token 过期)毫无关系的话。

        ★ 只在 oauth 凭证上做,且此刻 `sawContent` 必然为 false(流还没开始),
        所以不存在「重发导致重复输出」的问题 —— 那正是 §5.3 那条判断守的东西。
      */
      if (res.status === 401 && cred.kind === 'oauth') {
        // 必须读完,否则这条连接不会被释放
        await res.text().catch(() => '')
        const fresh = await this.credentials.refreshNow(c.provider.credentialRef, signal)
        res = await send(authHeader(protocol, fresh.accessToken))
      }
      httpStatus = res.status

      if (!res.ok) {
        // 必须把 body 读完(或 cancel),否则连接不会被释放
        const text = await res.text().catch(() => '')
        /*
          ★ 原始 body 只在这一刻存在过。分类器认不出形状时给出的是一句
          「Upstream request failed (HTTP 400)」—— 上游到底抱怨什么一个字都不说。
          记下来,排查时不必让用户再复现一次。
        */
        /*
          ★ 连 URL 和模型一起记。只记供应商名的话,用户把这一行发过来时
          「打的哪个端点」仍然要靠猜 —— 而同一家供应商换个 baseUrl 就是完全不同的
          一条链路(GLM Coding Plan 那两家 coding / anthropic 两条端点的错误体形状
          都不一样,谁也认不出对方)。
        */
        this.host.logger.warn(
          `[upstream] ${c.provider.name} HTTP ${res.status} ${url} model=${c.alias.upstreamModel}`,
          text.slice(0, 2048)
        )
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          /* 非 JSON 的错误体(网关的 HTML 页)—— 原样交给分类器 */
        }
        const error = protocol === 'anthropic' ? anthropicErrorToAgentError(res.status, parsed, {
          cacheTtl,
          providerName: c.provider.name
        }) : openAIErrorToAgentError(res.status, parsed)
        const after = parseRetryAfter(res.headers.get('retry-after'), this.host.clock.now())
        if (after !== undefined) error.retryAfterMs = after
        return finish({ kind: 'failed', sawContent, error })
      }

      for await (const ev of decodeUpstream(protocol, res, signal)) {
        if (ev.type === 'error') {
          /*
            ★ 流内错误在这里留一条痕迹。界面上只看得到翻译过的那一句,而
            `error.message` 带着解码器给出的原始原因(`Invalid upstream response: …`)——
            用户把日志发过来时,这一行往往是唯一能定位到具体哪条协议检查的东西。
          */
          this.host.logger.warn(`[upstream] ${c.provider.name} 返回错误`, ev.error.code, ev.error.message)
          return finish({ kind: 'failed', sawContent, error: ev.error })
        }
        if (ev.type === 'message_start') responseModel = ev.model
        if (ev.type === 'message_end') {
          usage = ev.usage
          stopReason = ev.stopReason
        }
        if (ev.type === 'thinking_delta') thinkingText += ev.text
        if (ev.type === 'tool_call_start') toolCalls += 1
        if (
          timeToFirstTokenMs === null &&
          (ev.type === 'text_delta' ||
            ev.type === 'thinking_delta' ||
            ev.type === 'tool_call_start' ||
            ev.type === 'block_opaque')
        ) {
          timeToFirstTokenMs = Math.max(0, this.host.clock.now() - startedAt)
        }
        if (isContent(ev)) sawContent = true
        /*
          message_end 同理补上「这一次请求花了多久」。渲染层用它累出一轮的
          Σ 上游耗时,再除出平均 TPS —— 它必须在这里量,因为只有这一层知道
          请求是什么时候发出去的。

          ★ 和 `finish()` 里写进 usage_records 的 `latencyMs` 差几毫秒(那个量
          到流真正收完为止,这个量到本条消息收完为止)。刻意不为了对齐而把
          message_end 押后到循环结束再发 —— 那会让整条流多等一趟。
        */
        if (ev.type === 'message_end') {
          yield { ...ev, latencyMs: Math.max(0, this.host.clock.now() - startedAt) }
          continue
        }
        /*
          ★ 给 message_start 补上「这一段是谁给的」。这里是唯一的 choke point:
          三条解码路径(anthropic / openai-chat / openai-responses)都从这过,
          于是 decoder 一个都不用改 —— 它们本来也不知道自己在为哪家解码。
          抬头那行「Codex / gpt-5.6-sol」显示的就是这个值,故障切换真换了家时
          它跟着变,说的是既成事实而不是用户的意图。
        */
        yield ev.type === 'message_start' ? { ...ev, providerId: c.provider.id } : ev
      }

      if (stopReason === null) {
        return finish({ kind: 'failed', sawContent, error: interruptedResponse() })
      }
      this.recordSuccess(c.provider.id, this.host.clock.now() - startedAt)
      return finish({ kind: 'ok' })
    } catch (err) {
      if (isAbortError(err)) {
        finish({
          kind: 'failed',
          sawContent,
          error: agentError('aborted', '已中断', { retryable: false })
        })
        throw err
      }
      if (err instanceof RequestPatchError || err instanceof ThinkingAdapterError) {
        return finish({
          kind: 'failed',
          sawContent,
          error: agentError('provider', err.message, { retryable: false })
        })
      }
      if (err instanceof ImageInputError) {
        return finish({ kind: 'failed', sawContent, error: err.error })
      }
      /*
        ★ 刷新凭证失败。`error` 已经在 resolver 里分好类了(网络故障 retryable、
        上游明确拒绝 not retryable)—— 这里原样用,不要在这一层重新猜一遍。
        `auth` 在 `FATAL_ERROR_CODES` 里,于是整个 run 会终止并让界面跳设置页。
      */
      if (err instanceof CredentialAuthError) {
        return finish({ kind: 'failed', sawContent, error: err.error })
      }
      return finish({
        kind: 'failed',
        sawContent,
        error: agentError('network', `连接「${c.provider.name}」失败:${(err as Error).message}`)
      })
    }
  }

  /**
   * 主入口。**重试放在这里,绝不放在 session 里** —— 放在 session 里会重放
   * 已经执行过的工具调用(方案 §5.3)。
   */
  async *stream(
    req: CanonicalRequest,
    signal: AbortSignal,
    context: UpstreamRequestContext
  ): AsyncGenerator<ProviderStreamEvent> {
    // `context` comes from the typed AgentSession boundary, but this router is
    // also used by the local gateway and by integrations that can cross a
    // JavaScript (rather than TypeScript) boundary. Treat malformed runtime
    // input as an ordinary local validation failure instead of throwing before
    // the generator can emit an error event.
    const workspaceId =
      typeof context?.workspaceId === 'string' ? context.workspaceId : ''
    if (
      workspaceId.trim() === '' ||
      // Anthropic specifies this limit in characters. JavaScript's
      // `String.length` counts UTF-16 code units, so use code points here;
      // production `ws_...` IDs are ASCII, but this keeps the boundary
      // correct for callers that provide a Unicode identifier in tests or
      // through an integration.
      [...workspaceId].length > ANTHROPIC_USER_ID_MAX
    ) {
      yield {
        type: 'error',
        error: agentError(
          'provider',
          `工作区标识必须是 1–${ANTHROPIC_USER_ID_MAX} 个字符，Anthropic 请求尚未发送。`,
          { retryable: false }
        )
      }
      return
    }

    const runContext: UpstreamRequestContext = {
      ...context,
      workspaceId,
      runId: context.runId ?? `run_${ulid(this.host.clock.now())}`,
      sessionId: context.sessionId ?? ''
    }

    const candidates = this.candidates(req.model, req.modelProviderId)
    if (candidates.length === 0) {
      yield { type: 'error', error: this.noCandidateError(req.model, req.modelProviderId) }
      return
    }

    let lastError: AgentError | undefined
    let authError: AgentError | undefined
    let attemptOrdinal = 0

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci]
      if (c === undefined) continue

      if (ci > 0) {
        const prev = candidates[ci - 1]
        yield {
          type: 'provider_switch',
          from: prev?.provider.name ?? '?',
          to: c.provider.name,
          reason: lastError?.message ?? '上游不可用'
        }
      }

      for (let attempt = 0; attempt < MAX_NETWORK_ATTEMPTS; attempt++) {
        /*
          ★ 别人刚在这一家上吃了 429 —— **在发请求之前**先把这次退避等掉。

          等待不消耗 `attempt`:被别的流连累而推迟,不该算这条流自己的重试次数,
          否则四个并发子代理里最后醒来的那个,机会已经被闸门吃光了。

          复用 `provider_retry` 事件而不是新造一个:界面上要说的话是同一句
          (「在等,因为上游限流」),而新增事件类型意味着 `stream.ts`、转录、
          `block-accumulator` 各改一遍,换不来任何新信息。
        */
        const gate = this.gateWaitFor(c.provider.id)
        if (gate.waitMs > 0) {
          yield { type: 'provider_retry', attempt: attempt + 1, delayMs: gate.waitMs, reason: gate.reason }
          await abortableSleep(gate.waitMs, signal)
        }

        attemptOrdinal += 1
        const outcome = yield* this.attempt(
          c,
          req,
          signal,
          runContext,
          attemptOrdinal
        )
        if (outcome.kind === 'ok') return

        // A cache compatibility error is a configuration mismatch, not an
        // unhealthy provider. Preserve the exact requested wire shape and
        // stop this logical request without retrying or switching candidates.
        if (outcome.error.code === 'cache_unsupported') {
          yield { type: 'error', error: outcome.error }
          return
        }

        this.recordFailure(c.provider.id, outcome.error)
        lastError = outcome.error
        if (outcome.error.code === 'auth' && authError === undefined) authError = outcome.error

        /*
          ★ 退避时长在这里就算出来,**早于**下面那两个 return/break —— 因为闸门
          要在「这条流自己还重不重试」之前立起来。这次尝试是这条流的最后一次
          (或者内容已经吐出去了、只能放弃),对**其它并发流**来说配额照样是空的,
          那一句「等一下再发」依旧成立。
        */
        const delayMs = this.retryDelayFor(outcome.error, attempt)
        if (outcome.error.code === 'rate_limit') {
          this.rateLimitGate.set(c.provider.id, {
            until: this.host.clock.now() + delayMs,
            reason: outcome.error.message
          })
        }

        /**
         * ★ §5.3 的那条边界:**只能在收到第一个内容字节之前切换或重试**。
         *
         * 一旦上游已经吐了 500 个 token 和一个 tool_use 块,换个 provider 重来
         * 就会产生重复输出和错位的工具调用。之后的失败是硬错误,由用户决定重发。
         * 这五行事后补要重写整个流式路径。
         */
        if (outcome.sawContent) {
          yield { type: 'error', error: outcome.error }
          return
        }

        // network 借用更宽的上限,其余可重试错误(限流、5xx …)维持原来的 3 次
        const attemptLimit = outcome.error.code === 'network' ? MAX_NETWORK_ATTEMPTS : MAX_ATTEMPTS
        const canRetry = outcome.error.retryable && attempt < attemptLimit - 1
        if (!canRetry) break

        // 没有这条事件,用户看到的就是白白冻结 30 秒(方案 §4.2)
        yield { type: 'provider_retry', attempt: attempt + 1, delayMs, reason: outcome.error.message }
        await abortableSleep(delayMs, signal)
      }
    }

    // auth 比「最后一个网络错误」更值得展示:它有明确的行动(去设置页填密钥),
    // 而一个 network 错误只会让用户干瞪眼重试
    yield { type: 'error', error: authError ?? lastError ?? agentError('unknown', '上游请求失败') }
  }

  /**
   * ★ 钉住时的三条分支都必须**明说「不会自动切到其它供应商」**。
   * 用户对这个应用的既有心智是「配了多家就会自动兜底」,不写这句,他看到
   * 「Codex 已停用」只会理解成「切换也挂了」,然后去查网络而不是去启用那一家。
   */
  private noCandidateError(model: string, modelProviderId?: string): AgentError {
    if (modelProviderId !== undefined) {
      const provider = this.config.providers().find((p) => p.id === modelProviderId)
      if (provider === undefined) {
        return agentError('no_healthy_provider',
          `你选择的供应商已被删除,「${model}」不会自动切到其它供应商。请在模型菜单里重新选择。`,
          { retryable: false, messageKey: 'agent.error.pinnedProviderMissing', messageParams: { model } })
      }
      if (!provider.enabled) {
        return agentError('no_healthy_provider',
          `供应商「${provider.name}」已停用,「${model}」不会自动切到其它供应商。请启用它,或另选一个模型。`,
          { retryable: false, messageKey: 'agent.error.pinnedProviderDisabled',
            messageParams: { model, provider: provider.name } })
      }
      return agentError('no_healthy_provider',
        `供应商「${provider.name}」下已经没有可用的模型「${model}」,请重新选择。`,
        { retryable: false, messageKey: 'agent.error.pinnedModelMissing',
          messageParams: { model, provider: provider.name } })
    }
    const anyAlias = this.config.aliases().some((a) => a.alias === model)
    if (!anyAlias) {
      return agentError('no_healthy_provider', `没有配置模型别名「${model}」`, { retryable: false })
    }
    const cooling = this.config
      .aliases()
      .filter((a) => a.alias === model)
      .some((a) => (this.healthMap.get(a.providerId)?.cooldownUntil ?? 0) > this.host.clock.now())
    return agentError(
      'no_healthy_provider',
      cooling
        ? `「${model}」的所有供应商都在冷却中,稍后自动恢复`
        : `「${model}」没有已启用的供应商`,
      { retryable: cooling }
    )
  }
}
