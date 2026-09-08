/**
 * ZCode 登录链路的**公共实现** —— Z.AI 和智谱(BigModel)两条渠道共用。
 *
 * ============================ 证据等级 ============================
 * 协议来自**第三方逆向文档,非官方**:Vibe Coding Labs《ZCode RE》(GPL-3.0)
 * https://vibe-coding-labs.github.io/zcode-reverse-engineer/auth/oauth-flow.html
 * OAuth 页生成于 2026-07-04,分析报告 2026-06-15,逆向对象 ZCode v3.0.1 / v2.13.0。
 *
 * **2026-09-09 我自己直连复现到的**(不需要代理):
 * - `POST zcode.z.ai/api/v1/oauth/token`,JSON body `{provider:"zai",code:无效,…}`
 *   → `500 {"code":2007,"msg":"http error"}`,与文档记的「code 过期」逐字对上。
 *   证明:端点活着、**JSON body 的形状被服务端接受**、普通 TLS 栈没被 WAF 拦。
 * - `GET chat.z.ai/api/oauth/authorize`,redirect_uri 取 `127.0.0.1` / `localhost` /
 *   `evil.example.com` 三种 → 一律 307 → `/auth` 并原样透传。
 *   **authorize 阶段不校验 redirect_uri**,白名单只能靠真登录一次验。
 * - WAF(阿里云 ESA)只拦 `zcode.z.ai/api/v1/zcode-plan/*` 那两个计费接口,
 *   认证链路和 AI 端点都不受影响。
 *
 * ============================ 链路全貌 ============================
 * ```
 * ① GET  {authorizeUrl}?response_type=code&client_id=…&redirect_uri=…&state=…
 *        无 PKCE、无 client_secret、有 state
 * ② POST {tokenUrl}          Content-Type: application/json
 *        {provider, code, redirect_uri, state}          ← 注意:没有 grant_type
 *        → {code:0, data:{zai:{access_token,…}, expires_in:null, user:{id}}}
 * ③ POST {businessLoginUrl}  {token: ②拿到的 access_token}
 *        → {code:0, data:{access_token: 业务 JWT}}
 * ④ 发 AI 请求:x-api-key: <业务 JWT>
 * ```
 *
 * ★ 一条要记录的事实:我们用的是 **ZCode 的 client_id**,等于对 Z.AI 自称是 ZCode。
 * 仓库里已有同性质先例 —— `chatgpt.ts` 用的是 Codex CLI 的 client_id,还带着
 * `originator: codex_cli_rs`。写在这里是为了别让后人以为这是官方给我们的客户端。
 */
import type { OAuthCredential } from '../../../../shared/domain/credential'
import type { OAuthIssuerId } from '../../../../shared/domain/oauth-issuer'
import type { TransportContext, UpstreamTransport } from '../../upstream/transport'
import { OAuthFailedError } from '../errors'
import type {
  OAuthAuthorizeArgs,
  OAuthExchangeContext,
  OAuthIdentity,
  OAuthProviderSpec,
  OAuthRedirect
} from '../registry'
import { decodeJwtPayload, record, str } from './shared'

/**
 * ★ 两跳都要带这两个头。文档记的是 WAF / 来源校验要看它们。
 * 版本号写死一个真实存在过的值 —— 编一个不存在的版本号是在赌上游不做版本白名单,
 * 而那个赌输了的表现是一个不解释原因的 403。
 * `3.10.2` 取自 2026-09-09 抓到的真实授权链接里的 `app_version`(智谱那条),
 * 比逆向文档记的 v3.0.1 新,所以两处统一用这个。
 */
export const ZCODE_APP_VERSION = '3.10.2'
const ZCODE_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': `ZCode/${ZCODE_APP_VERSION}`,
  'http-referer': 'https://zcode.z.ai'
}

export interface ZcodeChannel {
  id: OAuthIssuerId
  label: string
  authorizeUrl: string
  /** ② 换码端点 */
  tokenUrl: string
  /** ② body 里那个 `provider` 字段的值 */
  provider: string
  /**
   * ② 响应里包着 access_token 的那一层子对象的键。Z.AI 那条是 `zai`。
   * ★ 找不到这一层时会退回到 `data.access_token`(平铺形态),两种都试是因为
   * 只有 Z.AI 那条的响应体被真正抓到过。
   */
  tokenKey: string
  clientId: string
  redirect: OAuthRedirect
  /**
   * ③ 拿业务令牌的端点。**省略 = 没有第三跳**,直接把 ② 的 access_token 当
   * 发请求用的令牌。
   *
   * ★ 省略时 `refresh` 会返回 null(= 让用户重新登录),因为没有第三跳就没有
   * 「再换一把」的动作可做。这比假装刷新成功、然后每次请求都 401 要诚实。
   */
  businessLoginUrl?: string
  /** 可选的用户信息端点,只为了在设置页显示邮箱。**失败一律不致命** */
  userinfoUrl?: string
  /**
   * 授权入口不是标准 OAuth 授权端点时,自己拼查询参数(见 `registry.ts` 的
   * `authorizeParams`)。省略 = 标准那一套。
   */
  authorizeParams?: (args: OAuthAuthorizeArgs) => Readonly<Record<string, string>>
  /** 回调里装授权码的参数名。省略 = `code` */
  callbackCodeParam?: string
}

/** ② / ③ 共同的信封:`{code, msg, data}`,`code !== 0` 即业务失败 */
function unwrapEnvelope(json: unknown, what: string): Record<string, unknown> {
  const body = record(json)
  if (body === undefined) throw new OAuthFailedError(`${what}失败：响应不是一个对象`)
  const code = body['code']
  if (typeof code === 'number' && code !== 0) {
    const msg = str(body['msg']) ?? str(body['message']) ?? '未说明原因'
    /*
      ★ 把上游的 code 原样带出来。2007 = 授权码过期/无效(实测),1000 = 服务端
      内部错。用户看到的那句话里有这个数字,才有可能对上文档或搜到别人的记录。
    */
    throw new OAuthFailedError(`${what}失败（${code}）：${msg}`)
  }
  const data = record(body['data'])
  if (data === undefined) throw new OAuthFailedError(`${what}失败：响应里没有 data`)
  return data
}

/** ★ 账号 id 在有的响应里是数字。数字 0 不算有效 id,和空串一样丢掉 */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value)
  return str(value)
}

async function postJson(
  ctx: OAuthExchangeContext,
  url: string,
  body: Readonly<Record<string, unknown>>,
  what: string
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...ZCODE_HEADERS },
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    throw new OAuthFailedError(`${what}失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthFailedError(`${what}失败：响应不是 JSON —— ${text.slice(0, 300)}`)
  }
}

/**
 * `finishExchange` 之后、喂给 `identity()` 之前的中间形态。
 *
 * ★★ 它存在的理由是 `identity()` 必须是**同步纯函数**(测试要能摆布 `now`),
 * 而这条链路要发两三个请求才凑得齐一条凭证。异步的部分全在 `finishExchange`,
 * 同步的字段映射全在 `identity` —— 于是后者可以拿一个字面量对象直接测。
 */
interface ZcodeExchange {
  /** ② 的 access_token。**它会被存进 `refreshToken` 槽,见下面 `identity` 的注释** */
  oauthAccessToken: string
  /** 真正发出去的那把(有第三跳就是业务 JWT,没有就等于 `oauthAccessToken`) */
  apiToken: string
  /** ② 的 `data.user.id` —— 业务 JWT 里解不出 user_id 时的兜底 */
  fallbackAccountId?: string
  email?: string
}

/** ③:拿业务令牌。**刷新时也走这里**,所以单独一个函数 */
async function businessLogin(
  channel: ZcodeChannel,
  ctx: OAuthExchangeContext,
  oauthAccessToken: string
): Promise<string> {
  const url = channel.businessLoginUrl
  if (url === undefined) return oauthAccessToken
  const data = unwrapEnvelope(
    await postJson(ctx, url, { token: oauthAccessToken }, '换取业务令牌'),
    '换取业务令牌'
  )
  const jwt = str(data['access_token'])
  if (jwt === undefined) throw new OAuthFailedError('换取业务令牌失败：响应里没有 access_token')
  return jwt
}

/**
 * 可选的用户信息。**任何失败都吞掉**。
 *
 * ★ 为一个只在设置页显示的邮箱让整个登录失败,是拿一个装饰性字段去赌用户的登录 ——
 * 完全不划算。所以这里连超时都交给 ctx.signal,自己一个错都不往上抛。
 */
async function fetchEmail(
  channel: ZcodeChannel,
  ctx: OAuthExchangeContext,
  oauthAccessToken: string
): Promise<string | undefined> {
  const url = channel.userinfoUrl
  if (url === undefined) return undefined
  try {
    const res = await ctx.fetch(url, {
      headers: {
        authorization: `Bearer ${oauthAccessToken}`,
        accept: 'application/json',
        ...ZCODE_HEADERS
      },
      signal: ctx.signal
    })
    if (!res.ok) return undefined
    const body = record(await res.json())
    if (body === undefined) return undefined
    const data = record(body['data']) ?? body
    return str(data['email'])
  } catch {
    return undefined
  }
}

/**
 * 从业务 JWT(和 ② 的兜底)里定出 accountId。
 *
 * ★ 这条链路的 accountId **不进任何请求头** —— 它只是凭证的身份字段。但
 * `parseCredential` 要求它非空(见 `shared/domain/credential.ts`),空了的表现是
 * **登录成功、下一秒显示未登录**。所以宁可多试几个来源。
 */
function accountIdOf(apiToken: string, fallback: string | undefined): string | undefined {
  const claims = decodeJwtPayload(apiToken)
  return idOf(claims?.['user_id']) ?? idOf(claims?.['sub']) ?? fallback
}

export function createZcodeSpec(channel: ZcodeChannel): OAuthProviderSpec {
  const identity = (json: unknown, _now: number): OAuthIdentity | null => {
    const x = record(json)
    if (x === undefined) return null
    const oauthAccessToken = str(x['oauthAccessToken'])
    const apiToken = str(x['apiToken'])
    if (oauthAccessToken === undefined || apiToken === undefined) return null

    const accountId = accountIdOf(apiToken, str(x['fallbackAccountId']))
    if (accountId === undefined) return null

    const email = str(x['email'])
    return {
      accessToken: apiToken,
      /*
        ★★★ **这里存进 `refreshToken` 槽的不是 refresh token。**
        这条链路根本没有 refresh token(② 的响应里 `refresh_token` 就是 null),
        但有**等价物**:② 的 access_token 可以重跑第三跳再换一把业务 JWT。
        所以这个槽装的是「用来再换一次的那个东西」,`refresh` 钩子照这个语义读它。

        为什么不给 `OAuthCredential` 加个新字段:`parseCredential` 对
        `refreshToken` 的非空校验是一条安全相关的解析规则,放宽它要动的地方比
        在这里写清楚语义多得多,而收益是零。
      */
      refreshToken: oauthAccessToken,
      /*
        ★★ `expiresAt: null` = **不知道什么时候过期**,不是永不过期。
        上游 `expires_in` 回的就是 null,而**编一个假的过期时间比承认不知道更糟**:
        猜短了平白多刷几次,猜长了会拿一把死 token 去撞 401 并废掉那次对话。
        未知时靠 401 触发刷新(`router.ts` 的 401 重试路径本来就在)。
      */
      expiresAt: null,
      accountId,
      ...(email === undefined ? {} : { email })
    }
  }

  return {
    id: channel.id,
    label: channel.label,
    authorizeUrl: channel.authorizeUrl,
    tokenUrl: channel.tokenUrl,
    clientId: channel.clientId,
    redirect: channel.redirect,
    /*
      ★ 这条链路**不支持 PKCE**,授权 URL 里不能有 code_challenge;也没有 scope。
      两者都是「省略」而不是「置空」——`scope=` 和「没有 scope」在有的服务端上
      是两种反应。
    */
    pkce: false,
    ...(channel.authorizeParams === undefined
      ? {}
      : { authorizeParams: channel.authorizeParams }),
    ...(channel.callbackCodeParam === undefined
      ? {}
      : { callbackCodeParam: channel.callbackCodeParam }),

    tokenRequest: (args) => ({
      contentType: 'json',
      /*
        ★★ **整体替换,而不是在标准 body 上加字段。** 这里没有 `grant_type`、
        没有 `client_id`、没有 `code_verifier` —— 标准 OAuth 的那几个字段一个都不发。
        2026-09-09 实测:正是这个形状的 body 才会走到「换码」那一步(返回 2007),
        换成表单编码或加上 grant_type 都没验过。
      */
      body: {
        provider: channel.provider,
        code: args.code,
        redirect_uri: args.redirectUri,
        state: args.state
      },
      headers: ZCODE_HEADERS
    }),

    finishExchange: async (json, ctx) => {
      const data = unwrapEnvelope(json, '换取授权令牌')
      const nested = record(data[channel.tokenKey])
      const oauthAccessToken = str(nested?.['access_token']) ?? str(data['access_token'])
      if (oauthAccessToken === undefined) {
        throw new OAuthFailedError('换取授权令牌失败：响应里没有 access_token')
      }

      const apiToken = await businessLogin(channel, ctx, oauthAccessToken)
      const fallbackAccountId = idOf(record(data['user'])?.['id'])
      const email = await fetchEmail(channel, ctx, oauthAccessToken)

      const exchange: ZcodeExchange = {
        oauthAccessToken,
        apiToken,
        ...(fallbackAccountId === undefined ? {} : { fallbackAccountId }),
        ...(email === undefined ? {} : { email })
      }
      return exchange
    },

    identity,

    /**
     * 刷新 = **重跑第三跳**,不是标准的 `grant_type=refresh_token`。
     *
     * ★★ accountId 必须沿用旧的:新的业务 JWT 里解得出 `user_id` 就用新的,
     * 解不出就用 `cred.accountId`。**漏掉这一步的表现是每刷新一次就把用户踢下线**
     * —— `CredentialResolver` 拿到 `null` 会 `markReauth`。
     */
    refresh: async (cred, ctx) => {
      if (channel.businessLoginUrl === undefined) return null
      const apiToken = await businessLogin(channel, ctx, cred.refreshToken)
      return {
        accessToken: apiToken,
        refreshToken: cred.refreshToken,
        expiresAt: null,
        accountId: accountIdOf(apiToken, cred.accountId) ?? cred.accountId,
        ...(cred.email === undefined ? {} : { email: cred.email }),
        ...(cred.planType === undefined ? {} : { planType: cred.planType })
      }
    },

    /*
      ★ 鉴权头**这里一个字都不写**:供应商协议是 `anthropic`,
      `encode/anthropic.ts` 首发就写 `x-api-key`,401 重发路径 `transport.ts` 的
      `authHeader` 对 anthropic 也返回 `x-api-key` —— 两条路径本来就对。
      在这里再写一遍等于给同一件事开第二个真相来源。
    */
    transport: (_cred: OAuthCredential, _ctx: TransportContext): UpstreamTransport => ({
      headers: { ...ZCODE_HEADERS },
      body: (body) => body
    })
  }
}
