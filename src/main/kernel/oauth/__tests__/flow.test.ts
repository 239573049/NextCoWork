/**
 * 授权码流程的编排测试 —— **全程假上游、假浏览器,不碰网络也不碰 1455。**
 *
 * 这份测试能存在,正是因为 `flow.ts` 把 fetch / now / openBrowser 三样都做成了注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  grant: {
    kind: 'authorization-code',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    redirect: { kind: 'loopback-ephemeral', path: '/auth/callback' }
  }
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
      {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken(CLAIMS)
        }
      },
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
      {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken(CLAIMS)
        }
      },
      (url) => ({ code: 'the-code', state: url.searchParams.get('state') ?? '' })
    )
    await runOAuthFlow(h.deps)

    const authorized = new URL(h.authorizeUrls[0] as string).searchParams.get('redirect_uri')
    expect(h.tokenBodies[0]?.get('redirect_uri')).toBe(authorized)
  })

  it('换 token 带上 code_verifier 和授权码', async () => {
    const h = harness(
      {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken(CLAIMS)
        }
      },
      (url) => ({ code: 'the-code', state: url.searchParams.get('state') ?? '' })
    )
    await runOAuthFlow(h.deps)

    expect(h.tokenBodies[0]?.get('grant_type')).toBe('authorization_code')
    expect(h.tokenBodies[0]?.get('code')).toBe('the-code')
    expect(h.tokenBodies[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u)
  })

  it('凭证字段齐全，expiresAt 用注入的 now 折成绝对时间戳', async () => {
    const h = harness(
      {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken(CLAIMS)
        }
      },
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
      {
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', expires_in: 60, id_token: idToken(CLAIMS) }
      },
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
      {
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', id_token: idToken({ email: 'a@b.test' }) }
      },
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
    tokenUrl: 'https://example.test/token',
    clientId: 'cid',
    grant: {
      kind: 'authorization-code',
      authorizeUrl: 'https://example.test/authorize',
      redirect: { kind: 'loopback-ephemeral', path: '/callback' }
    },
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
    const r = pastedCallbackCode(
      'https://x.test/cb?error=access_denied&error_description=拒绝了',
      'st'
    )
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
    tokenUrl: 'https://example.test/token',
    clientId: 'cid',
    pkce: false,
    grant: {
      kind: 'authorization-code',
      authorizeUrl: 'https://example.test/login',
      redirect: { kind: 'manual-paste', redirectUri: 'app://oauth/callback' }
    },
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

/**
 * 设备码流程(RFC 8628)—— **和授权码那条共用同一份编排的后半段。**
 *
 * ★ 全程假上游 + 假定时器:真实的 `interval` 是 5 秒,照实等的话这一组用例要跑
 * 半分钟。`vi.useFakeTimers()` 让「等一个轮询间隔」变成一行断言。
 */
describe('runOAuthFlow · 设备码(RFC 8628)', () => {
  /*
    ★ 假定时器只在这一组里开。整份文件其它用例跑的是真实定时器(回环那条路径的
    5 分钟兜底靠的就是它),全局开的话那些用例会永远等不到自己的超时。
  */
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const deviceSpec: OAuthProviderSpec = {
    id: 'kimi-code',
    label: '设备码家',
    tokenUrl: 'https://example.test/token',
    clientId: 'cid',
    pkce: false,
    grant: { kind: 'device-code', deviceAuthorizationUrl: 'https://example.test/device' },
    oauthHeaders: { 'x-msh-platform': 'test_cli' },
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

  interface DeviceHarness {
    deps: OAuthFlowDeps
    phases: { phase: string; userCode?: string; verificationUri?: string }[]
    opened: string[]
    /** 每一次打到 token 端点的表单 */
    polls: URLSearchParams[]
    /** 申请设备码那一跳发出去的表单(scope 在不在这里面) */
    deviceForms: URLSearchParams[]
    /** 每一次请求带上的头 */
    headers: Record<string, string>[]
    /** 让 `deps.now()` 往前走(测过期用) */
    advance: (ms: number) => void
  }

  function deviceHarness(options: {
    device?: Record<string, unknown>
    deviceStatus?: number
    /** 一次一条,按顺序回;用完之后一直回最后一条 */
    tokenResponses: { status: number; body: unknown }[]
    openBrowser?: (url: string) => Promise<void>
    /** 换一张规格表(测 scope 那两条用) */
    spec?: OAuthProviderSpec
  }): DeviceHarness {
    const phases: DeviceHarness['phases'] = []
    const opened: string[] = []
    const polls: URLSearchParams[] = []
    const deviceForms: URLSearchParams[] = []
    const headers: Record<string, string>[] = []
    let clock = NOW
    let poll = 0

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      headers.push({ ...((init?.headers ?? {}) as Record<string, string>) })
      const form = new URLSearchParams(String(init?.body ?? ''))
      if (url === 'https://example.test/device') {
        deviceForms.push(form)
        const status = options.deviceStatus ?? 200
        return new Response(
          JSON.stringify(
            options.device ?? {
              device_code: 'dev-1',
              user_code: 'B7MB-FOW3',
              verification_uri: 'https://example.test/pair',
              verification_uri_complete: 'https://example.test/pair?code=B7MB-FOW3',
              expires_in: 1800,
              interval: 5
            }
          ),
          { status }
        )
      }
      polls.push(form)
      const r = options.tokenResponses[Math.min(poll, options.tokenResponses.length - 1)]
      poll += 1
      return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 200 })
    }) as unknown as typeof globalThis.fetch

    return {
      deps: {
        spec: options.spec ?? deviceSpec,
        fetch: fetchImpl,
        now: () => clock,
        openBrowser:
          options.openBrowser ??
          (async (url) => {
            opened.push(url)
          }),
        onPhase: (phase, device) => {
          phases.push({ phase, ...(device ?? {}) })
        },
        signal: new AbortController().signal
      },
      phases,
      opened,
      polls,
      deviceForms,
      headers,
      advance: (ms) => {
        clock += ms
      }
    }
  }

  const token = { access_token: 'at', refresh_token: 'rt' }

  it('★★ 配对码跟着 waiting 一起推出去 —— 界面上唯一能显示给用户的就是它', async () => {
    const h = deviceHarness({
      tokenResponses: [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: token }
      ]
    })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    const cred = await run

    expect(cred.accessToken).toBe('at')
    expect(h.phases).toEqual([
      { phase: 'opening' },
      {
        phase: 'waiting',
        userCode: 'B7MB-FOW3',
        verificationUri: 'https://example.test/pair'
      },
      { phase: 'exchanging' },
      { phase: 'done' }
    ])
    // ★ 打开的是**带码**那条链接,用户少抄一次
    expect(h.opened).toEqual(['https://example.test/pair?code=B7MB-FOW3'])
  })

  it('★★★ 声明了 scope 的家，申请设备码时必须把它发出去', async () => {
    /*
      ★ 这条守的是一个**不报错的**失败。2026-09-14 对 xAI 实测:不发 scope 照样
      200、配对码一应俱全,但换回来那把令牌不带 `grok-cli:access` —— 表现是
      **登录一路成功、第一条消息 401**,而错误信息里一个字都不提 scope。
      RFC 8628 §3.1 把 scope 标成 optional,正是这条规矩最容易被「按规范精简」掉的原因。
    */
    const h = deviceHarness({
      spec: { ...deviceSpec, scope: 'openid grok-cli:access' },
      tokenResponses: [{ status: 200, body: token }]
    })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    await run

    expect(h.deviceForms[0]?.get('scope')).toBe('openid grok-cli:access')
  })

  it('★★ 没声明 scope 的家，这个参数一个字都不写（不是写成空串）', async () => {
    /*
      ★ 空串和「不发」不是一回事:有的授权服务器对空 scope 直接回 `invalid_scope`。
      Kimi 那条路径此前逐字节没有这个字段,加 scope 支持不能把它改掉。
    */
    const h = deviceHarness({ tokenResponses: [{ status: 200, body: token }] })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    await run

    expect(h.deviceForms[0]?.has('scope')).toBe(false)
  })

  it('★ 轮询发的是 device_code 那套 grant_type，且两跳都带上 oauthHeaders', async () => {
    const h = deviceHarness({ tokenResponses: [{ status: 200, body: token }] })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    await run

    expect(h.polls[0]?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(h.polls[0]?.get('device_code')).toBe('dev-1')
    expect(h.polls[0]?.get('client_id')).toBe('cid')
    /*
      ★★ 申请设备码那一跳也要带私货头。只在换 token 那跳带的表现是
      「申请码这一步就 403」,而错误信息里不会出现任何一个头的名字。
    */
    for (const sent of h.headers) expect(sent['x-msh-platform']).toBe('test_cli')
  })

  it('★★ slow_down 之后间隔是累加的 —— 照原速度撞回去会被限流到登录失败', async () => {
    const h = deviceHarness({
      tokenResponses: [
        { status: 400, body: { error: 'slow_down' } },
        { status: 200, body: token }
      ]
    })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.polls).toHaveLength(1)

    // 加了 5 秒之后,再等 5 秒**不够** —— 这一条就是「累加」和「这次多等一会儿」的分界
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.polls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.polls).toHaveLength(2)
    await run
  })

  it('expired_token 归到「超时」，access_denied 归到「取消」—— 两者都不报红', async () => {
    const expired = deviceHarness({
      tokenResponses: [{ status: 400, body: { error: 'expired_token' } }]
    })
    const runExpired = runOAuthFlow(expired.deps)
    const expiredResult = expect(runExpired).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(5_000)
    await expiredResult

    const denied = deviceHarness({
      tokenResponses: [{ status: 400, body: { error: 'access_denied' } }]
    })
    const runDenied = runOAuthFlow(denied.deps)
    const deniedResult = expect(runDenied).rejects.toMatchObject({ kind: 'cancelled' })
    await vi.advanceTimersByTimeAsync(5_000)
    await deniedResult
  })

  it('★ 认不出来的 error 是故障，不是继续等', async () => {
    const h = deviceHarness({
      tokenResponses: [{ status: 400, body: { error: 'invalid_client' } }]
    })
    const run = runOAuthFlow(h.deps)
    const result = expect(run).rejects.toBeInstanceOf(OAuthFailedError)
    await vi.advanceTimersByTimeAsync(5_000)
    await result
  })

  it('★ 5xx 当故障，不继续轮询 —— 上游挂了再等十五分钟也没用', async () => {
    const h = deviceHarness({ tokenResponses: [{ status: 503, body: {} }] })
    const run = runOAuthFlow(h.deps)
    const result = expect(run).rejects.toBeInstanceOf(OAuthFailedError)
    await vi.advanceTimersByTimeAsync(5_000)
    await result
    expect(h.polls).toHaveLength(1)
  })

  it('★★ 上游给的 expires_in 一到就收，不是干等到本地那 15 分钟', async () => {
    const h = deviceHarness({
      device: {
        device_code: 'dev-1',
        user_code: 'CODE',
        verification_uri: 'https://example.test/pair',
        expires_in: 4,
        interval: 5
      },
      tokenResponses: [{ status: 400, body: { error: 'authorization_pending' } }]
    })
    const run = runOAuthFlow(h.deps)
    const result = expect(run).rejects.toMatchObject({ kind: 'timeout' })
    /*
      ★ 先把微任务放干净再拨钟。截止时间是在**申请设备码那一跳返回之后**才算的
      (`now() + expires_in`),这行之前拨的钟只会把起点一起推后,于是永远到不了期。
    */
    await vi.advanceTimersByTimeAsync(0)
    h.advance(6_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await result
    // ★ 过期之后**一次都没打** token 端点
    expect(h.polls).toHaveLength(0)
  })

  it('★★ 打不开浏览器不致命 —— 用户手里有码和地址，自己开一个就行', async () => {
    const h = deviceHarness({
      tokenResponses: [{ status: 200, body: token }],
      openBrowser: async () => {
        throw new Error('没有默认浏览器')
      }
    })
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(run).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('申请设备码这一步失败就当场结束（不会拿着空 device_code 去轮询）', async () => {
    const h = deviceHarness({
      deviceStatus: 401,
      device: { error: 'invalid_client' },
      tokenResponses: [{ status: 200, body: token }]
    })
    await expect(runOAuthFlow(h.deps)).rejects.toBeInstanceOf(OAuthFailedError)
    expect(h.polls).toHaveLength(0)
  })
})

/* ================================================================
 * cli-poll(服务端发起 + 双通道)—— ZCode 两条渠道的主路径。
 *
 * ★★ 这一组用**真实定时器**,和上面设备码那组正相反:这里的回环服务器和
 * fetch 都是真的 socket,假定时器会卡住 undici 的内部定时。轮询间隔由 init
 * 响应给(1 秒),窗口给两三秒,于是每条用例最多等两秒真实时间。
 * ================================================================ */
describe('runOAuthFlow · cli-poll(ZCode 双通道)', () => {
  const INIT_URL = 'https://example.test/api/v1/oauth/cli/init'
  const POLL_PREFIX = 'https://example.test/api/v1/oauth/cli/poll/'
  const TOKEN_URL = 'https://example.test/token'
  const SERVER_STATE = 'srv-st-1'

  const initBody = (expiresInSec: number): Record<string, unknown> => ({
    code: 0,
    data: {
      flow_id: 'flow-1',
      authorize_url: `https://auth.example.test/authorize?client_id=cid&redirect_uri=${encodeURIComponent('https://zcode.example.test/app/oauth/login')}&state=${SERVER_STATE}`,
      expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
      poll_interval_sec: 1
    }
  })

  const PENDING = { status: 200, body: { code: 0, data: { status: 'pending' } } }
  const READY = {
    status: 200,
    body: { code: 0, data: { status: 'ready', token: 'zcode-jwt', zai: { access_token: 'poll-at' } } }
  }
  const TOKEN_OK = {
    status: 200,
    body: { code: 0, data: { zai: { access_token: 'exchange-at' }, user: { user_id: 42 } } }
  }

  const cliSpec: OAuthProviderSpec = {
    id: 'zcode-zai',
    label: '服务端发起家',
    tokenUrl: TOKEN_URL,
    clientId: 'cid',
    pkce: false,
    grant: {
      kind: 'cli-poll',
      initUrl: INIT_URL,
      provider: 'zai',
      redirectParam: 'redirect_uri',
      landingPath: '/callback',
      host: '127.0.0.1',
      fallback: {
        kind: 'authorization-code',
        authorizeUrl: 'https://fallback.test/authorize',
        redirect: { kind: 'loopback-ephemeral', path: '/callback' }
      }
    },
    oauthHeaders: { 'user-agent': 'ZCode/3.11.2' },
    /*
      ★ identity 直接读**原样信封** —— 这条断言的隐含契约是:flow 把 poll 响应
      或换码响应**不拆信封**地交出来(两条通道同构,拆信封是 issuer 的事)。
    */
    identity: (json) => {
      const data = (json as { data?: { zai?: { access_token?: string } } }).data
      const at = data?.zai?.access_token
      if (at === undefined) return null
      return { accessToken: at, refreshToken: 'rt', expiresAt: null, accountId: 'acct' }
    },
    tokenRequest: (args) => ({
      contentType: 'json',
      body: { provider: 'zai', code: args.code, redirect_uri: args.redirectUri, state: args.state }
    }),
    transport: () => ({ headers: {}, body: (b) => b })
  }

  interface CliHarness {
    deps: OAuthFlowDeps
    opened: string[]
    initRequests: { headers: Record<string, string>; body: Record<string, unknown> }[]
    pollRequests: { url: string; headers: Record<string, string> }[]
    tokenRequests: { body: Record<string, unknown> }[]
    abort: () => void
  }

  /**
   * ★ `browser` 决定 A 通道的命运:`'land'` 模拟授权完跳回回环(带 code+state),
   * `'deny'` 带 error 参数落地,`'lost'` 模拟回调丢失(浏览器停在授权页)。
   */
  function cliHarness(
    options: {
      init?: { status: number; body: unknown }
      expiresInSec?: number
      /** 一次一条按顺序回;'network-error' 表示 fetch 直接抛 */
      polls?: ({ status: number; body: unknown } | 'network-error')[]
      token?: { status: number; body: unknown }
      browser?: 'land' | 'deny' | 'lost'
      noFallback?: boolean
    } = {}
  ): CliHarness {
    const opened: string[] = []
    const initRequests: CliHarness['initRequests'] = []
    const pollRequests: CliHarness['pollRequests'] = []
    const tokenRequests: CliHarness['tokenRequests'] = []
    const ctrl = new AbortController()
    const polls = options.polls ?? [PENDING]

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      if (url === INIT_URL) {
        initRequests.push({ headers, body: JSON.parse(String(init?.body ?? '{}')) })
        const r = options.init ?? { status: 200, body: initBody(options.expiresInSec ?? 8) }
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      if (url.startsWith(POLL_PREFIX)) {
        pollRequests.push({ url, headers })
        const r = polls[Math.min(pollRequests.length - 1, polls.length - 1)]
        if (r === undefined || r === 'network-error') throw new TypeError('fetch failed')
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      if (url === TOKEN_URL) {
        tokenRequests.push({ body: JSON.parse(String(init?.body ?? '{}')) })
        const r = options.token ?? TOKEN_OK
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      throw new Error(`测试没打算接这个请求:${url}`)
    }) as typeof globalThis.fetch

    const spec: OAuthProviderSpec =
      options.noFallback === true
        ? {
            ...cliSpec,
            grant: {
              ...(cliSpec.grant as Extract<OAuthProviderSpec['grant'], { kind: 'cli-poll' }>),
              fallback: undefined
            }
          }
        : cliSpec

    const openBrowser = async (raw: string): Promise<void> => {
      opened.push(raw)
      const mode = options.browser ?? 'land'
      if (mode === 'lost') return
      const url = new URL(raw)
      const landing = new URL(url.searchParams.get('redirect_uri') ?? url.searchParams.get('redirect') ?? '')
      const q =
        mode === 'deny'
          ? 'error=access_denied&state=' + encodeURIComponent(url.searchParams.get('state') ?? '')
          : 'code=the-code&state=' + encodeURIComponent(url.searchParams.get('state') ?? '')
      await fetch(`http://127.0.0.1:${landing.port}${landing.pathname}?${q}`)
    }

    return {
      deps: {
        spec,
        fetch: fetchImpl,
        now: () => Date.now(),
        openBrowser,
        signal: ctrl.signal
      },
      opened,
      initRequests,
      pollRequests,
      tokenRequests,
      abort: () => ctrl.abort()
    }
  }

  it('★ init 的形状:Bearer 头 + JSON body 只有 provider + oauthHeaders 带上', async () => {
    const h = cliHarness({ polls: [PENDING, READY], browser: 'lost' })
    await runOAuthFlow(h.deps)
    expect(h.initRequests).toHaveLength(1)
    const init = h.initRequests[0]
    const poll = h.pollRequests[0]
    expect(init?.body).toEqual({ provider: 'zai' })
    expect(init?.headers['authorization']).toMatch(/^Bearer /u)
    expect(init?.headers['user-agent']).toBe('ZCode/3.11.2')
    // ★ poll 带的是**同一个** pollToken —— 它是这条 flow 的取件凭证
    expect(poll?.headers['authorization']).toBe(init?.headers['authorization'])
    expect(poll?.url).toBe(`${POLL_PREFIX}flow-1`)
  })

  it('★★★ authorize_url 的 redirect_uri 被覆盖成回环，服务端的 state 与其余参数原样保留', async () => {
    const h = cliHarness({ polls: [PENDING, READY], browser: 'lost' })
    await runOAuthFlow(h.deps)
    const url = new URL(h.opened[0] ?? '')
    const landing = new URL(url.searchParams.get('redirect_uri') ?? '')
    // 临时端口(>0)—— 主路径不再占 zai 注册的 9999
    expect(landing.hostname).toBe('127.0.0.1')
    expect(landing.pathname).toBe('/callback')
    expect(Number(landing.port)).toBeGreaterThan(0)
    // 服务端签发的 state 原样带出去 —— 它是 A 通道比对的基准
    expect(url.searchParams.get('state')).toBe(SERVER_STATE)
    expect(url.searchParams.get('client_id')).toBe('cid')
    // 中转页一个字都不出现(理由见 zcode-bigmodel.ts 文件头)
    expect(url.searchParams.get('redirect_uri')).not.toContain('zcode.example.test')
  })

  it('★★★ A 通道赢:回环收码 → 换码 body 带 provider/code/回环 redirect_uri/服务端 state', async () => {
    const h = cliHarness({ polls: [PENDING] })
    const cred = await runOAuthFlow(h.deps)
    expect(cred.accessToken).toBe('exchange-at')
    expect(h.tokenRequests).toHaveLength(1)
    const landing = new URL(new URL(h.opened[0] ?? '').searchParams.get('redirect_uri') ?? '')
    expect(h.tokenRequests[0]?.body).toEqual({
      provider: 'zai',
      code: 'the-code',
      redirect_uri: `http://127.0.0.1:${landing.port}/callback`,
      state: SERVER_STATE
    })
    // ★ B 通道同时也在跑(立即首询过一次),只是没它的事了
    expect(h.pollRequests.length).toBeGreaterThanOrEqual(1)
  })

  it('★★★ B 通道赢:回调丢失也不影响 —— poll ready 直接给凭证,且一次换码都没发', async () => {
    const h = cliHarness({ polls: [PENDING, READY], browser: 'lost' })
    const cred = await runOAuthFlow(h.deps)
    expect(cred.accessToken).toBe('poll-at')
    expect(h.tokenRequests).toHaveLength(0)
    expect(h.pollRequests).toHaveLength(2)
  })

  it('★★ 回环收到 error 参数 → 立刻失败(用户拒绝,不用等轮询慢慢发现)', async () => {
    const h = cliHarness({ browser: 'deny', polls: [PENDING] })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/access_denied/u)
  })

  it('★★ poll 4xx(非 408/429)→ 致命:flow_id/pollToken 不被认,重试到天荒地老也没用', async () => {
    const h = cliHarness({ polls: [{ status: 404, body: {} }], browser: 'lost' })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/HTTP 404/u)
  })

  it('★★ poll 网络错误 → 重试,下一次 ready 照样成功', async () => {
    const h = cliHarness({ polls: ['network-error', READY], browser: 'lost' })
    const cred = await runOAuthFlow(h.deps)
    expect(cred.accessToken).toBe('poll-at')
    expect(h.pollRequests).toHaveLength(2)
  })

  it('★ status=failed → 授权失败(服务端明说这次没成)', async () => {
    const h = cliHarness({
      polls: [{ status: 200, body: { code: 0, data: { status: 'failed' } } }],
      browser: 'lost'
    })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/授权失败/u)
  })

  it('★ 信封 code 非 0 → 带上那个 code 报错,和换码那跳同一个翻译习惯', async () => {
    const h = cliHarness({
      polls: [{ status: 200, body: { code: 1000, msg: 'nope' } }],
      browser: 'lost'
    })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/1000/u)
  })

  it('★ 未知的 status → 报错而不是当 pending 吞下去', async () => {
    const h = cliHarness({
      polls: [{ status: 200, body: { code: 0, data: { status: 'weird' } } }],
      browser: 'lost'
    })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/weird/u)
  })

  it('★★ 窗口耗尽 → 超时(放弃,不报红),不是失败', async () => {
    const h = cliHarness({ polls: [PENDING], browser: 'lost', expiresInSec: 2 })
    await expect(runOAuthFlow(h.deps)).rejects.toBeInstanceOf(OAuthAbandonedError)
  })

  it('★★ 用户取消 → Abandoned(界面不该弹红条)', async () => {
    const h = cliHarness({ polls: [PENDING], browser: 'lost', expiresInSec: 8 })
    const run = runOAuthFlow(h.deps)
    await new Promise((r) => setTimeout(r, 150))
    h.abort()
    await expect(run).rejects.toBeInstanceOf(OAuthAbandonedError)
  })

  it('★★★ init 失败 + 有 fallback → 降级走旧链路:授权页是渠道表里那个,换码照发', async () => {
    const h = cliHarness({ init: { status: 404, body: {} } })
    const cred = await runOAuthFlow(h.deps)
    // fallback 的 authorizeUrl 打开,且是标准授权码那套参数(本地生成的 state)
    const url = new URL(h.opened[0] ?? '')
    expect(url.origin).toBe('https://fallback.test')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).not.toBe(SERVER_STATE)
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/u)
    // 换码发生了,code 是我们模拟浏览器送回去的那个,state 与授权请求一致
    expect(h.tokenRequests).toHaveLength(1)
    expect(h.tokenRequests[0]?.body['code']).toBe('the-code')
    expect(h.tokenRequests[0]?.body['state']).toBe(url.searchParams.get('state'))
    expect(cred.accessToken).toBe('exchange-at')
    // 降级发生在 init 一步,轮询从未开始
    expect(h.pollRequests).toHaveLength(0)
  })

  it('★★ init 失败且没有 fallback → 当场报错,不挂一个不存在的通道', async () => {
    const h = cliHarness({ init: { status: 404, body: {} }, noFallback: true })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/初始化授权流程失败/u)
    expect(h.opened).toHaveLength(0)
  })

  it('★★ init 响应缺 state 的 authorize_url → 无效,走 fallback', async () => {
    const h = cliHarness({
      init: {
        status: 200,
        body: {
          code: 0,
          data: { flow_id: 'f', authorize_url: 'https://auth.example.test/authorize', expires_at: 9999999999, poll_interval_sec: 1 }
        }
      }
    })
    await runOAuthFlow(h.deps)
    // A 通道没有比对基准,init 判无效 → 降级;浏览器开的是 fallback 的授权页
    expect(new URL(h.opened[0] ?? '').origin).toBe('https://fallback.test')
  })
})

/* ================================================================
 * keypair-binding(Ollama 密钥绑定)—— 全程假钩子:这里测的是**编排**
 * (开绑定页 → 轮询 → 验证 → 交出中间形态),协议本身在 issuers 的测试里。
 * ★ 假定时器可用(无 socket/真 I/O),和设备码那组同一个套路。
 * ================================================================ */
describe('runOAuthFlow · keypair-binding(Ollama 密钥绑定)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const KEY = { privateKeyPem: '-----PEM-----', publicKeyLine: 'ssh-ed25519 AAAA' }

  function bindingHarness(options: {
    polls?: (string | null)[]
    verify?: () => Promise<void>
    openBrowserError?: boolean
  } = {}) {
    let clock = NOW
    const polls = options.polls ?? [null, 'alice']
    const opened: string[] = []
    const phases: string[] = []
    let pollCalls = 0
    const spec: OAuthProviderSpec = {
      id: 'ollama-cloud',
      label: '密钥绑定家',
      tokenUrl: 'https://example.test/token',
      clientId: 'c',
      grant: { kind: 'keypair-binding', pollIntervalMs: 1_000, timeoutMs: 60_000 },
      keypairBinding: {
        loadOrCreate: async () => KEY,
        connectUrl: (pub) => `https://example.test/connect?key=${pub.slice(-4)}`,
        poll: async () => polls[Math.min(pollCalls++, polls.length - 1)] ?? null,
        ...(options.verify === undefined ? {} : { verify: options.verify })
      },
      identity: (json) => {
        const o = json as { username?: string }
        return o.username === undefined
          ? null
          : {
              accessToken: (json as { privateKeyPem: string }).privateKeyPem,
              refreshToken: (json as { publicKeyLine: string }).publicKeyLine,
              expiresAt: null,
              accountId: o.username
            }
      },
      transport: () => ({ headers: {}, body: (b) => b })
    }
    const deps: OAuthFlowDeps = {
      spec,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => clock,
      openBrowser: async (url) => {
        if (options.openBrowserError === true) throw new Error('没有默认浏览器')
        opened.push(url)
      },
      onPhase: (phase) => {
        phases.push(phase)
      },
      signal: new AbortController().signal
    }
    return {
      deps,
      opened,
      phases,
      advance: (ms: number) => {
        clock += ms
      }
    }
  }

  it('★★★ 走通:开绑定页 → 轮询到用户名 → 凭证两槽装密钥对', async () => {
    const h = bindingHarness({ polls: [null, null, 'alice'] })
    const run = runOAuthFlow(h.deps)
    // 第一轮立即查(已绑定的机器瞬时登录),之后每 1s 一轮
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const cred = await run
    expect(h.opened).toEqual(['https://example.test/connect?key=AAAA'])
    expect(cred).toMatchObject({
      accessToken: '-----PEM-----',
      refreshToken: 'ssh-ed25519 AAAA',
      accountId: 'alice'
    })
    expect(h.phases).toEqual(['opening', 'waiting', 'done'])
  })

  it('★★ verify 失败 → 登录失败(把「网关不认签名」说在登录时)', async () => {
    const h = bindingHarness({
      polls: ['alice'],
      verify: async () => {
        throw new OAuthFailedError('已绑定成功，但网关不接受签名鉴权')
      }
    })
    const run = runOAuthFlow(h.deps)
    // ★ 断言先挂上再推进定时器 —— 反过来的话 rejection 会在挂上之前飞出去,
    //   变成一条 unhandled rejection
    const expectation = expect(run).rejects.toThrow(/不接受签名/u)
    await vi.advanceTimersByTimeAsync(0)
    await expectation
    // ★ flow 自己不发 failed —— 那是 ipc/provider-auth 把异常翻译成阶段的地方
    expect(h.phases).toEqual(['opening', 'waiting', 'exchanging'])
  })

  it('★★ 一直未绑定 → 超时归 Abandoned(放弃,不报红)', async () => {
    const h = bindingHarness({ polls: [null] })
    const run = runOAuthFlow(h.deps)
    const expectation = expect(run).rejects.toBeInstanceOf(OAuthAbandonedError)
    await vi.advanceTimersByTimeAsync(0)
    // 假定时器管 sleep,注入时钟管期限 —— 两个都要往前推
    h.advance(60_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expectation
  })

  it('★ 取消 → Abandoned cancelled', async () => {
    const ctrl = new AbortController()
    const h = bindingHarness({ polls: [null] })
    h.deps.signal = ctrl.signal
    const run = runOAuthFlow(h.deps)
    await vi.advanceTimersByTimeAsync(0)
    ctrl.abort()
    await expect(run).rejects.toBeInstanceOf(OAuthAbandonedError)
  })

  it('★★ 绑定页打不开 → 当场失败(用户没有别的途径拿到这条带公钥的 URL)', async () => {
    const h = bindingHarness({ openBrowserError: true })
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/打不开浏览器/u)
  })

  it('★ 声明了 grant 却没实现钩子 → 当场报错,而不是走进一条空分支', async () => {
    const h = bindingHarness()
    delete (h.deps.spec as { keypairBinding?: unknown }).keypairBinding
    await expect(runOAuthFlow(h.deps)).rejects.toThrow(/keypairBinding/u)
  })
})
