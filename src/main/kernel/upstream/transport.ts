/**
 * 传输装饰 —— **凭证决定的那部分请求形状。**
 *
 * ★★ **为什么这层存在,而不是给 `UpstreamProtocol` 加第四个值。**
 * 「走 ChatGPT 订阅额度」和「走 api.openai.com」用的是**同一个 Responses 协议**:
 * 同样的 body、同样的 SSE、同样的解码器。不同的只有几个头和两个被钉死的字段。
 * 为它加一个协议值要牵动十几处(`PROTOCOL_LABEL` / `REQUEST_PATH` / codec 的两个
 * switch / `thinking-adapter` 的 `AdapterKind` / `data.ts` 的导入校验 / 设置页的
 * 「API 格式」开关 …),而其中**最危险的一处不在任何 grep 结果里**:
 *
 * 思考块的 opaque 回放是**以协议字符串为键**的 —— `decode/openai-responses.ts`
 * 打上 `protocol: 'openai-responses'`,`encode/openai-responses.ts` 按这个串认。
 * 新协议下 decoder 打的是新串、encoder 认不出,于是**每一个 reasoning item 被静默
 * 丢弃**:多轮工具调用的连续性变差,模型偶尔「忘了刚才在干什么」,而没有任何一处报错。
 *
 * 所以:协议不变,变的是凭证形态 + 这一层装饰。
 */
import { createHash } from 'node:crypto'
import type { ProviderCredential } from '../../../shared/domain/credential'
import type { UpstreamProvider, UpstreamProtocol } from '../../../shared/domain/provider'
import { oauthSpecOf } from '../oauth/registry'

export interface TransportContext {
  /** `UpstreamRequestContext.sessionId` 可缺 —— `sessionUuid` 自己兜底 */
  sessionId?: string
}

export interface UpstreamTransport {
  /** 与 `enc.headers` 合并,同名覆盖 */
  headers: Record<string, string>
  /**
   * ★ 在**全部** patch(thinking adapter / requestAdapter / thinking preference)
   * 之后跑,用来把供应商自己的硬约束按回去。
   */
  body: (body: unknown) => unknown
}

/** API Key 凭证走这条 —— 现有全部供应商的请求逐字节不变 */
const IDENTITY: UpstreamTransport = { headers: {}, body: (b) => b }

/**
 * ★ `provider` 现在没被读,但留在签名里:将来「同一种凭证、不同 baseUrl 要不同头」
 * (自建反代要转发一个额外头之类)时有地方接,而那时不用改所有调用点。
 */
export function upstreamTransport(
  _provider: UpstreamProvider,
  cred: ProviderCredential,
  ctx: TransportContext
): UpstreamTransport {
  return cred.kind === 'api-key' ? IDENTITY : oauthSpecOf(cred.issuer).transport(cred, ctx)
}

/**
 * 鉴权头 —— **只给「刷新之后重发」那条路径用。**
 *
 * 首次请求的鉴权头是 `encode/*.ts` 写的,这里**一个字节都不覆盖它**。
 * 401 之后拿着新 token 重发时,body 和其余的头都不该重算(重算意味着再跑一遍
 * thinking adapter 和用户 patch,而那些是有副作用语义的),只有这一个头要换 ——
 * 于是需要一处知道「这个协议的鉴权头长什么样」。
 *
 * ★ 值必须和对应 encode 函数写出来的**逐字相同**,否则重发会用一个上游不认的头。
 * `transport.test.ts` 里有一条断言钉着这件事。
 */
export function authHeader(protocol: UpstreamProtocol, bearer: string): Record<string, string> {
  return protocol === 'anthropic'
    ? { 'x-api-key': bearer }
    : { authorization: `Bearer ${bearer}` }
}

/**
 * 把我们的 sessionId 折成一个 UUID 形状的串。
 *
 * ★ 起因很具体:那条通道的 `session_id` 头要 UUID,而我们的 sessionId 是 **ULID**。
 *
 * ★★ **必须是确定性纯函数,不能挂一个 `Map<sessionId, uuid>` 缓存。**
 * 缓存会在多窗口、进程重启、以及 gateway 与内核各持一份的情况下,给**同一个会话
 * 两个不同的 id** —— 而上游那边很可能拿它做会话级的关联,结果是同一段对话在
 * 上游被拆成两截。sha256 折一下,任何进程任何时刻都算出同一个值。
 *
 * sessionId 缺失时用一个固定种子:也是一个合法 UUID,且始终同一个,
 * 比每次现摇一个更符合「同一会话同一个 id」这个语义。
 */
export function sessionUuid(sessionId: string | undefined): string {
  const seed = sessionId === undefined || sessionId === '' ? 'nextcowork:no-session' : sessionId
  const h = createHash('sha256').update(seed).digest()
  const b = Buffer.from(h.subarray(0, 16))
  // RFC 4122:version 置 4、variant 置 10xx。不置的话它只是「长得像 UUID」,
  // 而按规范校验的一方会拒
  b[6] = ((b[6] as number) & 0x0f) | 0x40
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
