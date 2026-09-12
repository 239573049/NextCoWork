/**
 * OpenCode Go 的「模型 → 协议」表。
 *
 * ★★ **这家的协议是跟着模型走的,不是用户选的。** 三个端点
 * (`/responses`、`/chat/completions`、`/messages`)共用同一个 base
 * (`https://opencode.ai/zen/go/v1`,见 `presets.ts` 的 `opencode-go`),
 * 所以添加供应商时只能选出一个「出厂协议」,而那一个协议对**表里三分之二的模型是错的**。
 *
 * 选错的代价不是一句能读懂的报错,是:
 *
 * ```
 * HTTP 500 https://opencode.ai/zen/go/v1/chat/completions model=muse-spark-1.3-contributor
 * {"type":"error","error":{"type":"error","message":"Internal server error"}}
 * ```
 *
 * —— 一句**看起来像上游挂了**的话。用户能做的事(把这个模型的协议改成 Responses)
 * 在这段文字里一个字都没有,于是他会去重试、换网络、怀疑订阅没生效。
 * 表存在的理由就是这句 500:协议由我们按模型钉死,用户不必知道有这回事。
 *
 * 数据来源是官方文档 https://opencode.ai/docs/go 的 "Endpoints" 一节,2026-09-12 核实。
 * `@ai-sdk/openai` → Responses,`@ai-sdk/openai-compatible` → Chat Completions,
 * `@ai-sdk/anthropic` → Messages。
 *
 * ★ **只服务 Go 这条路由,不服务同域的 Zen(`/zen/v1`)。** 两张表**不一样** ——
 * 同一个 `minimax-m3` 在 Go 上走 `/messages`、在 Zen 上走 `/chat/completions`。
 * 所以下面的路由判定必须认 `/zen/go/` 这段路径,只认主机名会把这张表错用到 Zen 上,
 * 而那恰好会把一家今天好好的供应商弄坏。
 */
import { OPENCODE_GO_PROVIDER_ID } from '../../../shared/domain/presets'
import type { UpstreamProtocol, UpstreamProvider } from '../../../shared/domain/provider'
import { isOpencodeGo } from './transport'

/** 认这个供应商用的是哪条路由时,只需要这两个字段。 */
type ProviderRef = Pick<UpstreamProvider, 'id' | 'baseUrl'>

/**
 * 官方 Endpoints 表逐行照抄。**别按家族归并** —— 归并过的表读不出「哪一行是文档写的、
 * 哪一行是我们推的」,而这两件事的可信度差着一个量级(下面那张前缀表就是「我们推的」)。
 */
export const OPENCODE_GO_MODEL_PROTOCOLS: Readonly<Record<string, UpstreamProtocol>> = {
  // `/responses`(@ai-sdk/openai)
  'grok-4.6': 'openai-responses',
  'gpt-5.6-luna': 'openai-responses',
  'muse-spark-1.3-contributor': 'openai-responses',
  'muse-spark-1.2-contributor': 'openai-responses',
  // `/chat/completions`(@ai-sdk/openai-compatible)
  'glm-5.3-flash': 'openai-chat',
  'glm-5.3': 'openai-chat',
  'glm-5.2': 'openai-chat',
  'glm-5.1': 'openai-chat',
  'kimi-k3': 'openai-chat',
  'kimi-k2.7-code': 'openai-chat',
  'kimi-k2.6': 'openai-chat',
  'longcat-2.0': 'openai-chat',
  'deepseek-v4.1-flash': 'openai-chat',
  'deepseek-v4-pro': 'openai-chat',
  'deepseek-v4-flash': 'openai-chat',
  'deepseek-v4-flash-vision-exp': 'openai-chat',
  'mimo-v2.5': 'openai-chat',
  'mimo-v2.5-pro': 'openai-chat',
  'hy4-preview': 'openai-chat',
  hy3: 'openai-chat',
  // `/messages`(@ai-sdk/anthropic)
  'minimax-m3': 'anthropic',
  'minimax-m2.7': 'anthropic',
  'minimax-m2.5': 'anthropic',
  'qwen3.8-max': 'anthropic',
  'qwen3.8-flash': 'anthropic',
  'qwen3.7-max': 'anthropic',
  'qwen3.7-plus': 'anthropic',
  'qwen3.6-plus': 'anthropic'
}

/**
 * 家族前缀兜底 —— **给文档表漏掉的那些模型用的。**
 *
 * `/zen/go/v1/models` 实测比文档的 Endpoints 表多出 8 条(`kimi-k2.5`、`glm-5`、
 * `deepseek-flash`、`qwen3.5-plus`、`mimo-v2-pro`、`mimo-v2-omni`、`hy3-preview`、
 * `grok-4.5`)—— 文档那张表落后于上线节奏,而用户「拉取模型列表」拿到的是后者。
 * 不兜底的话,这些模型继承出厂协议,回到本文件开头那句 500。
 *
 * ★ 认不出的**一律不猜**(见 `opencodeGoProtocolFor` 的返回值)。猜错会把一个今天
 * 能用的模型弄坏,而不猜只是维持现状 —— 两种错的代价不对称。今天唯一落到这里的是
 * `omen-alpha`:哪一类都不像,它就该保持继承。
 */
const FAMILY_FALLBACK: readonly { readonly prefix: string; readonly protocol: UpstreamProtocol }[] = [
  { prefix: 'muse-spark', protocol: 'openai-responses' },
  { prefix: 'grok', protocol: 'openai-responses' },
  { prefix: 'gpt-', protocol: 'openai-responses' },
  { prefix: 'minimax-', protocol: 'anthropic' },
  { prefix: 'qwen', protocol: 'anthropic' },
  { prefix: 'glm-', protocol: 'openai-chat' },
  { prefix: 'kimi-', protocol: 'openai-chat' },
  { prefix: 'deepseek-', protocol: 'openai-chat' },
  { prefix: 'longcat-', protocol: 'openai-chat' },
  { prefix: 'mimo-', protocol: 'openai-chat' },
  // 混元。`hy` 这个前缀短得像会误伤,但它只在「已经确认是 OpenCode Go」之后才被查,
  // 而那张列表上以 hy 开头的只有混元
  { prefix: 'hy', protocol: 'openai-chat' }
]

/**
 * 这家用的是不是 Go 那条路由。
 *
 * ★★ **两条判据,和 `transport.ts` 的 `isOpencodeGo` 不是同一个问题。**
 * 那个函数回答的是「该不该发 `x-opencode-session`」—— 整个 opencode.ai 都要发,
 * Go 和 Zen 都一样,所以它只认主机名。这里回答的是「该用哪张协议表」,
 * 而 Go 和 Zen 的表**不一样**,于是主机名之外还要认路径。
 *
 * 预设那条按 id 直接放行:它的 baseUrl 就是 Go 的。手填地址建的自定义供应商
 * (id 带 `custom-` 前缀)走主机名 + 路径 —— 主机名复用 `isOpencodeGo`,
 * 连同它那条「不能写成 `includes('opencode.ai')`」的安全约束(理由见那边的注释)。
 */
export function isOpencodeGoRoute(provider: ProviderRef): boolean {
  if (provider.id === OPENCODE_GO_PROVIDER_ID) return true
  if (!isOpencodeGo(provider)) return false
  try {
    // 补尾斜杠再判:用户填的通常是 `…/zen/go/v1`(无尾斜杠),
    // 而 `/zen/go/` 这个判据要求 `go` 后面确实还有东西
    return `${new URL(provider.baseUrl).pathname.replace(/\/+$/, '')}/`.includes('/zen/go/')
  } catch {
    // 畸形 baseUrl 当「不是这条路由」—— 和 `hostnameOf` 同一个理由:
    // 这里抛出去会让一次和地址无关的操作崩在一个不提地址的地方
    return false
  }
}

/**
 * 这个模型在 Go 上该用哪个协议。**返回 `undefined` = 不知道,别动它**
 * (照旧继承供应商的出厂协议)。
 */
export function opencodeGoProtocolFor(
  provider: ProviderRef,
  upstreamModel: string
): UpstreamProtocol | undefined {
  if (!isOpencodeGoRoute(provider)) return undefined
  const id = upstreamModel.trim().toLowerCase()
  if (id === '') return undefined
  return OPENCODE_GO_MODEL_PROTOCOLS[id] ??
    FAMILY_FALLBACK.find((f) => id.startsWith(f.prefix))?.protocol
}
