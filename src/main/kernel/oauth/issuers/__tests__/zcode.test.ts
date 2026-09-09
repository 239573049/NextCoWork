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
  it('★ 省略 tokenRedirectUri 时发的是本次真正的回调地址（Z.AI 走这条，行为不变）', () => {
    const req = ZCODE_ZAI_OAUTH.tokenRequest!({
      code: 'c',
      redirectUri: 'http://127.0.0.1:9999/callback',
      verifier: 'v',
      state: 's',
      clientId: 'client_x'
    })
    expect((req.body as Record<string, unknown>)['redirect_uri']).toBe(
      'http://127.0.0.1:9999/callback'
    )
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

  it('★★★ provider 是 bigmodel —— appId 才叫 zcode，两者不是一回事', () => {
    const req = ZCODE_BIGMODEL_OAUTH.tokenRequest!({
      code: 'c',
      redirectUri: 'http://127.0.0.1:53124/callback',
      verifier: 'v',
      state: 's',
      clientId: 'zcode'
    })
    /*
      ★ 逆向文档写的是 `zcode`，那是错的：发 `zcode` 服务端回
      `{"code":1000,"msg":"something went wrong"}`（= 不认识这个 provider，
      连验码都没走到），发 `bigmodel` 才会走到验码那步。2026-09-09 扫过一轮
      provider 名，错误码分层见 `zcode-bigmodel.ts`。
      ★ clientId 仍然是 `zcode`，别把这两个值合并成一个常量。
    */
    expect((req.body as Record<string, unknown>)['provider']).toBe('bigmodel')
    expect(req.body).not.toMatchObject({ provider: 'zcode' })
  })

  it('★★★ 换码发的 redirect_uri 是 ZCode 的注册值，不是我们真用的回环地址', () => {
    const req = ZCODE_BIGMODEL_OAUTH.tokenRequest!({
      code: 'c',
      redirectUri: 'http://127.0.0.1:53124/callback',
      verifier: 'v',
      state: 's',
      clientId: 'zcode'
    })
    /*
      ★ 这条渠道的授权在 bigmodel.cn、换码在 zcode.z.ai（它再转发给 bigmodel），
      而 bigmodel 只认 appId=zcode 的注册值。服务端不当场校验这个字段的值，
      所以发错了的表现和「code 无效」完全一样（都是 2007 http error）——
      正因为分不出来，才要把它钉死在这里。
    */
    expect((req.body as Record<string, unknown>)['redirect_uri']).toBe('zcode://oauth/callback')
  })

  it('★★★ 第三跳打的是 open.bigmodel.cn/api/auth/z/login，不是 api.z.ai 那条', async () => {
    /*
      ★★ 少了这一跳的表现**不是 401**:登录成功、凭证落库、界面显示已登录,
      然后每条消息都回 `[1234][网络错误…]`。2026-09-09 实测,三种形状合法的假令牌
      (`id.secret` / 假 JWT / 无点长串)在同一端点上一律 401 —— 所以 1234 是
      「过了鉴权、没有推理权限」,而不是令牌不对。推导见 `zcode-bigmodel.ts`。

      ★ 域名钉死:两条渠道的第三跳路径**同名**(`/api/auth/z/login`),
      发到 api.z.ai 去的话错误信息只会说「用户信息异常」,不指向域名。
    */
    const fresh = jwt({ user_id: 'u-9' })
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return jsonResponse({ code: 0, data: { access_token: fresh } })
    }) as unknown as typeof globalThis.fetch

    const id = await ZCODE_BIGMODEL_OAUTH.refresh!(
      {
        kind: 'oauth',
        issuer: 'zcode-bigmodel',
        accessToken: '旧 JWT',
        refreshToken: 'oauth-at',
        expiresAt: null,
        accountId: 'u-9'
      },
      ctxWith(fetchImpl)
    )
    expect(seen).toEqual(['https://open.bigmodel.cn/api/auth/z/login'])
    expect(id?.accessToken).toBe(fresh)
    expect(id?.refreshToken).toBe('oauth-at')
  })

  it('★ 换码之后只打第三跳一个地址 —— 不去碰那条实测 404 的 userinfo', async () => {
    /*
      逆向文档记的 `zcode.z.ai/api/oauth/userinfo` 2026-09-09 实测是 404
      (Z.AI 那条 `chat.z.ai/api/oauth/userinfo` 回 401,是活的),所以这条渠道
      没有填 `userinfoUrl`。它只用来显示邮箱、失败不致命 —— 钉这一条不是怕它出错,
      是怕后人照着 Z.AI 那条「补齐」时把一个已知 404 的地址加回来。
    */
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return jsonResponse({ code: 0, data: { access_token: jwt({ user_id: 'u-9' }) } })
    }) as unknown as typeof globalThis.fetch

    await ZCODE_BIGMODEL_OAUTH.finishExchange!(
      { code: 0, data: { bigmodel: { access_token: 'oauth-at' }, user: { id: 9 } } },
      ctxWith(fetchImpl)
    )
    expect(seen).toEqual(['https://open.bigmodel.cn/api/auth/z/login'])
  })
})
