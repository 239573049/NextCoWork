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
 *
 * ★★ **后来这一层多了一维:供应商本身。** 结构是「基础 transport(凭证决定)
 * + 头装饰(供应商决定)」—— 今天装饰只有一家,OpenCode Go 的 `x-opencode-session`
 * (见 `opencodeSession`)。
 *
 * 两维**必须能共存**:「这家用什么凭证」和「这家额外要什么头」是两件无关的事。
 * 把供应商装饰写成 `upstreamTransport` 里的第四个 `if … return` 分支今天也能跑
 * (那家只用 API Key),但它和 oauth 分支从此互斥 —— 而互斥**不会报错**,只会在
 * 它们第一次同时成立的那天,静默地把其中一件事改没。
 */
import { createHash } from 'node:crypto'
import type { ProviderCredential } from '../../../shared/domain/credential'
import { CLIENT_PROVIDER_ID, OPENCODE_GO_PROVIDER_ID } from '../../../shared/domain/presets'
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
   * ★ **覆盖不够,必须能删。** 上游按「某个头在不在」分流时,一个值被换掉的头
   * 和一个不存在的头是两件事(见 `platformLoginAuth`)。
   */
  dropHeaders?: readonly string[]
  /**
   * ★ 在**全部** patch(thinking adapter / requestAdapter / thinking preference)
   * 之后跑,用来把供应商自己的硬约束按回去。
   */
  body: (body: unknown) => unknown
}

/** API Key 凭证走这条 —— 现有全部供应商的请求逐字节不变 */
const IDENTITY: UpstreamTransport = { headers: {}, body: (b) => b }

/**
 * NextCoWork 平台那条上游的鉴权形状。**不是平台的供应商返回 `null`,请求逐字节不变。**
 *
 * ★★ 平台那条的凭证是**登录 access token(JWT)**,不是平台 API Key —— 它由
 * `ipc/client-auth.ts` 在登录时写进 `nextcowork:client-access-token`,用户从来没有
 * 填过任何 key。而平台网关**按头分流**:`x-api-key` 去查 API Key 表,
 * `Authorization: Bearer` 才验登录态。Anthropic 协议的 encode 写出来的正是
 * `x-api-key`(那是 Anthropic 官方的形状),于是用户在设置页把「API 格式」翻成
 * Anthropic 之后,每一次对话都是
 * `401 {"code":"invalid_api_key","message":"API Key 无效或已停用"}` ——
 * 一句指向「密钥」的错误,而密钥这个东西在这条上游上根本不存在,
 * 用户唯一能做的事(重新登录)对它一点用都没有。
 *
 * ★ `x-api-key` 必须**删掉**而不是置空或让 Bearer 覆盖它:实测平台只要这个头
 * 非空就走 API Key 分支,同时带着一把合法的 Bearer 也照样 401。
 *
 * OpenAI 两族的 encode 本来写的就是 `Authorization: Bearer <同一个串>`,
 * 所以这一层对它们是恒等的 —— 不按协议分叉,少一处要跟着协议表一起改的地方。
 */
export function platformLoginAuth(
  providerId: string,
  token: string
): { headers: Record<string, string>; dropHeaders: readonly string[] } | null {
  if (providerId !== CLIENT_PROVIDER_ID) return null
  return { headers: { authorization: `Bearer ${token}` }, dropHeaders: ['x-api-key'] }
}

/**
 * OpenCode Go 的主机名。**认它本身和它的子域,不认别的。**
 *
 * ★★ **不能写成 `baseUrl.includes('opencode.ai')`。** 那会把
 * `https://opencode.ai.attacker.com/v1` 判成命中 —— 于是我们主动把会话标识
 * 发给一台第三方主机,而用户这边**看不到任何异常**:那台机器完全可以反代真上游,
 * 把回复原样送回来。子串匹配和主机名匹配在「判错了要付出什么」这件事上,
 * 不是一个量级。
 *
 * 子域放行是留给将来的 `gateway.opencode.ai` 之类。`.` 前缀是关键 ——
 * 少了它 `notopencode.ai` 也会命中。
 */
const OPENCODE_HOST = 'opencode.ai'

/**
 * ★ `new URL()` 对畸形串**抛异常**,而这一层在**每一个请求的必经之路上**。
 * 让它抛出去的话,一个存歪了的 baseUrl 会使整条对话崩在一个和网络、和凭证
 * 都无关的地方,而报错里一个字都不会提到「地址」。
 *
 * 所以认不出就当「不是这家」:请求照常发出去,让真正的 fetch 去报那个地址的错 ——
 * 那条错误至少指着 URL。
 */
function hostnameOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * ★ **两条判据是「或」,不是「且」。**
 *
 * - 按 id:从预设表添加的那条,`provider.id` 就是 `'opencode-go'`
 *   (`ipc/provider.ts` 的 `upsertProvider` 直接用入参 id,没有 presetId 字段)。
 * - 按主机名:用户**手动新建**一个自定义供应商、自己填 `https://opencode.ai/zen/go/v1`
 *   时,id 带 `custom-` 前缀(`custom-provider.ts` 的 `CUSTOM_PROVIDER_PREFIX`),
 *   只按 id 匹配会**整个漏掉他** —— 而他遇到的报错和预设用户一模一样,
 *   却怎么也对不上「我们已经修好了」这句话。
 */
export function isOpencodeGo(provider: Pick<UpstreamProvider, 'id' | 'baseUrl'>): boolean {
  if (provider.id === OPENCODE_GO_PROVIDER_ID) return true
  const host = hostnameOf(provider.baseUrl)
  return host !== null && (host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`))
}

/**
 * OpenCode Go 的会话头 —— **不是我们想加的,是上游的准入条件。**
 *
 * 不带它的时候每一次对话都是
 * `Error from provider (Console Go): Request is missing x-opencode-session and
 * cannot be routed efficiently.` —— 一句**措辞像性能建议、实则是硬拒绝**的错误,
 * 用户从这句话里读不出任何可操作的东西。三条准入要求的全文见
 * `shared/domain/presets.ts` 里那条预设旁边的注释。
 *
 * ★ 值用 `sessionUuid` 折一道,而不是把我们的 ULID 原样发出去。上游只要求
 * 「每个对话稳定」、**不要求 UUID 格式**,折它买的是两样别的:一是 ULID 前 10 个
 * 字符是毫秒时间戳、且和本地库的主键逐字相同;二是一个叫 `session` 的头,
 * 服务端哪天加一条 UUID 正则校验是完全可能的,而那天的表现是从 missing 变成
 * invalid,又是一轮排查。
 *
 * ★ **sessionId 缺失时照发,不省略。** 省略的失败模式**恰好是我们在修的这个 bug**,
 * 而且是间歇性的:将来某个新调用点忘了传 sessionId,表现会是「大部分对话正常、
 * 某个功能偶尔报 missing header」—— 最难查的一档。照发的代价只是那些请求共享
 * 一个 id(上游的路由亲和/前缀缓存变差),**不会出错**,和上面那个不在一个量级。
 *
 * ★ 返回 `null` 而不是空对象:调用点靠 null 决定「要不要新建一个 headers 对象」,
 * 而不新建正是 `IDENTITY` 那条零回归路径能保持逐字节不变的原因。
 */
export function opencodeSession(
  provider: UpstreamProvider,
  ctx: TransportContext
): Record<string, string> | null {
  return isOpencodeGo(provider) ? { 'x-opencode-session': sessionUuid(ctx.sessionId) } : null
}

/** 凭证决定的基础形状。三选一,和多出「装饰」这一维之前逐字相同。 */
function baseTransport(
  provider: UpstreamProvider,
  cred: ProviderCredential,
  ctx: TransportContext
): UpstreamTransport {
  if (cred.kind === 'oauth') return oauthSpecOf(cred.issuer).transport(cred, ctx)
  const platform = platformLoginAuth(provider.id, cred.apiKey)
  return platform === null ? IDENTITY : { ...platform, body: (b) => b }
}

/**
 * **基础 transport(凭证决定)+ 头装饰(供应商决定)。**
 *
 * ★ `provider` 现在 `id` 和 `baseUrl` 两个字段都要读:前者是平台那条的登录态鉴权,
 * 后者是 OpenCode 的主机名判定 —— 这里原来那句「别的字段留在签名里,将来
 * 『同一种凭证、不同 baseUrl 要不同头』时有地方接」**已经兑现了**。
 *
 * ★★ **必须新建 headers 对象,不能往 `base.headers` 上写。** `IDENTITY` 是个
 * **模块级共享常量**,就地 `base.headers['x-opencode-session'] = …` 会让这个进程里
 * **此后每一个供应商**的每一个请求都带上这个头 —— 包括别家上游,包括那个头里的
 * 会话 id。而零回归那两条断言也会从此恒假,却没有任何一条用例会先跑到 OpenCode
 * 那条路上去、把污染留下。
 *
 * ★ 合并顺序是「装饰在前、凭证在后」:凭证形态是更具体的那一层,装饰只该填空,
 * 不该把某个 issuer 自己写的头顶掉。今天两边没有同名头,这条顺序买的是
 * 「将来撞名时的默认答案是安全的那个」。
 */
export function upstreamTransport(
  provider: UpstreamProvider,
  cred: ProviderCredential,
  ctx: TransportContext
): UpstreamTransport {
  const base = baseTransport(provider, cred, ctx)
  const extra = opencodeSession(provider, ctx)
  // 没有装饰时**原样**返回 base —— API Key 那条仍然是同一个 `IDENTITY` 引用
  if (extra === null) return base
  return { ...base, headers: { ...extra, ...base.headers } }
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
 * ★ 起因很具体:ChatGPT 那条通道的 `session_id` 头要 UUID,而我们的 sessionId 是 **ULID**。
 *
 * ★ 第二个调用点是 OpenCode Go 的 `x-opencode-session`(见 `opencodeSession`),
 * 它**不要求 UUID 格式** —— 上游只说「每个对话稳定」。仍然折一道的理由写在那边。
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
