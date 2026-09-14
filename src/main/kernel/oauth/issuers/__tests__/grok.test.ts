/**
 * Grok Build(grok-build)登录链路。
 *
 * ★ 立场同 kimi/zcode 那两份:这里**不测能不能真登上去**,测的是那几条
 * 「错了也不会当场报错」的规矩 —— scope 发不发、身份从哪几个 claim 里挑、
 * 刷新会不会把用户踢下线、那几个头有没有挂在能盖住三跳的位置上。
 * 这几件事的共同表现都是「登录看着成功,然后莫名其妙地 401 / 426 / 掉线」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '../../../../../shared/domain/credential'
import { OAuthFailedError } from '../../errors'
import type { OAuthExchangeContext } from '../../registry'
import { GROK_BUILD_OAUTH } from '../grok'

/** 造一个**未签名**的 JWT —— 我们的解码从设计上就不验签(见 `issuers/shared.ts`) */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const NOW = 1_700_000_000_000

function ctxWith(fetchImpl: typeof globalThis.fetch): OAuthExchangeContext {
  return { fetch: fetchImpl, signal: new AbortController().signal, now: NOW }
}

const ID_TOKEN = jwt({ sub: 'u-42', email: 'a@b.test' })
const ACCESS_TOKEN = jwt({ principal_id: 'p-7', sub: 'u-42' })

const TOKENS = {
  access_token: ACCESS_TOKEN,
  refresh_token: 'rt-1',
  id_token: ID_TOKEN,
  expires_in: 3600
}

const CRED: OAuthCredential = {
  kind: 'oauth',
  issuer: 'grok-build',
  accessToken: 'at-old',
  refreshToken: 'rt-old',
  expiresAt: NOW,
  accountId: 'u-42',
  email: 'a@b.test',
  refreshedAt: NOW
}

describe('GROK_BUILD_OAUTH · 规格表的形状', () => {
  it('★★ 是设备码流程，不是授权码 —— 这条路上没有 redirect_uri 这个概念', () => {
    expect(GROK_BUILD_OAUTH.grant.kind).toBe('device-code')
    expect(GROK_BUILD_OAUTH.pkce).toBe(false)
  })

  it('★★★ scope 必须发，而且必须含 grok-cli:access', () => {
    /*
      2026-09-14 实测:只发 client_id 申请设备码照样 200、配对码一应俱全,
      但换回来那把令牌不带 `grok-cli:access` —— 表现是**登录一路成功、
      第一条消息 401**,而错误信息里一个字都不提 scope。
      `offline_access` 同理:没它就没有 refresh_token,表现是今天能用、明早掉线。
    */
    expect(GROK_BUILD_OAUTH.scope).toBeDefined()
    const scopes = (GROK_BUILD_OAUTH.scope ?? '').split(' ')
    expect(scopes).toContain('grok-cli:access')
    expect(scopes).toContain('offline_access')
  })

  it('★ client_id 是实测过的那个 public client（假 UUID 回 400 invalid_client）', () => {
    expect(GROK_BUILD_OAUTH.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828')
  })

  it('★ 设备码端点和换 token 端点同在 auth.x.ai，且不是同一条路径', () => {
    const grant = GROK_BUILD_OAUTH.grant
    const deviceUrl = grant.kind === 'device-code' ? grant.deviceAuthorizationUrl : ''
    expect(new URL(deviceUrl).origin).toBe('https://auth.x.ai')
    expect(new URL(GROK_BUILD_OAUTH.tokenUrl).origin).toBe('https://auth.x.ai')
    expect(deviceUrl).not.toBe(GROK_BUILD_OAUTH.tokenUrl)
  })

  it('★★ x-grok-client-version 挂在 oauthHeaders 上 —— 只有它盖得住三跳', () => {
    expect(GROK_BUILD_OAUTH.oauthHeaders?.['x-grok-client-version']).toBeTruthy()
  })
})

describe('GROK_BUILD_OAUTH · transport', () => {
  const t = GROK_BUILD_OAUTH.transport(CRED, {
    protocol: 'openai-responses',
    sessionId: 's-1'
  } as never)

  it('★★ 缺 x-grok-client-version 是 426 不是 401 —— 所以业务请求上也必须带', () => {
    expect(t.headers['x-grok-client-version']).toBe(
      GROK_BUILD_OAUTH.oauthHeaders?.['x-grok-client-version']
    )
  })

  it('★★ X-XAI-Token-Auth 决定后端路由，不是装饰', () => {
    /*
      实测 401 的 `www-authenticate` 自己把话说清楚了:带 bearer 而不带这个头时
      `upstream=Unauthenticated`,两个都带时是 `upstream=PermissionDenied` ——
      不同的 upstream 说明它真的改了路由。
    */
    expect(t.headers['X-XAI-Token-Auth']).toBe('xai-grok-cli')
  })

  it('★★★ 诚实地报自己的名字，不冒充官方 CLI', () => {
    // 上游对这个头不做白名单(用自己的包名发真实请求拿到的是 200),
    // 冒充换不到任何东西,却会让上游的用量统计和限流认不出我们。
    expect(t.headers['x-grok-client-identifier']).toBe('nextcowork')
    expect(Object.values(t.headers)).not.toContain('grok-shell')
  })

  it('★ Authorization 不在这里写 —— 它由 OpenAI 族的编码器首发', () => {
    const keys = Object.keys(t.headers).map((k) => k.toLowerCase())
    expect(keys).not.toContain('authorization')
  })

  it('★ 会话标识发的是折算过的 UUID，不是我们自己的 session id 原文', () => {
    expect(t.headers['x-grok-session-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(t.headers['x-grok-session-id']).not.toBe('s-1')
  })

  it('★ body 不动 —— 没拿到证据就不按字段，按错了是我们自己制造的 400', () => {
    const original = { model: 'grok-build', store: true, input: [] }
    expect(t.body(original)).toEqual(original)
  })

  it('所有头都是 ASCII —— 非 ASCII 会让 fetch 在写头的时候就抛', () => {
    for (const [k, v] of Object.entries(t.headers)) {
      expect(/^[\x20-\x7e]*$/.test(v), `${k}=${v}`).toBe(true)
    }
  })
})

describe('GROK_BUILD_OAUTH · identity', () => {
  it('★★ 相对秒数当场折成绝对毫秒 —— 相对值一落盘就开始腐烂', () => {
    expect(GROK_BUILD_OAUTH.identity(TOKENS, NOW)?.expiresAt).toBe(NOW + 3_600_000)
  })

  it('身份优先取 id_token 的 sub / email', () => {
    expect(GROK_BUILD_OAUTH.identity(TOKENS, NOW)).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'rt-1',
      expiresAt: NOW + 3_600_000,
      accountId: 'u-42',
      email: 'a@b.test'
    })
  })

  it('★★ 没有 id_token 时退到 access_token 自己的 claim', () => {
    // 官方 CLI 的刷新响应就可能不带 id_token —— 这条路不是理论情形
    const id = GROK_BUILD_OAUTH.identity({ ...TOKENS, id_token: undefined }, NOW)
    expect(id?.accountId).toBe('p-7')
  })

  it('★★★ 团队席位走 principal_id，只读 sub 的话那批用户登录成功后立刻显示未登录', () => {
    const id = GROK_BUILD_OAUTH.identity(
      {
        access_token: jwt({ principal_id: 'team-9' }),
        refresh_token: 'rt',
        expires_in: 60
      },
      NOW
    )
    expect(id?.accountId).toBe('team-9')
  })

  it('★★ 拿不到 refresh_token 判失败 —— 存下去的表现是今天能用、明早掉线', () => {
    expect(
      GROK_BUILD_OAUTH.identity({ access_token: ACCESS_TOKEN, expires_in: 60 }, NOW)
    ).toBeNull()
  })

  it('解不出任何账号 id 就判无效（= 让用户重新登录）', () => {
    expect(
      GROK_BUILD_OAUTH.identity(
        { access_token: '不是 JWT', refresh_token: 'rt', expires_in: 60 },
        NOW
      )
    ).toBeNull()
    expect(GROK_BUILD_OAUTH.identity('不是对象', NOW)).toBeNull()
  })

  it('email 拿不到就整个字段不出现，而不是空串', () => {
    const id = GROK_BUILD_OAUTH.identity(
      { access_token: jwt({ sub: 'u-1' }), refresh_token: 'rt', expires_in: 60 },
      NOW
    )
    expect(id).not.toBeNull()
    expect(Object.hasOwn(id as object, 'email')).toBe(false)
  })
})

describe('GROK_BUILD_OAUTH · refresh', () => {
  it('★ 发标准的 refresh_token 表单，且这一跳也带客户端版本头', () => {
    let body = ''
    let headers: Record<string, string> = {}
    let url = ''
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input)
      body = String(init?.body ?? '')
      headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      return jsonResponse({
        access_token: jwt({ sub: 'u-42' }),
        refresh_token: 'rt-2',
        expires_in: 7200
      })
    }) as unknown as typeof globalThis.fetch

    return GROK_BUILD_OAUTH.refresh?.(CRED, ctxWith(fetchImpl)).then((next) => {
      expect(url).toBe('https://auth.x.ai/oauth2/token')
      const form = new URLSearchParams(body)
      expect(form.get('grant_type')).toBe('refresh_token')
      expect(form.get('refresh_token')).toBe('rt-old')
      expect(form.get('client_id')).toBe(GROK_BUILD_OAUTH.clientId)
      expect(headers['x-grok-client-version']).toBe(
        GROK_BUILD_OAUTH.oauthHeaders?.['x-grok-client-version']
      )
      expect(next?.expiresAt).toBe(NOW + 7_200_000)
    })
  })

  it('★★★ 新令牌解不出身份时沿用旧的 —— 否则每刷新一次就把用户踢下线一次', async () => {
    /*
      这条正是**不能**用 `standardRefresh` 的全部理由:它把响应原样喂给
      `identity()`,而刷新响应不保证带 id_token;`identity()` 返回 null 在
      `CredentialResolver` 里的语义是「凭证已失效」。
    */
    const fetchImpl = (async () =>
      jsonResponse({ access_token: '不是 JWT', expires_in: 7200 })) as typeof globalThis.fetch

    const next = await GROK_BUILD_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))
    expect(next).toEqual({
      accessToken: '不是 JWT',
      // ★ 上游不轮换 refresh token 时沿用旧的
      refreshToken: 'rt-old',
      expiresAt: NOW + 7_200_000,
      accountId: 'u-42',
      email: 'a@b.test'
    })
  })

  it('★ 连 access_token 都没有才返回 null（真的换不到令牌）', async () => {
    const fetchImpl = (async () => jsonResponse({ ok: true })) as typeof globalThis.fetch
    expect(await GROK_BUILD_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))).toBeNull()
  })

  it('刷新被拒是一次故障，而且错误里带着上游原话', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Invalid or unknown refresh token' },
        400
      )) as typeof globalThis.fetch
    const p = GROK_BUILD_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))
    await expect(p).rejects.toBeInstanceOf(OAuthFailedError)
    await expect(GROK_BUILD_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))).rejects.toThrow(
      /invalid_grant/u
    )
  })
})
