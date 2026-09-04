/**
 * 上游配置与网关状态 —— 方案 §5.2 / §5.4。
 *
 * ★ 别名表是故障切换的前提:同一个 alias 可以由多个 provider 提供,
 * 才谈得上「切到下一个」。它同时是网关 GET /v1/models 的数据源。
 */

export type UpstreamProtocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export const PROTOCOL_LABEL: Record<UpstreamProtocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses'
}

/**
 * 参考图把协议做成了两个控件:「API 格式:OpenAI 格式 | Anthropic 格式」
 * 加一个只在 OpenAI 下出现的「使用 Responses API」开关。
 *
 * 那正好是上面三个值的一种**二维投影** —— 所以这里是两个纯函数,
 * **不加字段**。多存一个 `family` 就多了一个会和 `protocol` 不同步的值,
 * 而不同步的表现是「界面显示 Anthropic,请求按 OpenAI 发出去」。
 */
export type ProtocolFamily = 'anthropic' | 'openai'

export function splitProtocol(p: UpstreamProtocol): { family: ProtocolFamily; responses: boolean } {
  if (p === 'anthropic') return { family: 'anthropic', responses: false }
  return { family: 'openai', responses: p === 'openai-responses' }
}

/**
 * ★ `family: 'anthropic'` 时**忽略** `responses`。
 *
 * 界面上那个开关在切到 Anthropic 时会被藏起来但状态还留着(用户切回来
 * 希望它还是原样),所以这个函数一定会收到 `('anthropic', true)` 这种组合。
 * 它不是非法输入,是正常交互的中间态。
 */
export function joinProtocol(family: ProtocolFamily, responses: boolean): UpstreamProtocol {
  if (family === 'anthropic') return 'anthropic'
  return responses ? 'openai-responses' : 'openai-chat'
}

export interface UpstreamProvider {
  id: string
  name: string
  protocol: UpstreamProtocol
  baseUrl: string
  /** ★ safeStorage 引用,**永不是明文 key**(方案 §9) */
  credentialRef: string
  /** 故障切换顺序,小的优先 */
  priority: number
  enabled: boolean
}

/** 设置页对密钥**只写不读**:返回这个,永不回传明文。 */
export interface CredentialInfo {
  hasKey: boolean
  last4: string | null
  /** Linux 无 keyring 时 safeStorage.isEncryptionAvailable() 为 false —— 必须有明确降级路径 */
  encryptionAvailable: boolean
}

export interface ModelCapabilities {
  tools: boolean
  vision: boolean
  /** 为 false 时忽略 ThinkingLevel:界面「不支持该参数的模型将自动忽略此设置」 */
  thinking: boolean
  caching: boolean
}

export interface ModelAlias {
  /** 调用方要的名字:"claude-sonnet-4" / "glm-4.6" */
  alias: string
  providerId: string
  /** 实际下发给上游的名字 */
  upstreamModel: string
  capabilities: ModelCapabilities
  contextWindow: number
  maxOutputTokens: number
}

// ─── 健康与故障切换(方案 §5.3) ───

export interface ProviderHealth {
  providerId: string
  healthy: boolean
  /** 0–1 健康度:成功/失败/错误码/延迟综合 */
  score: number
  consecutiveFailures: number
  /** 冷却到期时间戳;之后重新纳入候选 */
  cooldownUntil?: number
  lastLatencyMs?: number
  lastError?: string
  lastCheckedAt: number
}

/**
 * ★ 旁路开关落在**路由器**,不落在 HTTP 壳(方案 §5.6)。
 * 内核和网关都受这一个开关支配,不会出现「UI 里的对话有 failover、
 * 外部 SDK 调进来没有」这种分裂。
 */
export interface GatewayStatus {
  enabled: boolean
  /** ★ 实际端口(19836 被占时会动态选)经这里回传渲染层(方案 §5.4 第 5 条) */
  port: number | null
  /** 永远是字面量 127.0.0.1 —— 不是 0.0.0.0,也不写 localhost */
  host: '127.0.0.1'
  /** 网关 key 是**必需的**,不是可选的;这里只报告有没有 */
  hasKey: boolean
  failover: boolean
  health: ProviderHealth[]
  error?: string
}

export interface FailoverEvent {
  from: string
  to: string
  reason: string
  at: number
}
