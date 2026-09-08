/**
 * 授权码流程的编排测试 —— **全程假上游、假浏览器,不碰网络也不碰 1455。**
 *
 * 这份测试能存在,正是因为 `flow.ts` 把 fetch / now / openBrowser 三样都做成了注入。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OAuthAbandonedError,
  OAuthFailedError,
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
}

function harness(
  tokenResponse: { status: number; body: unknown },
  callback: (url: URL) => Record<string, string>
): Harness {
  const authorizeUrls: string[] = []
  const tokenBodies: URLSearchParams[] = []

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    tokenBodies.push(new URLSearchParams(String(init?.body ?? '')))
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
      spec,
      fetch: fetchImpl,
      now: () => NOW,
      openBrowser,
      signal: new AbortController().signal
    },
    authorizeUrls,
    tokenBodies
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
