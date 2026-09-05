/**
 * 错误分类 —— 方案 §4.11。
 *
 * 自由格式的 error 字符串没法回答「UI 该怎么办」。这个 union 存在的意义是让
 * 「哪些错误终止 run、哪些变成工具结果、哪些只是个 toast」这件事**在一个地方写下来**,
 * 而不是在 30 个调用点上被不一致地决定。
 */

export type AgentErrorCode =
  /** 凭证无效/缺失 → UI 跳设置页 */
  | 'auth'
  /** 上游限流 → UI 显示重试倒计时 */
  | 'rate_limit'
  /** 上下文超长 → UI 提示 /compact */
  | 'context_length'
  /** 网络层失败 → 可重试 */
  | 'network'
  /** 用户主动中断 → 不是错误,不弹提示 */
  | 'aborted'
  /** 工具执行失败 → ★ 进转录并继续循环,不终止 run */
  | 'tool_failed'
  /** 上游返回了我们无法归一化的东西 */
  | 'provider'
  /** Provider explicitly rejected configured prompt-cache fields. */
  | 'cache_unsupported'
  /** 别名下所有 provider 都不健康(§5.3) */
  | 'no_healthy_provider'
  | 'unknown'

export interface AgentError {
  code: AgentErrorCode
  message: string
  /** UI 是否该给「重试」按钮;也决定 UpstreamRouter 要不要自动重试 */
  retryable: boolean
  /** 上游 HTTP 状态码,有就带上 —— 排查上游问题时这是唯一有用的信息 */
  status?: number
  /** 限流场景下上游给的 Retry-After,毫秒 */
  retryAfterMs?: number
  /** Locally generated errors are translated in the renderer; upstream text stays verbatim. */
  messageKey?: string
  messageParams?: Record<string, string | number>
}

/** 只有这两类会终止整个 run;其余的要么进转录、要么只是提示。 */
export const FATAL_ERROR_CODES: readonly AgentErrorCode[] = ['auth', 'no_healthy_provider']

export function isFatal(e: AgentError): boolean {
  return FATAL_ERROR_CODES.includes(e.code)
}

export function agentError(
  code: AgentErrorCode,
  message: string,
  extra?: Omit<AgentError, 'code' | 'message' | 'retryable'> & { retryable?: boolean }
): AgentError {
  const { retryable, ...rest } = extra ?? {}
  return {
    code,
    message,
    retryable: retryable ?? (code === 'network' || code === 'rate_limit'),
    ...rest
  }
}
