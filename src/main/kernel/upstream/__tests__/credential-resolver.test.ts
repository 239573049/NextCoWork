/**
 * 凭证刷新的测试。
 *
 * ★★ 这里最重要的是「10 个并发只发一次刷新请求」那条 —— 它守的是一个会
 * **把用户踢下线**的 bug:refresh token 是轮换的,并发刷新时后面几次拿着已经
 * 作废的 token 撞 `invalid_grant`,而那些失败如果去写库,用户就被我们自己登出了。
 */
import { describe, expect, it } from 'vitest'
import { nodeHost, type KernelHost } from '../../host'
import {
  parseCredential,
  serializeCredential,
  type OAuthCredential
} from '../../../../shared/domain/credential'
import { CredentialAuthError, CredentialResolver } from '../credential-resolver'

const REF = 'provider:codex'
const NOW = 1_700_000_000_000

function idToken(): string {
  const claims = {
    email: 'user@example.test',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42', chatgpt_plan_type: 'plus' }
  }
  return `h.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.s`
}

function cred(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    kind: 'oauth',
    issuer: 'chatgpt',
    accessToken: 'old-at',
    refreshToken: 'old-rt',
    expiresAt: NOW + 3_600_000,
    accountId: 'acct-42',
    ...overrides
  }
}

interface Rig {
  host: KernelHost
  calls: URLSearchParams[]
  stored: () => OAuthCredential | null
}

function rig(respond: (n: number) => Response, seed = cred()): Rig {
  const calls: URLSearchParams[] = []
  const mem = new Map<string, string>([[REF, serializeCredential(seed)]])

  const host = nodeHost({
    clock: { now: () => NOW },
    secrets: {
      get: async (ref) => mem.get(ref) ?? null,
      set: async (ref, v) => {
        mem.set(ref, v)
      },
      available: () => true
    },
    fetch: (async (_input: unknown, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body ?? '')))
      return respond(calls.length)
    }) as typeof globalThis.fetch
  })

  return {
    host,
    calls,
    stored: () => {
      const c = parseCredential(mem.get(REF) ?? null)
      return c !== null && c.kind === 'oauth' ? c : null
    }
  }
}

function tokenOk(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      id_token: idToken()
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

const signal = (): AbortSignal => new AbortController().signal

describe('CredentialResolver · 什么时候刷', () => {
  it('API Key 凭证原样返回，一次请求都不发', async () => {
    const r = rig(() => tokenOk('x', 'y'))
    await r.host.secrets.set(REF, 'sk-plain')
    const out = await new CredentialResolver(r.host).resolve(REF, signal())
    expect(out).toEqual({ kind: 'api-key', apiKey: 'sk-plain' })
    expect(r.calls).toHaveLength(0)
  })

  it('没配过返回 null，不是错误', async () => {
    const r = rig(() => tokenOk('x', 'y'))
    await r.host.secrets.set(REF, '')
    expect(await new CredentialResolver(r.host).resolve(REF, signal())).toBeNull()
  })

  it('还没到过期窗口，不刷', async () => {
    const r = rig(() => tokenOk('x', 'y'), cred({ expiresAt: NOW + 3_600_000 }))
    await new CredentialResolver(r.host).resolve(REF, signal())
    expect(r.calls).toHaveLength(0)
  })

  it('★ 剩余不到一分钟就提前刷 —— 请求发出去要时间，卡着过期点发等于必然 401', async () => {
    const r = rig(() => tokenOk('new-at', 'new-rt'), cred({ expiresAt: NOW + 30_000 }))
    const out = await new CredentialResolver(r.host).resolve(REF, signal())
    expect(r.calls).toHaveLength(1)
    expect((out as OAuthCredential).accessToken).toBe('new-at')
  })

  it('refreshNow 不看 expiresAt —— 本机时钟偏和服务端吊销都靠它兜住', async () => {
    const r = rig(() => tokenOk('new-at', 'new-rt'), cred({ expiresAt: NOW + 999_999 }))
    await new CredentialResolver(r.host).refreshNow(REF, signal())
    expect(r.calls).toHaveLength(1)
  })
})

describe('CredentialResolver · 并发去重', () => {
  it('★★ 10 个并发对同一条过期凭证，只发一次刷新请求', async () => {
    const r = rig(() => tokenOk('new-at', 'new-rt'), cred({ expiresAt: NOW - 1 }))
    const resolver = new CredentialResolver(r.host)

    const all = await Promise.all(
      Array.from({ length: 10 }, () => resolver.resolve(REF, signal()))
    )

    // 不去重的话，后 9 次会拿着已作废的 refresh token 撞 invalid_grant，
    // 而那些失败一旦写库，用户就被我们自己的并发踢下线了
    expect(r.calls).toHaveLength(1)
    for (const c of all) expect((c as OAuthCredential).accessToken).toBe('new-at')
  })

  it('刷完之后再来一次，是新的一轮（inflight 清干净了）', async () => {
    const r = rig((n) => tokenOk(`at-${n}`, `rt-${n}`), cred({ expiresAt: NOW - 1 }))
    const resolver = new CredentialResolver(r.host)
    await resolver.refreshNow(REF, signal())
    await resolver.refreshNow(REF, signal())
    expect(r.calls).toHaveLength(2)
  })

  it('★ 轮换后的 refresh token 必须落库 —— 只存在于那一次响应里', async () => {
    const r = rig(() => tokenOk('new-at', 'rotated-rt'), cred({ expiresAt: NOW - 1 }))
    await new CredentialResolver(r.host).refreshNow(REF, signal())
    expect(r.stored()?.refreshToken).toBe('rotated-rt')
    expect(r.calls[0]?.get('refresh_token')).toBe('old-rt')
  })
})

describe('CredentialResolver · 失败分类', () => {
  it('★★ 网络失败 → retryable network，且库里一个字节都不动', async () => {
    const r = rig(() => {
      throw new Error('ECONNREFUSED')
    }, cred({ expiresAt: NOW - 1 }))
    const before = r.stored()

    const err = await new CredentialResolver(r.host).refreshNow(REF, signal()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CredentialAuthError)
    expect((err as CredentialAuthError).error.code).toBe('network')
    expect((err as CredentialAuthError).error.retryable).toBe(true)
    // 离线时删掉 refreshToken，等于因为一次断网强迫用户重新登录
    expect(r.stored()).toEqual(before)
  })

  it('★ 5xx 也按网络故障处理，保留凭证 —— 别拿授权服务器的抽风惩罚用户', async () => {
    const r = rig(() => new Response('{}', { status: 503 }), cred({ expiresAt: NOW - 1 }))
    const err = await new CredentialResolver(r.host).refreshNow(REF, signal()).catch((e: unknown) => e)
    expect((err as CredentialAuthError).error.code).toBe('network')
    expect(r.stored()?.needsReauth).toBeUndefined()
    expect(r.stored()?.refreshToken).toBe('old-rt')
  })

  it('★★ invalid_grant → auth 且 not retryable，标 needsReauth 但保留 refreshToken', async () => {
    const r = rig(
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      cred({ expiresAt: NOW - 1 })
    )
    const err = await new CredentialResolver(r.host).refreshNow(REF, signal()).catch((e: unknown) => e)
    expect((err as CredentialAuthError).error.code).toBe('auth')
    expect((err as CredentialAuthError).error.retryable).toBe(false)

    await new Promise((res) => setTimeout(res, 10))
    expect(r.stored()?.needsReauth).toBe(true)
    // 删了的话连「当时存的是什么」这条排查线索都没了；用户重新登录会覆盖它
    expect(r.stored()?.refreshToken).toBe('old-rt')
  })

  it('刷新成功会清掉之前的 needsReauth 标记', async () => {
    const r = rig(() => tokenOk('new-at', 'new-rt'), cred({ expiresAt: NOW - 1, needsReauth: true }))
    await new CredentialResolver(r.host).refreshNow(REF, signal())
    expect(r.stored()?.needsReauth).toBeUndefined()
  })
})

describe('CredentialResolver · 变更通知', () => {
  it('刷新成功后通知一次，带的是 ref', async () => {
    const r = rig(() => tokenOk('new-at', 'new-rt'), cred({ expiresAt: NOW - 1 }))
    const seen: string[] = []
    await new CredentialResolver(r.host, (ref) => seen.push(ref)).refreshNow(REF, signal())
    expect(seen).toEqual([REF])
  })

  it('★ 标成 needsReauth 时也通知 —— 用户可能正开着设置页看着「已登录」', async () => {
    const r = rig(
      () => new Response('{}', { status: 400 }),
      cred({ expiresAt: NOW - 1 })
    )
    const seen: string[] = []
    await new CredentialResolver(r.host, (ref) => seen.push(ref))
      .refreshNow(REF, signal())
      .catch(() => {})
    await new Promise((res) => setTimeout(res, 10))
    expect(seen).toEqual([REF])
  })
})
