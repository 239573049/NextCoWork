/**
 * Kimi(kimi-code)登录链路。
 *
 * ★ 和 zcode 那份同一个立场:这里测的**不是**能不能真登上去,而是**字段映射**和
 * **那几条会静默烂掉的规矩** —— 身份从哪来、刷新会不会把用户踢下线、设备头有没有
 * 盖住三条路径。这三件事错了的表现全是「登录看着成功,过一会儿莫名其妙掉线」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '../../../../../shared/domain/credential'
import { OAuthFailedError } from '../../errors'
import type { OAuthExchangeContext } from '../../registry'
import { KIMI_CODE_OAUTH, KIMI_HEADERS } from '../kimi'

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

const TOKENS = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }

const CRED: OAuthCredential = {
  kind: 'oauth',
  issuer: 'kimi-code',
  accessToken: 'at-old',
  refreshToken: 'rt-old',
  expiresAt: NOW,
  accountId: 'u-42',
  email: 'a@b.test',
  planType: 'Pro',
  refreshedAt: NOW
}

describe('KIMI_CODE_OAUTH · 规格表的形状', () => {
  it('★★ 是设备码流程，不是授权码 —— 这条路上没有 redirect_uri 这个概念', () => {
    expect(KIMI_CODE_OAUTH.grant.kind).toBe('device-code')
    expect(KIMI_CODE_OAUTH.pkce).toBe(false)
    expect(KIMI_CODE_OAUTH.scope).toBeUndefined()
  })

  it('★ 设备码端点和换 token 端点是同一个 host 上的两条路径', () => {
    const grant = KIMI_CODE_OAUTH.grant
    const deviceUrl = grant.kind === 'device-code' ? grant.deviceAuthorizationUrl : ''
    expect(new URL(deviceUrl).origin).toBe(new URL(KIMI_CODE_OAUTH.tokenUrl).origin)
    expect(deviceUrl).not.toBe(KIMI_CODE_OAUTH.tokenUrl)
  })

  it('★★ 设备头挂在 oauthHeaders 上 —— 只有它才盖得住申请码/换码/刷新三跳', () => {
    /*
      放进 `tokenRequest().headers` 的话只盖得住换码那一跳,漏掉的表现是
      「能登录、第二天刷新 403」,而错误信息里不会出现任何一个头的名字。
    */
    expect(KIMI_CODE_OAUTH.oauthHeaders).toBe(KIMI_HEADERS)
    for (const key of [
      'User-Agent',
      'X-Msh-Platform',
      'X-Msh-Version',
      'X-Msh-Device-Id'
    ] as const) {
      expect(KIMI_HEADERS[key], key).toBeTruthy()
    }
  })

  it('★ X-Msh-Device-Id 是一个合法 UUID，而且跨次读取稳定', () => {
    // 上游用它数设备:每次启动换一个的表现是用户的设备列表里堆满同一台机器
    expect(KIMI_HEADERS['X-Msh-Device-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('★ 设备头全是 ASCII —— 中文机器名会让 fetch 在写头的时候就抛', () => {
    for (const [k, v] of Object.entries(KIMI_HEADERS)) {
      expect(/^[\x20-\x7e]*$/.test(v), `${k}=${v}`).toBe(true)
    }
  })

  it('鉴权头不在 transport 里写 —— 它由 openai-chat 的编码器首发', () => {
    const t = KIMI_CODE_OAUTH.transport?.(CRED, {
      protocol: 'openai-chat',
      sessionId: 's'
    } as never)
    const headers = Object.keys(t?.headers ?? {}).map((k) => k.toLowerCase())
    expect(headers).not.toContain('authorization')
    expect(headers).toContain('x-msh-platform')
  })
})

describe('KIMI_CODE_OAUTH · identity', () => {
  it('★★ 相对秒数当场折成绝对毫秒 —— 相对值一落盘就开始腐烂', () => {
    const id = KIMI_CODE_OAUTH.identity(
      { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, accountId: 'u-1' },
      NOW
    )
    expect(id?.expiresAt).toBe(NOW + 3_600_000)
  })

  it('少了三个必需字段里的任何一个都判无效（= 让用户重新登录）', () => {
    expect(
      KIMI_CODE_OAUTH.identity({ accessToken: 'at', refreshToken: 'rt', expiresIn: 60 }, NOW)
    ).toBeNull()
    expect(KIMI_CODE_OAUTH.identity({ accessToken: 'at', accountId: 'u' }, NOW)).toBeNull()
    expect(KIMI_CODE_OAUTH.identity('不是对象', NOW)).toBeNull()
  })

  it('email / planType 拿不到就整个字段不出现，而不是空串', () => {
    const id = KIMI_CODE_OAUTH.identity(
      { accessToken: 'at', refreshToken: 'rt', expiresIn: 60, accountId: 'u-1' },
      NOW
    )
    expect(id).not.toBeNull()
    expect(Object.hasOwn(id as object, 'email')).toBe(false)
    expect(Object.hasOwn(id as object, 'planType')).toBe(false)
  })
})

describe('KIMI_CODE_OAUTH · finishExchange', () => {
  it('★★ 用 Bearer + 设备头去打 /me，账号身份只有这一个来源', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) }
      })
      return jsonResponse({
        user_id: 'u-42',
        email: 'a@b.test',
        user_level_name: 'Pro'
      })
    }) as unknown as typeof globalThis.fetch

    const exchanged = await KIMI_CODE_OAUTH.finishExchange?.(TOKENS, ctxWith(fetchImpl))
    expect(seen[0]?.url).toBe('https://api.kimi.com/coding/v1/me')
    expect(seen[0]?.headers['authorization']).toBe('Bearer at-1')
    expect(seen[0]?.headers['X-Msh-Platform']).toBe(KIMI_HEADERS['X-Msh-Platform'])

    // 中间形态原样交给 identity —— 两者串起来才是一条完整凭证
    const id = KIMI_CODE_OAUTH.identity(exchanged, NOW)
    expect(id).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3_600_000,
      accountId: 'u-42',
      email: 'a@b.test',
      planType: 'Pro'
    })
  })

  it('包了一层 data 的响应也认得出来', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: { global_id: 'g-7', domain_name: 'kimi.com' }
      })) as typeof globalThis.fetch
    const exchanged = await KIMI_CODE_OAUTH.finishExchange?.(TOKENS, ctxWith(fetchImpl))
    const id = KIMI_CODE_OAUTH.identity(exchanged, NOW)
    // ★ user_id 缺席时退到 global_id;两者都没有才算失败
    expect(id?.accountId).toBe('g-7')
    expect(id?.planType).toBe('kimi.com')
  })

  it('★★ /me 里没有账号 id 就当场失败，不放一条没有身份的凭证过去', async () => {
    /*
      放过去的表现是 `parseCredential` 拒收 ——「登录成功、下一秒显示未登录」,
      一个完全不指向 /me 的症状。这里宁可在原地报错。
    */
    const fetchImpl = (async () => jsonResponse({ nickname: '没有 id' })) as typeof globalThis.fetch
    await expect(
      KIMI_CODE_OAUTH.finishExchange?.(TOKENS, ctxWith(fetchImpl))
    ).rejects.toBeInstanceOf(OAuthFailedError)
  })

  it('/me 返回非 2xx 也是登录失败（和 zcode 的邮箱不同，这一跳不是装饰）', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: 'unauthorized' }, 401)) as typeof globalThis.fetch
    await expect(
      KIMI_CODE_OAUTH.finishExchange?.(TOKENS, ctxWith(fetchImpl))
    ).rejects.toBeInstanceOf(OAuthFailedError)
  })

  it('★ expires_in 不是正数就判整个响应无效，不补一个 0 存进去', async () => {
    /*
      存了 0 的表现是**每一次请求前都判过期、每一次都去刷新** —— 看起来像上游限流。
    */
    const fetchImpl = (async () => jsonResponse({ user_id: 'u' })) as typeof globalThis.fetch
    for (const bad of [0, -1, undefined, '3600']) {
      await expect(
        KIMI_CODE_OAUTH.finishExchange?.(
          { access_token: 'at', refresh_token: 'rt', expires_in: bad },
          ctxWith(fetchImpl)
        ),
        String(bad)
      ).rejects.toBeInstanceOf(OAuthFailedError)
    }
  })
})

describe('KIMI_CODE_OAUTH · refresh', () => {
  it('★★ 刷新保住旧的 accountId —— token 响应里一个身份字段都没有', async () => {
    /*
      丢掉它的表现是 `CredentialResolver` 拿到一条缺 accountId 的凭证 → `markReauth`
      →「每刷新一次就把用户踢下线一次」。zcode 那条踩过同一个坑。
    */
    let body = ''
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? '')
      headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      return jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 })
    }) as unknown as typeof globalThis.fetch

    const next = await KIMI_CODE_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))
    expect(next).toEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: NOW + 7_200_000,
      accountId: 'u-42',
      email: 'a@b.test',
      planType: 'Pro'
    })

    const form = new URLSearchParams(body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-old')
    expect(form.get('client_id')).toBe(KIMI_CODE_OAUTH.clientId)
    // ★ 刷新这一跳同样要带设备头
    expect(headers['X-Msh-Platform']).toBe(KIMI_HEADERS['X-Msh-Platform'])
  })

  it('刷新被拒是一次故障，不是悄悄返回旧凭证', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: 'invalid_grant' }, 400)) as typeof globalThis.fetch
    await expect(KIMI_CODE_OAUTH.refresh?.(CRED, ctxWith(fetchImpl))).rejects.toBeInstanceOf(
      OAuthFailedError
    )
  })
})
