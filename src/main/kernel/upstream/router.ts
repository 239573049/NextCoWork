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
import type { ProviderStreamEvent } from '../../../shared/agent/stream'
import type { ModelAlias, ProviderHealth, UpstreamProvider } from '../../../shared/domain/provider'
import { abortableSleep, isAbortError } from '../abort'
import type { KernelHost } from '../host'
import { joinUpstreamUrl, type CanonicalRequest } from './canonical'
import { anthropicErrorToAgentError, decodeAnthropic } from './decode/anthropic'
import { encodeAnthropic } from './encode/anthropic'
import { sseFromResponse } from './sse'

/** 每个 provider 最多试几次(含首次)。第 3 次还不行,换下一个 provider 比继续磕更有用。 */
const MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500
/** 连续失败到这个数就判不健康 */
const UNHEALTHY_AFTER = 3
const COOLDOWN_MS = 30_000

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

export class UpstreamRouter {
  private readonly healthMap = new Map<string, ProviderHealth>()
  private readonly baseDelayMs: number

  constructor(
    private readonly host: KernelHost,
    private readonly config: ProviderConfigSource,
    opts: { baseDelayMs?: number } = {}
  ) {
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  }

  listModels(): ModelAlias[] {
    const enabled = new Set(
      this.config.providers().filter((p) => p.enabled).map((p) => p.id)
    )
    return this.config.aliases().filter((a) => enabled.has(a.providerId))
  }

  health(): ProviderHealth[] {
    return [...this.healthMap.values()]
  }

  resetHealth(providerId?: string): void {
    if (providerId === undefined) this.healthMap.clear()
    else this.healthMap.delete(providerId)
  }

  /**
   * 候选集:同一个 alias 可能由多个 provider 提供 —— **这正是别名表存在的理由**,
   * 没有它就谈不上「切到下一个」。
   */
  private candidates(model: string): Candidate[] {
    const byId = new Map(this.config.providers().map((p) => [p.id, p]))
    const list: Candidate[] = []
    for (const alias of this.config.aliases()) {
      if (alias.alias !== model) continue
      const provider = byId.get(alias.providerId)
      if (provider?.enabled === true) list.push({ provider, alias })
    }
    list.sort((a, b) => a.provider.priority - b.provider.priority)

    // 旁路模式:直取优先级最高的一个,不做健康评分、不做切换。延迟最低、路径最短。
    if (!this.config.failoverEnabled()) return list.slice(0, 1)

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
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent, Outcome> {
    let sawContent = false
    const startedAt = this.host.clock.now()

    try {
      if (c.provider.protocol !== 'anthropic') {
        // openai-chat / openai-responses 的编解码属于步骤 13(网关)。
        // 明确报「未实现」,而不是让它以一个诡异的 400 出现在用户面前。
        return {
          kind: 'failed',
          sawContent,
          error: agentError('provider', `协议 ${c.provider.protocol} 的上游编解码尚未实现(步骤 13)`)
        }
      }

      const apiKey = await this.host.secrets.get(c.provider.credentialRef)
      if (apiKey === null || apiKey === '') {
        return {
          kind: 'failed',
          sawContent,
          error: agentError('auth', `供应商「${c.provider.name}」还没有配置密钥`, { retryable: false })
        }
      }

      const enc = encodeAnthropic(req, c.alias.upstreamModel, apiKey)
      const res = await this.host.fetch(joinUpstreamUrl(c.provider.baseUrl, enc.path), {
        method: 'POST',
        headers: { ...enc.headers, accept: 'text/event-stream' },
        body: JSON.stringify(enc.body),
        signal
      })

      if (!res.ok) {
        // 必须把 body 读完(或 cancel),否则连接不会被释放
        const text = await res.text().catch(() => '')
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          /* 非 JSON 的错误体(网关的 HTML 页)—— 原样交给分类器 */
        }
        const error = anthropicErrorToAgentError(res.status, parsed)
        const after = parseRetryAfter(res.headers.get('retry-after'), this.host.clock.now())
        if (after !== undefined) error.retryAfterMs = after
        return { kind: 'failed', sawContent, error }
      }

      for await (const ev of decodeAnthropic(sseFromResponse(res, signal))) {
        if (ev.type === 'error') {
          return { kind: 'failed', sawContent, error: ev.error }
        }
        if (isContent(ev)) sawContent = true
        yield ev
      }

      this.recordSuccess(c.provider.id, this.host.clock.now() - startedAt)
      return { kind: 'ok' }
    } catch (err) {
      if (isAbortError(err)) throw err
      return {
        kind: 'failed',
        sawContent,
        error: agentError('network', `连接「${c.provider.name}」失败:${(err as Error).message}`)
      }
    }
  }

  /**
   * 主入口。**重试放在这里,绝不放在 session 里** —— 放在 session 里会重放
   * 已经执行过的工具调用(方案 §5.3)。
   */
  async *stream(req: CanonicalRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const candidates = this.candidates(req.model)
    if (candidates.length === 0) {
      yield { type: 'error', error: this.noCandidateError(req.model) }
      return
    }

    let lastError: AgentError | undefined
    let authError: AgentError | undefined

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

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const outcome = yield* this.attempt(c, req, signal)
        if (outcome.kind === 'ok') return

        this.recordFailure(c.provider.id, outcome.error)
        lastError = outcome.error
        if (outcome.error.code === 'auth' && authError === undefined) authError = outcome.error

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

        const canRetry = outcome.error.retryable && attempt < MAX_ATTEMPTS - 1
        if (!canRetry) break

        const delayMs = outcome.error.retryAfterMs ?? this.baseDelayMs * 2 ** attempt
        // 没有这条事件,用户看到的就是白白冻结 30 秒(方案 §4.2)
        yield { type: 'provider_retry', attempt: attempt + 1, delayMs }
        await abortableSleep(delayMs, signal)
      }
    }

    // auth 比「最后一个网络错误」更值得展示:它有明确的行动(去设置页填密钥),
    // 而一个 network 错误只会让用户干瞪眼重试
    yield { type: 'error', error: authError ?? lastError ?? agentError('unknown', '上游请求失败') }
  }

  private noCandidateError(model: string): AgentError {
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
