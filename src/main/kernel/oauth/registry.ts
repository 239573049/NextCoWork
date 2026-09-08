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

/**
 * 回调策略。**三种形态都是真实存在的**,不是为扩展性预留的空壳:
 * - Codex 注册的 redirect_uri 写死 `http://localhost:1455/auth/callback`
 * - 有的家注册的是通配 `http://localhost`,端口运行时取
 * - Claude Code 那条是把 code 显示在授权页上让用户粘回来
 */
export type OAuthRedirect =
  /** ★ 固定端口。redirect_uri 必须**逐字节**等于注册值,换端口 = authorize 直接 400 */
  | { kind: 'loopback-fixed'; port: number; path: string }
  /** 临时端口,bind 完才知道是几号 */
  | { kind: 'loopback-ephemeral'; path: string }
  /** 授权页把 code 显示出来,用户粘回应用 */
  | { kind: 'manual-paste'; redirectUri: string }

/** `identity()` 从 token 响应里提出来的东西 —— 正好是 `OAuthCredential` 里非派生的那些字段 */
export interface OAuthIdentity {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  email?: string
  planType?: string
}

export interface OAuthProviderSpec {
  id: OAuthIssuerId
  /** 登录按钮上的名字(「使用 __ 账号登录」)。带进 i18n 参数,加一家不用加新文案键 */
  label: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  scope: string
  redirect: OAuthRedirect
  /** 各家在授权 URL 上的私货(`access_type=offline` / `code=true` / …) */
  extraAuthorizeParams?: Readonly<Record<string, string>>
  extraTokenParams?: Readonly<Record<string, string>>
  /**
   * token 响应 → 我们的凭证。**取不到必需字段时返回 null,由调用方判登录失败。**
   *
   * ★ `now` 是**注入**的,函数里禁止 `Date.now()` —— `expiresAt` 是绝对时间戳,
   * 而测试要能摆出「已过期」和「还有 30 秒」两种状态。
   */
  identity(json: unknown, now: number): OAuthIdentity | null
  /** 拿这家的凭证发请求时,额外要带什么头、body 要强制成什么样 */
  transport(cred: OAuthCredential, ctx: TransportContext): UpstreamTransport
}

const SPECS = {
  chatgpt: CHATGPT_OAUTH
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
      return `http://localhost:${r.port}${r.path}`
    case 'loopback-ephemeral':
      return `http://localhost:${boundPort ?? 0}${r.path}`
    case 'manual-paste':
      return r.redirectUri
  }
}
