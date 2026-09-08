/**
 * 授权码流程的编排测试 —— **全程假上游、假浏览器,不碰网络也不碰 1455。**
 *
 * 这份测试能存在,正是因为 `flow.ts` 把 fetch / now / openBrowser 三样都做成了注入。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OAuthAbandonedError,
  OAuthFailedError,
  pastedCallbackCode,
  runOAuthFlow,
  type OAuthFlowDeps
} from '../flow'
import type { OAuthProviderSpec } from '../registry'
import { CHATGPT_OAUTH } from '../issuers/chatgpt'

const NOW = 1_700_000_000_000

/** 手搓一个未签名的 JWT —— `parseIdTokenClaims` 不验签,这里只需要 payload 那一段 */
function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `header.${payload}.signature`
}

const CLAIMS = {
  email: 'user@example.test',
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-42',
    chatgpt_plan_type: 'plus'
  }
}

/** 临时端口的 spec —— 不去抢生产那个固定的 1455 */
const spec: OAuthProviderSpec = {
  ...CHATGPT_OAUTH,
  redirect: { kind: 'loopback-ephemeral', path: '/auth/callback' }
}

interface Harness {
  deps: OAuthFlowDeps
  authorizeUrls: string[]
  tokenBodies: URLSearchParams[]
  /** 原始请求。**给非表单形态的家用** —— JSON body 解不成 URLSearchParams */
  tokenRequests: { body: string; contentType: string | null }[]
}

/**
 * ★ `spec` 是**参数**而不是写死的 ChatGPT 变体:同一套编排现在要跑好几家,
 * 而「默认值等于今天的行为」这句话只有在两家同跑同一份编排时才是被证明的。
 */
function harness(
  tokenResponse: { status: number; body: unknown },
  callback: (url: URL) => Record<string, string>,
  useSpec: OAuthProviderSpec = spec
): Harness {
  const authorizeUrls: string[] = []
  const tokenBodies: URLSearchParams[] = []
  const tokenRequests: { body: string; contentType: string | null }[] = []

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    tokenBodies.push(new URLSearchParams(body))
    tokenRequests.push({
      body,
      contentType: new Headers(init?.headers).get('content-type')
    })
    return new Response(JSON.stringify(tokenResponse.body), {
      status: tokenResponse.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch

  const openBrowser = async (raw: string): Promise<void> => {
    authorizeUrls.push(raw)
    const url = new URL(raw)
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    const params = new URLSearchParams(callback(url))
    // 模拟浏览器把用户送回本地回环
    await fetch(`http://127.0.0.1:${redirect.port}${redirect.pathname}?${params.toString()}`)
  }

  return {
    deps: {
      spec: useSpec,
      fetch: fetchImpl,
      now: () => NOW,
      openBrowser,
      signal: new AbortController().signal
    },
    authorizeUrls,
    tokenBodies,
    tokenRequests
  }
}

describe('runOAuthFlow · 走通一次', () => {
  it('授权 URL 带齐 PKCE 参数', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken(CLAIMS) } },
      (url) => ({ code: 'the-code', state: url.searchParams.get('state') ?? '' })
    )
    await runOAuthFlow(h.deps)

    const u = new URL(h.authorizeUrls[0] as string)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe(spec.clientId)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(u.searchParams.get('state')).toBeTruthy()
    // ChatGPT 的私货：不带它 id_token 里就没有 accountId
    expect(u.searchParams.get('id_token_add_organizations')).toBe('true')
  })

  it('★ 换 token 时的 redirect_uri 与授权时逐字相同 —— 不一致就是一个不说明原因的 invalid_grant', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken(CLAIMS) } },
      (url) => ({ code: 'the-code', state: url.searchParams.get('state') ?? '' })
    )
    await runOAuthFlow(h.deps)

    const authorized = new URL(h.authorizeUrls[0] as string).searchParams.get('redirect_uri')
    expect(h.tokenBodies[0]?.get('redirect_uri')).toBe(authorized)
  })

  it('换 token 带上 code_verifier 和授权码', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken(CLAIMS) } },
      (url) => ({ code: 'the-code', state: url.searchParams.get('state') ?? '' })
    )
    await runOAuthFlow(h.deps)

    expect(h.tokenBodies[0]?.get('grant_type')).toBe('authorization_code')
    expect(h.tokenBodies[0]?.get('code')).toBe('the-code')
    expect(h.tokenBodies[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u)
  })

  it('凭证字段齐全，expiresAt 用注入的 now 折成绝对时间戳', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken(CLAIMS) } },
      (url) => ({ code: 'c', state: url.searchParams.get('state') ?? '' })
    )
    expect(await runOAuthFlow(h.deps)).toEqual({
      kind: 'oauth',
      issuer: 'chatgpt',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: NOW + 3_600_000,
      accountId: 'acct-42',
      email: 'user@example.test',
      planType: 'plus',
      refreshedAt: NOW
    })
  })

  it('阶段依次推给调用方', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 60, id_token: idToken(CLAIMS) } },
      (url) => ({ code: 'c', state: url.searchParams.get('state') ?? '' })
    )
    const phases: string[] = []
    await runOAuthFlow({ ...h.deps, onPhase: (p) => phases.push(p) })
    expect(phases).toEqual(['opening', 'waiting', 'exchanging', 'done'])
  })
})

describe('runOAuthFlow · 失败与放弃', () => {
  it('★ 用户拒绝授权 → OAuthFailedError（是失败，要报错）', async () => {
    const h = harness({ status: 200, body: {} }, (url) => ({
      error: 'access_denied',
      state: url.searchParams.get('state') ?? ''
    }))
    await expect(runOAuthFlow(h.deps)).rejects.toBeInstanceOf(OAuthFailedError)
  })

  it('★★ state 被换掉 → 不换 token（CSRF 防线在流程这一层也要成立）', async () => {
    const h = harness({ status: 200, body: {} }, () => ({ code: 'evil', state: 'not-ours' }))
    await expect(runOAuthFlow(h.deps)).rejects.toBeInstanceOf(OAuthFailedError)
    expect(h.tokenBodies).toHaveLength(0)
  })

  it('token 端点非 2xx → 带上状态码，别让人去猜', async () => {
    const h = harness({ status: 400, body: { error: 'invalid_grant' } }, (url) => ({
      code: 'c',
      state: url.searchParams.get('state') ?? ''
    }))
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/400/u)
  })

  it('★★ id_token 里没有 accountId → 当场判失败，而不是「登录成功」后第一次对话 403', async () => {
    const h = harness(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', id_token: idToken({ email: 'a@b.test' }) } },
      (url) => ({ code: 'c', state: url.searchParams.get('state') ?? '' })
    )
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/账号 id|不完整/u)
  })

  it('★ 取消 → OAuthAbandonedError（不是故障，界面不该弹红条）', async () => {
    const ctrl = new AbortController()
    const deps: OAuthFlowDeps = {
      spec,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => NOW,
      openBrowser: async () => {
        ctrl.abort()
      },
      signal: ctrl.signal
    }
    const err = await runOAuthFlow(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthAbandonedError)
    expect((err as OAuthAbandonedError).kind).toBe('cancelled')
  })

  it('★★ 浏览器打不开 → 当场失败，而不是干等到 5 分钟超时再说「授权超时」', async () => {
    const deps: OAuthFlowDeps = {
      spec,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => NOW,
      openBrowser: async () => {
        throw new Error('no default browser')
      },
      signal: new AbortController().signal
    }
    const err = await runOAuthFlow(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthFailedError)
    // 错误里要带上真实原因，而不是一句和原因无关的「超时」
    expect((err as Error).message).toContain('no default browser')
  })
})

/**
 * 规格钩子 —— **每一个都是「不写就等于今天的行为」。**
 *
 * ★ 上面那两个 describe 里 ChatGPT 的断言一条都没改,那才是这句话的证据:
 * 加了四个钩子之后,不声明钩子的家走的仍然是逐字相同的那条路。
 */
describe('runOAuthFlow · 各家的私货钩子', () => {
  const ok = (body: unknown): { status: number; body: unknown } => ({ status: 200, body })
  const echoState = (url: URL): Record<string, string> => ({
    code: 'the-code',
    state: url.searchParams.get('state') ?? ''
  })

  /** 一份不带任何 ChatGPT 私货的最小 spec */
  const plain: OAuthProviderSpec = {
    id: 'zcode-zai',
    label: '测试家',
    authorizeUrl: 'https://example.test/authorize',
    tokenUrl: 'https://example.test/token',
    clientId: 'cid',
    redirect: { kind: 'loopback-ephemeral', path: '/callback' },
    identity: (json) => {
      const o = json as Record<string, unknown>
      return {
        accessToken: String(o['access_token']),
        refreshToken: String(o['refresh_token']),
        expiresAt: null,
        accountId: 'acct'
      }
    },
    transport: () => ({ headers: {}, body: (b) => b })
  }

  it('★★ pkce: false → 授权 URL 里根本没有 code_challenge（不是空串）', async () => {
    const h = harness(ok({ access_token: 'at', refresh_token: 'rt' }), echoState, {
      ...plain,
      pkce: false
    })
    await runOAuthFlow(h.deps)
    const u = new URL(h.authorizeUrls[0] as string)
    expect(u.searchParams.has('code_challenge')).toBe(false)
    expect(u.searchParams.has('code_challenge_method')).toBe(false)
  })

  it('★ scope 省略 → 授权 URL 里根本没有 scope 这个参数', async () => {
    const h = harness(ok({ access_token: 'at', refresh_token: 'rt' }), echoState, plain)
    await runOAuthFlow(h.deps)
    expect(new URL(h.authorizeUrls[0] as string).searchParams.has('scope')).toBe(false)
  })

  it('★★ tokenRequest 能整体换成 JSON body —— 标准字段一个都不发', async () => {
    const h = harness(ok({ access_token: 'at', refresh_token: 'rt' }), echoState, {
      ...plain,
      tokenRequest: (args) => ({
        contentType: 'json',
        body: { provider: 'zai', code: args.code, state: args.state }
      })
    })
    await runOAuthFlow(h.deps)

    const req = h.tokenRequests[0]
    expect(req?.contentType).toBe('application/json')
    expect(JSON.parse(req?.body ?? '')).toEqual({
      provider: 'zai',
      code: 'the-code',
      state: expect.any(String)
    })
    // grant_type / code_verifier / redirect_uri 都不该冒出来
    expect(req?.body).not.toMatch(/grant_type|code_verifier/u)
  })

  it('★★ finishExchange 的返回值才是喂给 identity 的东西', async () => {
    const seen: unknown[] = []
    const h = harness(ok({ hop1: true }), echoState, {
      ...plain,
      finishExchange: async (json) => {
        seen.push(json)
        return { access_token: '第二跳换来的', refresh_token: 'rt' }
      }
    })
    const cred = await runOAuthFlow(h.deps)
    // 第一跳的原始响应进了钩子
    expect(seen).toEqual([{ hop1: true }])
    // 而 identity 拿到的是钩子的返回值
    expect(cred.accessToken).toBe('第二跳换来的')
  })

  it('★ expiresAt 为 null 时如实存 null，不编一个出来', async () => {
    const h = harness(ok({ access_token: 'at', refresh_token: 'rt' }), echoState, plain)
    expect((await runOAuthFlow(h.deps)).expiresAt).toBeNull()
  })
})

/**
 * 手动粘贴形态 —— **三个洞是一起补的。**
 *
 * 在此之前这条路径:没有超时(等到天荒地老)、不校验 state(CSRF 防线只在回环那条上)、
 * 且渲染层根本没有输入框。前两个由下面这组钉住。
 */
describe('pastedCallbackCode · 粘回来的东西', () => {
  it('整条回调地址里取出 code', () => {
    expect(pastedCallbackCode('zcode://oauth/callback?code=abc&state=st', 'st')).toEqual({
      ok: true,
      code: 'abc'
    })
  })

  it('只粘了问号后面那一段也认', () => {
    expect(pastedCallbackCode('?code=abc&state=st', 'st')).toEqual({ ok: true, code: 'abc' })
    expect(pastedCallbackCode('code=abc&state=st', 'st')).toEqual({ ok: true, code: 'abc' })
  })

  it('★★ state 不匹配 → 拒绝。钓鱼页给的「授权码」不能被我们拿去换 token', () => {
    const r = pastedCallbackCode('https://x.test/cb?code=abc&state=攻击者的', 'st')
    expect(r.ok).toBe(false)
  })

  it('★ 没有 state 也算不匹配 —— 缺失不能等于放行', () => {
    expect(pastedCallbackCode('https://x.test/cb?code=abc', 'st').ok).toBe(false)
  })

  it('授权服务器回的 error 原样带出来', () => {
    const r = pastedCallbackCode('https://x.test/cb?error=access_denied&error_description=拒绝了', 'st')
    expect(r).toEqual({ ok: false, reason: '拒绝了' })
  })

  it('空的 / 没有 code 的都拒绝，且话说人听得懂', () => {
    expect(pastedCallbackCode('  ', 'st').ok).toBe(false)
    expect(pastedCallbackCode('https://x.test/cb?foo=1&state=st', 'st')).toEqual({
      ok: false,
      reason: expect.stringContaining('授权码')
    })
  })
})

describe('runOAuthFlow · manual-paste', () => {
  const pasteSpec: OAuthProviderSpec = {
    id: 'zcode-bigmodel',
    label: '粘贴家',
    authorizeUrl: 'https://example.test/login',
    tokenUrl: 'https://example.test/token',
    clientId: 'cid',
    pkce: false,
    redirect: { kind: 'manual-paste', redirectUri: 'app://oauth/callback' },
    identity: () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: null,
      accountId: 'acct'
    }),
    transport: () => ({ headers: {}, body: (b) => b })
  }

  function pasteDeps(
    awaitPastedCode: () => Promise<string>,
    fetchImpl: typeof globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch
  ): OAuthFlowDeps {
    return {
      spec: pasteSpec,
      fetch: fetchImpl,
      now: () => NOW,
      openBrowser: async () => {},
      signal: new AbortController().signal,
      awaitPastedCode
    }
  }

  it('★★ 用户一直不粘 → 五分钟后超时，而不是永远挂在「等待授权中」', async () => {
    vi.useFakeTimers()
    try {
      // 一个永不 settle 的 Promise = 用户关掉授权页之后什么也不做
      const flow = runOAuthFlow(pasteDeps(() => new Promise<string>(() => {})))
      const settled = flow.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      const err = await settled
      expect(err).toBeInstanceOf(OAuthAbandonedError)
      expect((err as OAuthAbandonedError).kind).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('★★ 粘进来的 state 不匹配 → 不换 token', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    const deps = pasteDeps(async () => 'app://oauth/callback?code=evil&state=别人的', fetchImpl)
    await expect(runOAuthFlow(deps)).rejects.toBeInstanceOf(OAuthFailedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('粘进来空的 → 按放弃处理，和关掉授权页同一个结局', async () => {
    const err = await runOAuthFlow(pasteDeps(async () => '   ')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthAbandonedError)
    expect((err as OAuthAbandonedError).kind).toBe('cancelled')
  })

  it('★ 没有提供输入通道时当场报错，而不是静默挂住', async () => {
    const deps = pasteDeps(async () => '')
    delete deps.awaitPastedCode
    await expect(runOAuthFlow(deps)).rejects.toBeInstanceOf(OAuthFailedError)
  })
})
