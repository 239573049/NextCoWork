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

  it('★★★ 主路径是服务端发起(cli-poll),redirectParam 是 redirect_uri', () => {
    /*
      ★★ 2026-09-15 逆向 ZCode.app v3.11.2:官方客户端对 zai 渠道的 authorize_url
      覆盖的是 `redirect_uri`(bigmodel 那条覆盖 `redirect`,两家不一样)。
      覆盖错了没有任何早期信号 —— 授权页照开、码照回,但服务端 flow 永远
      pending,最后一句「授权超时」。
    */
    expect(ZCODE_ZAI_OAUTH.grant).toMatchObject({
      kind: 'cli-poll',
      initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
      provider: 'zai',
      redirectParam: 'redirect_uri'
    })
  })

  it('★★★ 落地回环是临时端口 —— 9999 只留给 fallback,平时不再占', () => {
    /*
      ★ 用户机器上真在跑的 ZCode CLI 就监听 9999。主路径的服务端发起链路
      对 redirect 没有注册值约束,没理由和它抢端口;fallback 那份仍然必须
      逐字节等于注册值 `http://127.0.0.1:9999/callback`(见下一条)。
    */
    if (ZCODE_ZAI_OAUTH.grant.kind !== 'cli-poll') throw new Error('grant 不是 cli-poll')
    expect(ZCODE_ZAI_OAUTH.grant.landingPath).toBe('/callback')
    expect(ZCODE_ZAI_OAUTH.grant.host).toBe('127.0.0.1')
  })

  it('★★ fallback 仍是 127.0.0.1:9999 的固定回环（注册值逐字节相等）', () => {
    const grant = ZCODE_ZAI_OAUTH.grant
    if (grant.kind !== 'cli-poll' || grant.fallback === undefined) {
      throw new Error('zai 渠道必须带着 fallback')
    }
    expect(grant.fallback).toEqual({
      kind: 'authorization-code',
      authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
      redirect: {
        kind: 'loopback-fixed',
        port: 9999,
        path: '/callback',
        host: '127.0.0.1'
      }
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

  it('★★ B 通道的 ready 响应(poll 形状)原样可解析 —— 两条通道共用 finishExchange', async () => {
    /*
      ★★ 2026-09-15 逆向 ZCode.app v3.11.2:poll 的 ready 响应和换码响应同构,
      只是多一个 `status` 字段、user 里的 id 键叫 `user_id`。这条断言守的是
      「同构」这个前提 —— 它碎了的话 B 通道赢下来的登录会在最后一步报
      「响应里没有 access_token」,而轮询本身全绿。
    */
    const pollReady = {
      code: 0,
      data: {
        status: 'ready',
        token: 'zcode-jwt',
        zai: { access_token: 'oauth-at' },
        user: { user_id: 77, name: 'u', email: 'a@b.test' }
      }
    }
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/auth/z/login')) {
        return jsonResponse({ code: 0, data: { access_token: BUSINESS_JWT } })
      }
      return jsonResponse({ code: 0, data: { email: 'a@b.test' } })
    }) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_ZAI_OAUTH.finishExchange!(pollReady, ctxWith(fetchImpl))
    expect(ZCODE_ZAI_OAUTH.identity(merged, 1_000)?.refreshToken).toBe('oauth-at')
  })

  it('★★ 邮箱优先取自响应的 user.email —— userinfo 端点不再被无谓地打一遍', async () => {
    /*
      poll 的 ready 响应自带 user.email(逆向确认),这部分数据已经在手里;
      userinfo 只是「响应里没有」时的兜底。这条断言里 userinfo 一旦被调用
      fetch 就抛 —— 抛了测试就红,证明它没被碰。
    */
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/auth/z/login')) {
        return jsonResponse({ code: 0, data: { access_token: BUSINESS_JWT } })
      }
      throw new Error('userinfo 不该被调用')
    }) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_ZAI_OAUTH.finishExchange!(
      {
        code: 0,
        data: { zai: { access_token: 'oauth-at' }, user: { user_id: 77, email: 'a@zai.test' } }
      },
      ctxWith(fetchImpl)
    )
    expect(ZCODE_ZAI_OAUTH.identity(merged, 1_000)?.email).toBe('a@zai.test')
  })

  it('★★ user.user_id 也是合法的兜底 id —— poll 响应用这个键名', async () => {
    /*
      业务 JWT 解不出 user_id 时走兜底:换码响应给 `user.id`,poll 响应给
      `user.user_id`,两个都得认 —— 少认一个的表现是「登录成功、凭证不完整」。
    */
    const hop2UserId = {
      code: 0,
      data: { zai: { access_token: 'oauth-at' }, user: { user_id: 77 } }
    }
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { access_token: 'not-a-jwt' } })
    ) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_ZAI_OAUTH.finishExchange!(hop2UserId, ctxWith(fetchImpl))
    expect(ZCODE_ZAI_OAUTH.identity(merged, 1_000)?.accountId).toBe('77')
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
  it('★★★ 主路径是服务端发起(cli-poll),redirectParam 是 redirect', () => {
    /*
      ★ 逆向 ZCode.app 确认两家覆盖的参数名不同:bigmodel 是 `redirect`
      (它的授权入口是个登录页,吃 appId/redirect/state),zai 是 `redirect_uri`。
    */
    expect(ZCODE_BIGMODEL_OAUTH.grant).toMatchObject({
      kind: 'cli-poll',
      initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
      provider: 'bigmodel',
      redirectParam: 'redirect'
    })
  })

  it('★★★ 落地和 fallback 都走回环，不走 zcode:// 自定义协议', () => {
    /*
      ★ 这条不是「配置偏好」，是这条渠道能不能拿到码的全部关键。
      照抄 ZCode 的 `zcode://oauth/callback` 会被系统直接交给已装的 ZCode，
      浏览器地址栏里留不下东西 —— 用户实测就是这么失败的。
      `bigmodel.cn` 对 redirect 只有一条 `/^(javascript|data|vbscript):/i` 黑名单，
      没有白名单，所以回环地址是合法的。推导见 `zcode-bigmodel.ts` 文件头。
    */
    const grant = ZCODE_BIGMODEL_OAUTH.grant
    if (grant.kind !== 'cli-poll' || grant.fallback === undefined) {
      throw new Error('bigmodel 渠道的 grant 必须是带 fallback 的 cli-poll')
    }
    expect(grant.landingPath).toBe('/callback')
    expect(grant.host).toBe('127.0.0.1')
    expect(grant.fallback.redirect).toEqual({
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

  it('★★ 没有 z/login 第四跳 —— 2026-09-15 用户实测证伪了它', () => {
    /*
      ★★ 用户真登录一次后,真 token 打 open.bigmodel.cn/api/auth/z/login 得到的
      是 {"code":500,"msg":"z.ai用户信息异常"} —— 和拿假 token 探到的「token 无效」
      逐字相同,即该端点不认这条链路的 OAuth token。同期逆向 ZCode.app 打包的 CLI
      确认:BigModel 渠道从不调 z/login(只有 Z.AI 渠道调 api.z.ai 那条),它走的是
      下面的 apiKeyProvision。这条断言守着「别把 z/login 加回来」。
    */
    expect(ZCODE_BIGMODEL_OAUTH).not.toMatchObject({ businessLoginUrl: expect.any(String) })
  })

  /*
    ★★ 下两条钉的是 2026-09-15 从 ZCode.app 打包 CLI(zcode.cjs 的
    resolveCodingPlanApiKey)逆向到的三步供应。它是「拿 OAuth token 直接当
    API key 会 1234」的定案:coding 端点要的是真 API Key(id.secret 形态)。
  */
  function bizHarness(
    routes: { match: (url: string) => boolean; respond: () => Response }[]
  ): { fetchImpl: typeof globalThis.fetch; calls: { url: string; method: string; auth: string }[] } {
    const calls: { url: string; method: string; auth: string }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        auth: String((init?.headers as Record<string, string>)?.['authorization'] ?? '')
      })
      const hit = routes.find((r) => r.match(url))
      if (hit === undefined) return new Response('nope', { status: 404 })
      return hit.respond()
    }) as unknown as typeof globalThis.fetch
    return { fetchImpl, calls }
  }

  it('★★★ 三步供应:查机构/项目 → 找 zcode-api-key → copy 出 secret 拼成 id.secret', async () => {
    const { fetchImpl, calls } = bizHarness([
      {
        match: (u) => u.endsWith('/api/biz/customer/getCustomerInfo'),
        respond: () =>
          jsonResponse({
            code: 0,
            data: {
              organizations: [
                {
                  // 名字不含「默认机构」但只有它一个 → 取 [0]
                  organizationName: '某某科技',
                  organizationId: 'org-1',
                  projects: [
                    { projectName: '实验项目', projectId: 'proj-wrong' },
                    // 不在首位也按名字命中「默认项目」
                    { projectName: '默认项目', projectId: 'proj-1' }
                  ]
                }
              ]
            }
          })
      },
      {
        match: (u) => u.endsWith('/api_keys') && !u.includes('/copy/'),
        // code:200 也要算成功 —— CLI 的 isSuccessfulRemoteCode 认 0/200/缺省
        respond: () =>
          jsonResponse({
            code: 200,
            data: [
              { name: '手工建的', apiKey: 'other-key' },
              { name: 'zcode-api-key', apiKey: 'ak-1' }
            ]
          })
      },
      {
        match: (u) => u.includes('/api_keys/copy/'),
        respond: () => jsonResponse({ code: 0, data: { secretKey: 'sk-1' } })
      }
    ])

    const merged = await ZCODE_BIGMODEL_OAUTH.finishExchange!(
      { code: 0, data: { bigmodel: { access_token: 'oauth-at' }, user: { user_id: 9, email: 'u@bm.test' } } },
      ctxWith(fetchImpl)
    )
    // 三步各一次,不多不少(没建 key、没碰任何别的端点)
    expect(calls.map((c) => c.url)).toEqual([
      'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
      'https://bigmodel.cn/api/biz/v1/organization/org-1/projects/proj-1/api_keys',
      'https://bigmodel.cn/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/ak-1'
    ])
    // ★ 鉴权头是裸 token,不带 Bearer —— CLI 的 createBizAuthHeaders 原样如此
    expect(calls.map((c) => c.auth)).toEqual(['oauth-at', 'oauth-at', 'oauth-at'])
    expect(ZCODE_BIGMODEL_OAUTH.identity(merged, 1_000)).toMatchObject({
      accessToken: 'ak-1.sk-1',
      // refreshToken 槽仍是 OAuth token —— 刷新 = 拿它重跑供应
      refreshToken: 'oauth-at',
      accountId: '9',
      // ★ 邮箱来自响应自带的 user.email(bigmodel 没配 userinfo 端点,以前永远拿不到)
      email: 'u@bm.test'
    })
  })

  it('★★★ key 不存在就创建;copy 失败不致命(裸 apiKey 也能用)', async () => {
    const calls2: { url: string; method: string; body: string }[] = []
    const fetch2 = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls2.push({ url, method, body: String(init?.body ?? '') })
      if (url.endsWith('/api/biz/customer/getCustomerInfo')) {
        return jsonResponse({
          code: 0,
          data: { organizations: [{ organizationName: '默认机构', organizationId: 'o', projects: [{ projectName: '默认项目', projectId: 'p' }] }] }
        })
      }
      if (url.includes('/api_keys/copy/')) return new Response('boom', { status: 500 })
      if (method === 'POST') return jsonResponse({ code: 0, data: { name: 'zcode-api-key', apiKey: 'ak-2' } })
      return jsonResponse({ code: 0, data: [] })
    }) as unknown as typeof globalThis.fetch

    const merged = await ZCODE_BIGMODEL_OAUTH.finishExchange!(
      { code: 0, data: { bigmodel: { access_token: 'oauth-at' }, user: { id: 7 } } },
      ctxWith(fetch2)
    )
    // GET 列表(空) → POST 创建(名字对上) → copy(挂了也吞掉)
    expect(calls2[1]).toMatchObject({ method: 'GET' })
    expect(calls2[2]).toMatchObject({ method: 'POST', body: JSON.stringify({ name: 'zcode-api-key' }) })
    expect(calls2[3]?.url).toContain('/api_keys/copy/ak-2')
    expect(ZCODE_BIGMODEL_OAUTH.identity(merged, 1_000)?.accessToken).toBe('ak-2')
  })

  it('★ 刷新 = 拿 refreshToken 槽里的 OAuth token 幂等地重跑供应', async () => {
    const fetch2 = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/biz/customer/getCustomerInfo')) {
        return jsonResponse({
          code: 0,
          data: { organizations: [{ organizationName: '默认机构', organizationId: 'o', projects: [{ projectName: '默认项目', projectId: 'p' }] }] }
        })
      }
      if (url.includes('/api_keys/copy/')) return jsonResponse({ code: 0, data: { secretKey: 'sk-9' } })
      return jsonResponse({ code: 0, data: [{ name: 'zcode-api-key', apiKey: 'ak-9' }] })
    }) as unknown as typeof globalThis.fetch

    const id = await ZCODE_BIGMODEL_OAUTH.refresh!(
      {
        kind: 'oauth',
        issuer: 'zcode-bigmodel',
        accessToken: 'ak-1.sk-1',
        refreshToken: 'oauth-at',
        expiresAt: null,
        accountId: 'u-9'
      },
      ctxWith(fetch2)
    )
    expect(id?.accessToken).toBe('ak-9.sk-9')
    // 「用来再换一次的那个东西」不能被换出来的 key 覆盖,否则只能刷一次
    expect(id?.refreshToken).toBe('oauth-at')
    expect(id?.accountId).toBe('u-9')
  })

  it('★★ transport:配了第四跳的渠道一个鉴权头都不加(encode 写的已是对的)', () => {
    /*
      bigmodel 的 accessToken 现在是一把真 API Key(id.secret),anthropic 协议
      encode 写的 x-api-key、openai 协议写的 Bearer 都直接认 —— 在 transport
      里再补 Authorization 只会给「哪个头才是真相」制造第二个答案。
      Bearer 补头只留给「直接拿 OAuth token 发请求」的渠道(今天没有)。
    */
    const bigmodelHeaders = ZCODE_BIGMODEL_OAUTH.transport(
      {
        kind: 'oauth',
        issuer: 'zcode-bigmodel',
        accessToken: 'ak-1.sk-1',
        refreshToken: 'oauth-at',
        expiresAt: null,
        accountId: 'u-1'
      },
      { sessionId: 's' }
    ).headers
    expect(bigmodelHeaders['authorization']).toBeUndefined()
    expect(bigmodelHeaders['user-agent']).toMatch(/^ZCode\//u)

    const zaiHeaders = ZCODE_ZAI_OAUTH.transport(
      {
        kind: 'oauth',
        issuer: 'zcode-zai',
        accessToken: 'biz-jwt',
        refreshToken: 'oauth-at',
        expiresAt: null,
        accountId: 'u-1'
      },
      { sessionId: 's' }
    ).headers
    expect(zaiHeaders['authorization']).toBeUndefined()
  })
})
