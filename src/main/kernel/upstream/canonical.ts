/**
 * CanonicalRequest —— 方案 §5.1 那张图的中枢。
 *
 * 「3 种入站协议 × 3 种上游协议 = 9 组转换」被因式分解成四组各 3 个小函数,
 * 靠的就是中间这一个形状:
 *
 *   入站 HTTP ──parseInbound──▶ CanonicalRequest ──encodeUpstream──▶ 上游 HTTP
 *   内核 ContextAssembler ─────┘
 *
 * ★ 它**就是 §4.1 的 Anthropic 形状**,不是一个新概念。选 Anthropic 而不是 OpenAI
 * 作为规范形状的理由在 §4.1:块模型 → 扁平字符串是有损的,反过来不是。
 * 一个带 thinking 签名和并行 tool_use 的 Anthropic 响应,降成 OpenAI 形状再升回来
 * 会丢 signature、丢块序;而 OpenAI 形状升成块模型只是包一层。
 */
import type { AgentMessage } from '../../../shared/agent/message'
import type { ToolInfo } from '../../../shared/agent/tool'

export interface CanonicalRequest {
  /** ★ ModelAlias.alias,**不是**上游真实模型名 —— 路由器负责翻译(方案 §5.2) */
  model: string
  /** 系统提示词。ContextAssembler 拼好后原样带过来 */
  system: string
  messages: AgentMessage[]
  tools: ToolInfo[]
  maxOutputTokens: number
  /**
   * ThinkingLevel 映射出来的预算。undefined = 不下发 thinking 参数。
   * 由 `ModelAlias.capabilities.thinking` 决定 —— 界面原文
   * 「不支持该参数的模型将自动忽略此设置」。
   */
  thinkingBudget?: number
  temperature?: number
  stopSequences?: string[]
}

/**
 * Run-scoped facts needed by upstream adapters but not part of the protocol-
 * neutral prompt. Keep these outside CanonicalRequest so provider-specific
 * metadata cannot leak into another wire protocol by accident.
 */
export interface UpstreamRequestContext {
  workspaceId: string
}

/**
 * ★ 实现搬到了 `shared/domain/baseurl.ts`,这里只再导出 —— 调用点一个都不用改。
 *
 * 搬家的理由是本函数原来那段注释自己写下的约束:「设置页必须把最终拼出的 URL
 * 显示给用户确认……收口到这一个函数,是为了那一行显示和实际请求用的是同一份逻辑」。
 * 渲染层 import 不到 `main/`,所以留在这边那一行回显只能再写一遍同样的启发式。
 */
export { joinUpstreamUrl } from '../../../shared/domain/baseurl'
