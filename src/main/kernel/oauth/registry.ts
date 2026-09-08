/**
 * OAuth 授权服务器的**规格表** —— 一家一行数据,不是一堆 if。
 *
 * ★★ **这个文件存在的理由:整条链路上只有四处需要「按 issuer 分流」的知识,
 * 把它们收进一张表,加第二家就只是加一行。** 那四处是:
 *
 * | 知识 | 谁要 | ChatGPT | 未来的 Anthropic |
 * |---|---|---|---|
 * | 端点 / client_id / scope | 发起登录 | auth.openai.com | claude.ai/oauth |
 * | 回调怎么接 | 回环服务器 | 固定端口 1455 | 手动粘贴 code |
 * | 怎么提账号身份 | 换完 token | id_token 的 chatgpt_account_id | 另一个 claim |
 * | 发请求带什么头 | router 最终线上边界 | chatgpt-account-id + store:false | 别的 |
 *
 * 散着写的话,加第二家要去四个文件里各加一个分支,而漏掉第四处的表现是
 * **登录成功、第一次对话 403** —— 一个指不回原因的症状。
 *
 * ★ **规格留在 main,不进 `src/shared/`。** `client_id` / `redirect_uri` 是主进程事实;
 * 放进 shared 等于邀请渲染层去 import 它们,而渲染层碰不得这条流程的任何一半 ——
 * 授权 URL 带着我们自己生成的 state,从渲染层过一遍手就等于把 CSRF 防线交给了它。
 * 需要跨进程的只有 `OAuthIssuerId` 那个纯类型,它在 `shared/domain/oauth-issuer.ts`。
 */
import type { OAuthCredential, OAuthIssuerId } from '../../../shared/domain/credential'
// ★ type-only import:`transport.ts` 反过来要 import 本文件的 `oauthSpecOf`(值),
// 编译后类型被擦掉,不构成运行时循环依赖
import type { TransportContext, UpstreamTransport } from '../upstream/transport'
import { CHATGPT_OAUTH } from './issuers/chatgpt'
import { ZCODE_BIGMODEL_OAUTH } from './issuers/zcode-bigmodel'
import { ZCODE_ZAI_OAUTH } from './issuers/zcode-zai'

/**
 * 回环回调的主机名。
 *
 * ★ `localhost` 和 `127.0.0.1` **不能混用**:redirect_uri 要逐字节等于该 client
 * 注册的那个值,而不同家注册的写法不同(Codex 注册的是 `localhost`,
 * ZCode CLI 注册的是 `127.0.0.1`)。这个差异只会在**换 token 那一步**炸,
 * 且 authorize 阶段完全不校验(2026-09-09 实测 z.ai:三种 redirect_uri 一律放行),
 * 所以没有任何早期信号 —— 只能按各家文档逐字写死。
 */
export type LoopbackHost = 'localhost' | '127.0.0.1'

/**
 * 回调策略。**三种形态都是真实存在的**,不是为扩展性预留的空壳:
 * - Codex 注册的 redirect_uri 写死 `http://localhost:1455/auth/callback`
 * - 有的家注册的是通配 `http://localhost`,端口运行时取
 * - Claude Code 那条是把 code 显示在授权页上让用户粘回来
 */
export type OAuthRedirect =
  /** ★ 固定端口。redirect_uri 必须**逐字节**等于注册值,换端口 = authorize 直接 400 */
  | { kind: 'loopback-fixed'; port: number; path: string; host?: LoopbackHost }
  /** 临时端口,bind 完才知道是几号 */
  | { kind: 'loopback-ephemeral'; path: string; host?: LoopbackHost }
  /** 授权页把 code 显示出来,用户粘回应用 */
  | { kind: 'manual-paste'; redirectUri: string }

/**
 * `identity()` 从 token 响应里提出来的东西 —— 正好是 `OAuthCredential` 里非派生的那些字段
 */
export interface OAuthIdentity {
  accessToken: string
  refreshToken: string
  /**
   * ★ `null` = **过期时间未知**,不是「永不过期」。
   * 有的家(z.ai)`expires_in` 就是 null,而**编一个假的过期时间比没有更糟**:
   * 猜短了平白多刷几次,猜长了会带着一把死 token 去撞 401 并把那次对话废掉。
   * 未知时的策略是不主动刷新、靠 401 触发 —— 那条路径本来就存在(`router.ts`)。
   */
  expiresAt: number | null
  accountId: string
  email?: string
  planType?: string
}

/** 拼授权 URL 时,流程能提供给 spec 的全部素材 */
export interface OAuthAuthorizeArgs {
  clientId: string
  redirectUri: string
  state: string
  /** PKCE challenge。`pkce: false` 的家用不上 */
  challenge: string
}

/** 换 token 时,流程能提供给 spec 的全部素材 */
export interface OAuthTokenRequestArgs {
  code: string
  redirectUri: string
  /** PKCE verifier。`pkce: false` 的家用不上它,但仍然照常生成(不花钱) */
  verifier: string
  state: string
  clientId: string
}

/**
 * 一次 token 请求长什么样。
 *
 * ★ `contentType` 是**必需**的而不是可选默认:标准 OAuth 是 form,而 ZCode 那条是
 * JSON,两者发错的表现都是一个不解释原因的 4xx/5xx。让它显式,读代码时一眼看得见。
 */
export interface OAuthTokenRequest {
  contentType: 'form' | 'json'
  body: Readonly<Record<string, unknown>>
  /** 各家的私货头(User-Agent 白名单、Referer 校验之类) */
  headers?: Readonly<Record<string, string>>
}

/** `finishExchange` / `refresh` 这类要自己发请求的钩子能拿到的东西 */
export interface OAuthExchangeContext {
  /** ★ 和流程用的是同一个 fetch —— 于是设置页那份代理配置对这一跳一样生效 */
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  now: number
}

export interface OAuthProviderSpec {
  id: OAuthIssuerId
  /** 登录按钮上的名字(「使用 __ 账号登录」)。带进 i18n 参数,加一家不用加新文案键 */
  label: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  /** ★ 省略 = 授权 URL 里**根本不写** `scope` 这个参数(不是写成空串) */
  scope?: string
  /**
   * ★ 默认 `true`。置 `false` 才能让授权 URL 里**没有** `code_challenge` ——
   * 这件事 `extraAuthorizeParams` 做不到,它只能覆盖不能删。
   * 不支持 PKCE 的授权服务器收到这两个参数时的反应各不相同,有的直接报错。
   */
  pkce?: boolean
  redirect: OAuthRedirect
  /** 各家在授权 URL 上的私货(`access_type=offline` / `code=true` / …) */
  extraAuthorizeParams?: Readonly<Record<string, string>>
  /**
   * 授权 URL 上的**全部**查询参数。省略 = 标准的
   * `response_type` / `client_id` / `redirect_uri` / `scope` / `state` / PKCE 那一套。
   *
   * ★★ 整体替换而不是「加几个字段」,和 `tokenRequest` 同一个理由:有的家(智谱)
   * 的授权入口压根不是 OAuth 授权端点,而是一个登录页,吃的是
   * `appId` / `redirect` / `state` —— 标准那三个参数一个都不认。增量式的接口
   * 表达不了「删掉标准字段」,而 `extraAuthorizeParams` 只能覆盖不能删。
   *
   * ★ `extraAuthorizeParams` 仍然会在这之后叠加,两者不互斥。
   */
  authorizeParams?(args: OAuthAuthorizeArgs): Readonly<Record<string, string>>
  /**
   * 回调里装授权码的那个查询参数名。**省略 = `code`(标准)。**
   *
   * ★ 2026-09-09 实测:智谱那条回调回来的是 `zcode://oauth/callback?authCode=…&state=…`
   * —— 参数名是 `authCode`。按 `code` 去取的表现是一句「这段内容里没有授权码」,
   * 而用户手里明明有一条带着授权码的回调地址。
   */
  callbackCodeParam?: string
  extraTokenParams?: Readonly<Record<string, string>>
  /**
   * 换 token 的请求体。**省略 = 标准的 `grant_type=authorization_code` 表单。**
   *
   * ★ 整体替换而不是「加几个字段」:ZCode 那条连 `grant_type` 和 `client_id`
   * 都没有,增量式的接口表达不了「删掉标准字段」。
   */
  tokenRequest?(args: OAuthTokenRequestArgs): OAuthTokenRequest
  /**
   * token 端点回来之后的**第二跳**。省略 = 恒等,返回值直接喂给 `identity()`。
   *
   * ★★ 存在的理由:`identity()` 是**同步纯函数**(它要能被测试摆布 `now`),
   * 发不了第二个请求。而 z.ai 那条链路必须两跳才能拿到真正发得出去的令牌。
   * 把第二跳放在这里,`identity()` 的同步契约得以保留。
   */
  finishExchange?(json: unknown, ctx: OAuthExchangeContext): Promise<unknown>
  /**
   * token 响应 → 我们的凭证。**取不到必需字段时返回 null,由调用方判登录失败。**
   *
   * ★ `now` 是**注入**的,函数里禁止 `Date.now()` —— `expiresAt` 是绝对时间戳,
   * 而测试要能摆出「已过期」和「还有 30 秒」两种状态。
   */
  identity(json: unknown, now: number): OAuthIdentity | null
  /**
   * 自定义刷新。省略 = 标准的 `grant_type=refresh_token`。
   *
   * ★ 返回 `null` 会被 `CredentialResolver` 判成「凭证已失效」并把用户登出,
   * 所以**只在真的换不到令牌时才返回 null**;拿不到 accountId 这种事应当沿用旧值,
   * 否则每刷新一次就把用户踢下线一次。
   */
  refresh?(cred: OAuthCredential, ctx: OAuthExchangeContext): Promise<OAuthIdentity | null>
  /** 拿这家的凭证发请求时,额外要带什么头、body 要强制成什么样 */
  transport(cred: OAuthCredential, ctx: TransportContext): UpstreamTransport
}

const SPECS = {
  chatgpt: CHATGPT_OAUTH,
  'zcode-zai': ZCODE_ZAI_OAUTH,
  'zcode-bigmodel': ZCODE_BIGMODEL_OAUTH
} as const satisfies Record<OAuthIssuerId, OAuthProviderSpec>

export const OAUTH_SPECS: Readonly<Record<OAuthIssuerId, OAuthProviderSpec>> = SPECS

export function oauthSpecOf(issuer: OAuthIssuerId): OAuthProviderSpec {
  return OAUTH_SPECS[issuer]
}

/**
 * 这家的 redirect_uri。`loopback-ephemeral` 要等 bind 完才知道端口,所以吃一个参数。
 *
 * ★ 收口到一个函数,是因为**授权请求和换 token 请求里的 redirect_uri 必须逐字相同** ——
 * OAuth 规范要求服务端比对这两处,不一致就是 `invalid_grant`。两处各拼一遍
 * 迟早会有一处多个斜杠,而那个错误信息不会告诉你差在哪。
 */
export function redirectUriOf(spec: OAuthProviderSpec, boundPort?: number): string {
  const r = spec.redirect
  switch (r.kind) {
    case 'loopback-fixed':
      return `http://${r.host ?? 'localhost'}:${r.port}${r.path}`
    case 'loopback-ephemeral':
      return `http://${r.host ?? 'localhost'}:${boundPort ?? 0}${r.path}`
    case 'manual-paste':
      return r.redirectUri
  }
}
