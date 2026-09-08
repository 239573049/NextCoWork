/**
 * ZCode 登录链路(Z.AI / 智谱共用实现)。
 *
 * ★ 这里测的**不是**能不能真登上去 —— 那件事只有真跑一次浏览器才知道,计划里
 * 单列了一步。这里守的是**字段映射**:哪一把令牌进哪个槽。那件事一旦搞反,
 * 表现是「登录显示成功、第一次对话 401」,而错误信息一个字都不提凭证。
 */
import { describe, expect, it, vi } from 'vitest'
import { OAuthFailedError } from '../../errors'
import { pastedCallbackCode } from '../../flow'
import type { OAuthExchangeContext } from '../../registry'
import { ZCODE_BIGMODEL_OAUTH } from '../zcode-bigmodel'
import { ZCODE_ZAI_OAUTH } from '../zcode-zai'

/** 造一个**未签名**的 JWT —— 我们的解码从设计上就不验签(见 `issuers/shared.ts`) */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const BUSINESS_JWT = jwt({ user_id: 'u-42' })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function ctxWith(fetchImpl: typeof globalThis.fetch): OAuthExchangeContext {
  return { fetch: fetchImpl, signal: new AbortController().signal, now: 1_000 }
}

describe('ZCODE_ZAI_OAUTH · 授权请求的形状', () => {
  it('★ 不发 PKCE、不发 scope —— 这条链路两样都不支持', () => {
    expect(ZCODE_ZAI_OAUTH.pkce).toBe(false)
    expect(ZCODE_ZAI_OAUTH.scope).toBeUndefined()
  })

  it('★★ redirect_uri 是 127.0.0.1 而不是 localhost（注册值逐字节相等）', () => {
    expect(ZCODE_ZAI_OAUTH.redirect).toEqual({
      kind: 'loopback-fixed',
      port: 9999,
      path: '/callback',
      host: '127.0.0.1'
    })
  })

  it('★★ 换码 body 是 JSON，且没有 grant_type / client_id / code_verifier', () => {
    const req = ZCODE_ZAI_OAUTH.tokenRequest!({
      code: 'the-code',
      redirectUri: 'http://127.0.0.1:9999/callback',
      verifier: 'ignored',
      state: 'st-1',
      clientId: 'ignored'
    })
    expect(req.contentType).toBe('json')
    expect(req.body).toEqual({
      provider: 'zai',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:9999/callback',
      state: 'st-1'
    })
    expect(req.headers?.['user-agent']).toMatch(/^ZCode\//u)
  })
})

describe('ZCODE_ZAI_OAUTH · identity 的字段映射', () => {
  const exchange = {
    oauthAccessToken: 'oauth-at',
    apiToken: BUSINESS_JWT,
    fallbackAccountId: 'u-fallback'
  }

  it('★★★ refreshToken 槽里放的是 ② 的 access_token，不是业务 JWT', () => {
    const id = ZCODE_ZAI_OAUTH.identity(exchange, 1_000)
    // 发出去的那把是业务 JWT
    expect(id?.accessToken).toBe(BUSINESS_JWT)
    // 而「用来再换一次」的是 OAuth access_token —— 这条链路没有真正的 refresh token
    expect(id?.refreshToken).toBe('oauth-at')
  })

  it('★★ expiresAt 是 null（未知），不是编一个出来', () => {
    expect(ZCODE_ZAI_OAUTH.identity(exchange, 1_000)?.expiresAt).toBeNull()
  })

  it('accountId 取业务 JWT 的 user_id', () => {
    expect(ZCODE_ZAI_OAUTH.identity(exchange, 1_000)?.accountId).toBe('u-42')
  })

  it('★ JWT 里解不出 user_id 时退回 ② 给的 user.id —— 不是直接判登录失败', () => {
    const id = ZCODE_ZAI_OAUTH.identity({ ...exchange, apiToken: 'not-a-jwt' }, 1_000)
    expect(id?.accountId).toBe('u-fallback')
  })

  it('★ 两个来源都没有 → null（由调用方判登录失败）', () => {
    expect(
      ZCODE_ZAI_OAUTH.identity({ oauthAccessToken: 'oauth-at', apiToken: 'not-a-jwt' }, 1_000)
    ).toBeNull()
  })

  it('令牌本身缺失 → null', () => {
    expect(ZCODE_ZAI_OAUTH.identity({ apiToken: BUSINESS_JWT }, 1_000)).toBeNull()
    expect(ZCODE_ZAI_OAUTH.identity({ oauthAccessToken: 'x' }, 1_000)).toBeNull()
    expect(ZCODE_ZAI_OAUTH.identity('nope', 1_000)).toBeNull()
  })
})

describe('ZCODE_ZAI_OAUTH · finishExchange（第二跳）', () => {
  const hop2 = {
    code: 0,
    data: { zai: { access_token: 'oauth-at', refresh_token: null }, user: { id: 77 } }
  }

  it('★ 拿 ② 的 access_token 去换业务 JWT，两跳的结果合并后才喂给 identity', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/api/auth/z/login')) {
        return jsonResponse({ code: 0, data: { access_token: BUSINESS_JWT } })
      }
      return jsonResponse({ code: 0, data: { email: 'a@b.test' } })
    }) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_ZAI_OAUTH.finishExchange!(hop2, ctxWith(fetchImpl))
    expect(ZCODE_ZAI_OAUTH.identity(merged, 1_000)).toEqual({
      accessToken: BUSINESS_JWT,
      refreshToken: 'oauth-at',
      expiresAt: null,
      // ★ 数字 id 折成字符串
      accountId: 'u-42',
      email: 'a@b.test'
    })
  })

  it('★ 用户信息那一跳失败**不致命** —— 为一个只用来显示的邮箱赌掉登录不划算', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/auth/z/login')) {
        return jsonResponse({ code: 0, data: { access_token: BUSINESS_JWT } })
      }
      throw new Error('userinfo 挂了')
    }) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_ZAI_OAUTH.finishExchange!(hop2, ctxWith(fetchImpl))
    expect(ZCODE_ZAI_OAUTH.identity(merged, 1_000)?.accessToken).toBe(BUSINESS_JWT)
  })

  it('★★ 信封 code 非 0 → 报错时带上那个 code（2007 = 授权码过期，实测）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    const failed = { code: 2007, msg: 'http error' }
    await expect(ZCODE_ZAI_OAUTH.finishExchange!(failed, ctxWith(fetchImpl))).rejects.toThrow(
      /2007/u
    )
    await expect(
      ZCODE_ZAI_OAUTH.finishExchange!(failed, ctxWith(fetchImpl))
    ).rejects.toBeInstanceOf(OAuthFailedError)
  })

  it('第三跳非 2xx → 失败，且原文带进错误信息', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('nope', { status: 403 })
    ) as unknown as typeof globalThis.fetch
    await expect(ZCODE_ZAI_OAUTH.finishExchange!(hop2, ctxWith(fetchImpl))).rejects.toThrow(/403/u)
  })
})

describe('ZCODE_ZAI_OAUTH · refresh（重跑第三跳）', () => {
  const cred = {
    kind: 'oauth' as const,
    issuer: 'zcode-zai' as const,
    accessToken: '旧 JWT',
    refreshToken: 'oauth-at',
    expiresAt: null,
    accountId: 'u-42'
  }

  it('★ 拿 refreshToken 槽里那个 OAuth access_token 再换一把业务 JWT', async () => {
    const fresh = jwt({ user_id: 'u-42' })
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { access_token: fresh } })
    ) as unknown as typeof globalThis.fetch

    const id = await ZCODE_ZAI_OAUTH.refresh!(cred, ctxWith(fetchImpl))
    expect(id?.accessToken).toBe(fresh)
    // ★ 换来的那把不能覆盖掉「用来再换一次」的那个,否则只能刷新一次
    expect(id?.refreshToken).toBe('oauth-at')
  })

  it('★★ 新 JWT 里解不出 user_id 时沿用旧 accountId —— 否则每刷新一次就把用户踢下线', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { access_token: '不是 JWT' } })
    ) as unknown as typeof globalThis.fetch

    const id = await ZCODE_ZAI_OAUTH.refresh!(cred, ctxWith(fetchImpl))
    expect(id).not.toBeNull()
    expect(id?.accountId).toBe('u-42')
  })
})

describe('ZCODE_BIGMODEL_OAUTH · 探索性渠道', () => {
  it('★★★ 走回环，不走 zcode:// 自定义协议', () => {
    /*
      ★ 这条不是「配置偏好」，是这条渠道能不能拿到码的全部关键。
      照抄 ZCode 的 `zcode://oauth/callback` 会被系统直接交给已装的 ZCode，
      浏览器地址栏里留不下东西 —— 用户实测就是这么失败的。
      `bigmodel.cn` 对 redirect 只有一条 `/^(javascript|data|vbscript):/i` 黑名单，
      没有白名单，所以回环地址是合法的。推导见 `zcode-bigmodel.ts` 文件头。
    */
    expect(ZCODE_BIGMODEL_OAUTH.redirect).toEqual({
      kind: 'loopback-ephemeral',
      path: '/callback',
      host: '127.0.0.1'
    })
  })

  /*
    下面三条钉的是 2026-09-09 抓到的**真实**授权链接与回调:
      https://bigmodel.cn/login?appId=zcode&redirect=<回调地址>&state=<state>
      <回调地址>?authCode=…&state=…
    它们和标准 OAuth 差得足够远,写死在这里才不会被后人「顺手改回标准写法」。
  */
  it('★★ 授权参数是 appId / redirect / state —— 标准那三个一个都不发', () => {
    const params = ZCODE_BIGMODEL_OAUTH.authorizeParams!({
      clientId: 'zcode',
      redirectUri: 'zcode://oauth/callback',
      state: 'st-1',
      challenge: 'ignored'
    })
    expect(Object.keys(params).sort()).toEqual(['appId', 'redirect', 'state'])
    expect(params['appId']).toBe('zcode')
    expect(params['state']).toBe('st-1')
  })

  it('★★★ redirect 直接装我们自己的回环地址，中转页一个字都不出现', () => {
    const params = ZCODE_BIGMODEL_OAUTH.authorizeParams!({
      clientId: 'zcode',
      redirectUri: 'http://127.0.0.1:53124/callback',
      state: 'st-1',
      challenge: 'x'
    })
    expect(params['redirect']).toBe('http://127.0.0.1:53124/callback')

    /*
      ★★ ZCode 自己那个中转页（zcode.z.ai/app/oauth/login）**不能用**：
      它拿到码之后会 `location.assign('zcode://…')` 交给已装的 ZCode，
      `app_version > 3.9.1` 时还会再打一次它自己的 CLI 桥 —— 两条都抢码。
      谁想把它加回来，先读 `zcode-bigmodel.ts` 的文件头。
    */
    expect(params['redirect']).not.toContain('zcode.z.ai')
  })

  it('★★ 回调里的授权码参数名是 authCode —— 按 code 取的话用户会被告知「没有授权码」', () => {
    expect(ZCODE_BIGMODEL_OAUTH.callbackCodeParam).toBe('authCode')
    expect(
      pastedCallbackCode(
        'zcode://oauth/callback?authCode=FaYz_7QT6UA-KneaezNiEUsp6GidGPg2h0Buk3ieIPM&state=st',
        'st',
        ZCODE_BIGMODEL_OAUTH.callbackCodeParam
      )
    ).toEqual({ ok: true, code: 'FaYz_7QT6UA-KneaezNiEUsp6GidGPg2h0Buk3ieIPM' })
  })

  it('provider 是 zcode，和 Z.AI 那条不是同一个值', () => {
    const req = ZCODE_BIGMODEL_OAUTH.tokenRequest!({
      code: 'c',
      redirectUri: 'zcode://oauth/callback',
      verifier: 'v',
      state: 's',
      clientId: 'zcode'
    })
    expect((req.body as Record<string, unknown>)['provider']).toBe('zcode')
  })

  it('★★ 没有第三跳端点 → refresh 返回 null（= 请用户重新登录），不假装刷新成功', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    const id = await ZCODE_BIGMODEL_OAUTH.refresh!(
      {
        kind: 'oauth',
        issuer: 'zcode-bigmodel',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: null,
        accountId: 'u'
      },
      ctxWith(fetchImpl)
    )
    expect(id).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
