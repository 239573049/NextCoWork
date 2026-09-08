/**
 * OAuth 授权码流程的**通用编排** —— 一份代码跑所有 issuer。
 *
 * ★★ 这里没有任何一家的知识:端点、client_id、回调怎么接、怎么提账号身份,
 * 全部从 `OAuthProviderSpec` 里读(见 `registry.ts` 的文件头)。加一家 = 加一行数据。
 *
 * ★ 零 Electron import。`shell.openExternal` 是**注入**进来的(`openBrowser`),
 * `fetch` 和 `now` 也是 —— 于是整条流程可以在纯 Node 里用假上游跑完。
 */
import type { OAuthCredential } from '../../../shared/domain/credential'
import { awaitOAuthCallback, type LoopbackResult } from '../../net/oauth-loopback'
import { createPkce, randomState } from './pkce'
import { redirectUriOf, type OAuthProviderSpec } from './registry'

export type OAuthPhase =
  | 'opening'
  | 'waiting'
  | 'exchanging'
  | 'done'
  | 'failed'
  | 'cancelled'

/** 用户放弃(关掉授权页 / 点了取消 / 超时)。**不是故障**,上层据此不报错误红条 */
export class OAuthAbandonedError extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout') {
    super(kind === 'timeout' ? '授权超时' : '已取消登录')
    this.name = 'OAuthAbandonedError'
  }
}

/** 授权服务器明确拒绝,或者回来的东西不对 */
export class OAuthFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthFailedError'
  }
}

export interface OAuthFlowDeps {
  spec: OAuthProviderSpec
  /**
   * ★ 注入 `host.fetch` 不只是为了可测:它是 Electron 的 `net.fetch`,走 Chromium
   * 网络栈,于是**设置页那份代理配置对换 token 这一步一样生效**。用全局 fetch 的话,
   * 企业代理后面的用户会遇到「授权页能开、换 token 超时」这种只在这一步失败的怪象。
   */
  fetch: typeof globalThis.fetch
  now: () => number
  openBrowser: (url: string) => Promise<void>
  onPhase?: (phase: OAuthPhase) => void
  signal: AbortSignal
  /** `manual-paste` 形态下,等用户把 code 粘回来 */
  awaitPastedCode?: () => Promise<string>
}

function authorizeUrl(
  spec: OAuthProviderSpec,
  args: { challenge: string; state: string; redirectUri: string }
): string {
  const u = new URL(spec.authorizeUrl)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', spec.clientId)
  u.searchParams.set('redirect_uri', args.redirectUri)
  u.searchParams.set('scope', spec.scope)
  u.searchParams.set('state', args.state)
  u.searchParams.set('code_challenge', args.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(spec.extraAuthorizeParams ?? {})) {
    u.searchParams.set(k, v)
  }
  return u.toString()
}

/**
 * 换 token。授权码流程和刷新流程共用这一个 —— 两边的差别只有 body 里那几个字段,
 * 而**错误处理、超时、内容类型这些坑是同一批**,写两遍就会有一遍漏掉。
 */
export async function postToken(
  spec: OAuthProviderSpec,
  fetchImpl: typeof globalThis.fetch,
  form: Record<string, string>,
  signal: AbortSignal
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: string }> {
  const body = new URLSearchParams({ ...form, ...(spec.extraTokenParams ?? {}) })
  const res = await fetchImpl(spec.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, body: text }
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, status: res.status, body: text }
  }
}

async function collectCode(
  deps: OAuthFlowDeps,
  args: { challenge: string; state: string; redirectUri: string }
): Promise<string> {
  await deps.openBrowser(authorizeUrl(deps.spec, args))
  deps.onPhase?.('waiting')
  if (deps.awaitPastedCode === undefined) {
    throw new OAuthFailedError('这家需要手动粘贴授权码，但没有提供输入通道')
  }
  const pasted = (await deps.awaitPastedCode()).trim()
  if (pasted === '') throw new OAuthAbandonedError('cancelled')
  return pasted
}

function describe(result: LoopbackResult): never {
  if (result.status === 'cancelled' || result.status === 'timeout') {
    throw new OAuthAbandonedError(result.status)
  }
  throw new OAuthFailedError(result.reason ?? '授权未完成')
}

export async function runOAuthFlow(deps: OAuthFlowDeps): Promise<OAuthCredential> {
  const { spec, signal } = deps
  const pkce = createPkce()
  const state = randomState()

  let code: string
  /*
    ★★ redirect_uri 在**授权请求**和**换 token 请求**里必须逐字相同 —— 服务端会
    比对这两处,不一致就是一个不说明原因的 `invalid_grant`。所以它只算一次,
    算完两处都用这一个变量,而不是各拼一遍。
  */
  let redirectUri = redirectUriOf(spec)

  deps.onPhase?.('opening')

  if (spec.redirect.kind === 'manual-paste') {
    code = await collectCode(deps, { challenge: pkce.challenge, state, redirectUri })
  } else {
    /*
      ★★ **先把服务器起起来,再打开浏览器。** 反过来有一个真实的竞态:
      用户的浏览器可能已经缓存了授权同意,授权页一闪而过就打回来 —— 而那时
      我们还没 listen,回调撞上 ECONNREFUSED。用户看到一个连不上的错误页,
      而应用这边还停在「等待授权」。所以打开浏览器这一步挂在 `onListening` 上。
    */
    let opened = false
    /**
     * ★ 打不开浏览器必须**当场结束等待**,不能让它干等到 5 分钟超时。
     * 没有这个的话,`openExternal` 失败(没有默认浏览器、被策略禁掉)的表现是
     * 界面转五分钟然后说「授权超时」—— 一句和真实原因毫无关系的话。
     */
    let openError: unknown = null
    const inner = new AbortController()
    const forward = (): void => inner.abort()
    signal.addEventListener('abort', forward, { once: true })

    const fixedPort = spec.redirect.kind === 'loopback-fixed' ? spec.redirect.port : 0

    let result: LoopbackResult
    try {
      result = await awaitOAuthCallback({
        expectedState: state,
        signal: inner.signal,
        path: spec.redirect.path,
        port: fixedPort,
        onListening: (bound) => {
          if (opened) return
          opened = true
          redirectUri = redirectUriOf(spec, bound)
          /*
            ★ `waiting` 在**发起**打开浏览器时就推,不挂在 `openBrowser().then()` 上。
            挂上去的话,浏览器缓存了授权同意时回调会先回来,于是阶段倒着走 ——
            界面先显示「完成」再跳回「等待授权中」并卡在那儿。
          */
          deps.onPhase?.('waiting')
          void deps
            .openBrowser(authorizeUrl(spec, { challenge: pkce.challenge, state, redirectUri }))
            .catch((e: unknown) => {
              openError = e
              inner.abort()
            })
        }
      })
    } finally {
      signal.removeEventListener('abort', forward)
    }

    if (openError !== null) {
      const detail = openError instanceof Error ? openError.message : String(openError)
      throw new OAuthFailedError(`打不开浏览器：${detail}`)
    }
    // 外层 signal 被取消时,内层也 abort 了 —— 两者都归到「用户放弃」
    if (result.status !== 'ok' || result.code === undefined) describe(result)
    code = result.code
  }

  deps.onPhase?.('exchanging')
  const token = await postToken(
    spec,
    deps.fetch,
    {
      grant_type: 'authorization_code',
      code,
      client_id: spec.clientId,
      // ★ 这里的 redirect_uri 必须和授权请求里那个**逐字相同** —— 服务端会比对,
      //   不一致就是一个不说明原因的 invalid_grant。所以两处都从 redirectUriOf 来
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier
    },
    signal
  )
  if (!token.ok) {
    throw new OAuthFailedError(`换取凭证失败（HTTP ${token.status}）：${token.body.slice(0, 300)}`)
  }

  const identity = spec.identity(token.json, deps.now())
  if (identity === null) {
    throw new OAuthFailedError('授权信息不完整（缺少账号 id 或令牌），请重试登录')
  }

  deps.onPhase?.('done')
  return {
    kind: 'oauth',
    issuer: spec.id,
    accessToken: identity.accessToken,
    refreshToken: identity.refreshToken,
    expiresAt: identity.expiresAt,
    accountId: identity.accountId,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.planType === undefined ? {} : { planType: identity.planType }),
    refreshedAt: deps.now()
  }
}
