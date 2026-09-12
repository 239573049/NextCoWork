/**
 * OAuth 凭证在 router 里的行为 —— **这一层的两条底线各有一条断言:**
 *
 * 1. API Key 供应商的请求头和改造前**逐字节相同**(零回归);
 * 2. 401 之后**恰好刷新一次**并重发,而不是切到下一家。
 */
import { describe, expect, it, vi } from 'vitest'
import { nodeHost } from '../../host'
import { serializeCredential, type OAuthCredential } from '../../../../shared/domain/credential'
import type { RunRequest } from '../../../../shared/agent/run-request'
import type { ModelAlias, UpstreamProvider } from '../../../../shared/domain/provider'
import { AgentSession } from '../../agent-session'
import { RunHandle } from '../../run-registry'
import { ToolRegistry } from '../../tool/registry'
import { UpstreamRouter } from '../router'
import { messageItem, responseDone, sse } from './openai-fixtures'

const REF = 'provider:codex'
const NOW = 1_700_000_000_000

function idToken(): string {
  const claims = {
    email: 'u@e.test',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' }
  }
  return `h.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.s`
}

const oauth: OAuthCredential = {
  kind: 'oauth',
  issuer: 'chatgpt',
  accessToken: 'at-old',
  refreshToken: 'rt-old',
  expiresAt: NOW + 3_600_000,
  accountId: 'acct-42'
}

const provider: UpstreamProvider = {
  id: 'codex',
  name: 'Codex',
  protocol: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  credentialRef: REF,
  priority: 60,
  enabled: true
}

const alias: ModelAlias = {
  alias: 'test',
  providerId: 'codex',
  upstreamModel: 'gpt-test',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  capabilities: { tools: false, thinking: false, caching: false, vision: false }
}

const request: RunRequest = {
  runId: 'oauth-run',
  sessionId: 'oauth-session',
  workspaceId: 'w1',
  depth: 0,
  model: 'test',
  input: [{ type: 'text', text: 'hi' }],
  thinking: 'off',
  mode: 'normal',
  permissionMode: 'ask',
  webSearch: false,
  skillIds: []
}

interface Call {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 一条把 `store` 改成 true 的用户 patch。
 *
 * ★ 它是本文件里**唯一一条能区分「transport 是恒等」和「transport 在改 body」**的输入:
 * `encodeOpenAIResponses` 自己就写了 `store: false`,所以光看这个字段在不在、
 * 是不是 false,两条路径的结果一模一样 —— 断言不出任何东西。
 */
const storePatch = {
  preset: 'auto' as const,
  patches: [{ op: 'add' as const, path: '/store', value: true }]
}

function aliasWith(requestAdapter?: typeof storePatch): ModelAlias {
  return { ...alias, ...(requestAdapter === undefined ? {} : { requestAdapter }) }
}

function rig(
  seed: string,
  responses: (n: number, url: string) => Response,
  modelAlias: ModelAlias = alias,
  providerOver: Partial<UpstreamProvider> = {}
) {
  const calls: Call[] = []
  const mem = new Map<string, string>([[REF, seed]])
  const host = nodeHost({
    clock: { now: () => NOW },
    secrets: {
      get: async (ref) => mem.get(ref) ?? null,
      set: async (ref, v) => {
        mem.set(ref, v)
      },
      available: () => true
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fetch: (async (url: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v
      }
      calls.push({ url: String(url), headers, body: String(init?.body ?? '') })
      return responses(calls.length, String(url))
    }) as typeof globalThis.fetch
  })
  const router = new UpstreamRouter(
    host,
    {
      providers: () => [{ ...provider, ...providerOver }],
      aliases: () => [modelAlias],
      failoverEnabled: () => false
    },
    { baseDelayMs: 0 }
  )
  return { router, host, calls, mem }
}

async function drain(router: UpstreamRouter, host: ReturnType<typeof nodeHost>): Promise<void> {
  const handle = new RunHandle(request)
  await new AgentSession(
    { host, upstream: router, tools: new ToolRegistry(), workspaceRoot: '/workspace' },
    handle,
    request
  ).run()
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: 'at-new',
      refresh_token: 'rt-new',
      expires_in: 3600,
      id_token: idToken()
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

describe('router · OAuth 凭证', () => {
  it('带上账号头和 access token', async () => {
    const r = rig(serializeCredential(oauth), () => sse(responseDone([messageItem])))
    await drain(r.router, r.host)

    const h = r.calls[0]?.headers ?? {}
    expect(h['authorization']).toBe('Bearer at-old')
    expect(h['chatgpt-account-id']).toBe('acct-42')
    expect(h['openai-beta']).toBe('responses=experimental')
    expect(h['originator']).toBe('codex_cli_rs')
    expect(h['session_id']).toMatch(/^[0-9a-f]{8}-/u)
  })

  it('body 里 store 被钉成 false', async () => {
    const r = rig(serializeCredential(oauth), () => sse(responseDone([messageItem])))
    await drain(r.router, r.host)
    expect(JSON.parse(r.calls[0]?.body ?? '{}')).toMatchObject({ store: false, stream: true })
  })

  it('★★ 用户 patch 把 store 改成 true，在这条通道上被按回去（供应商硬约束压过模型级自定义）', async () => {
    const r = rig(
      serializeCredential(oauth),
      () => sse(responseDone([messageItem])),
      aliasWith(storePatch)
    )
    await drain(r.router, r.host)
    // 同一条 patch 在 API Key 供应商上是 true（见下面那条），这里必须是 false ——
    // 这条通道对 store:true 会拒，而报错指向的是上游而不是那条 patch
    expect(JSON.parse(r.calls[0]?.body ?? '{}').store).toBe(false)
  })

  it('★★ 首发 401 → 刷新一次并用新 token 重发（不切到下一家）', async () => {
    const r = rig(serializeCredential(oauth), (n, url) => {
      if (url.includes('/oauth/token')) return tokenResponse()
      return n === 1
        ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        : sse(responseDone([messageItem]))
    })
    await drain(r.router, r.host)

    // 上游请求 → token 端点 → 上游请求
    expect(r.calls).toHaveLength(3)
    expect(r.calls[1]?.url).toContain('/oauth/token')
    expect(r.calls[2]?.headers['authorization']).toBe('Bearer at-new')
    // 重发的 body 与首发逐字相同 —— 不重跑 thinking adapter 和用户 patch
    expect(r.calls[2]?.body).toBe(r.calls[0]?.body)
  })

  it('★ 刷完还是 401 → 就此打住，不无限刷', async () => {
    const r = rig(serializeCredential(oauth), (_n, url) =>
      url.includes('/oauth/token')
        ? tokenResponse()
        : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    )
    await drain(r.router, r.host)

    const tokenCalls = r.calls.filter((c) => c.url.includes('/oauth/token'))
    expect(tokenCalls).toHaveLength(1)
  })

  /**
   * ★ 401 重发走的是同一个 `send()` 闭包 —— 它每次都从 `transport.headers` 重新
   * 合并,`extraHeaders` 只带一个鉴权头。所以**供应商装饰的头在重发里还在**。
   *
   * 这条路今天跑不到(OpenCode 走 api-key,而 401 刷新只属于 OAuth),钉它是因为
   * **结构上该成立的事,别等到成立那天才发现不成立**。
   */
  it('★ 401 重发不丢 x-opencode-session', async () => {
    const r = rig(
      serializeCredential(oauth),
      (n, url) => {
        if (url.includes('/oauth/token')) return tokenResponse()
        return n === 1
          ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
          : sse(responseDone([messageItem]))
      },
      alias,
      { baseUrl: 'https://opencode.ai/zen/go/v1' }
    )
    await drain(r.router, r.host)

    const first = r.calls[0]?.headers['x-opencode-session']
    expect(first).toMatch(/^[0-9a-f]{8}-/u)
    expect(r.calls[2]?.headers['authorization']).toBe('Bearer at-new')
    expect(r.calls[2]?.headers['x-opencode-session']).toBe(first)
    // OAuth 自己那几个头也没被装饰挤掉
    expect(r.calls[2]?.headers['chatgpt-account-id']).toBe('acct-42')
  })
})

describe('router · API Key 凭证零回归', () => {
  it('★★ 请求头里不多出任何一个 OAuth 才有的东西', async () => {
    const r = rig('sk-plain-key', () => sse(responseDone([messageItem])))
    await drain(r.router, r.host)

    const h = r.calls[0]?.headers ?? {}
    expect(h['authorization']).toBe('Bearer sk-plain-key')
    expect(h['chatgpt-account-id']).toBeUndefined()
    expect(h['openai-beta']).toBeUndefined()
    expect(h['originator']).toBeUndefined()
    expect(h['session_id']).toBeUndefined()
    // 供应商装饰那一维也不该凭空出现 —— 这条 baseUrl 是 chatgpt.com,不是 OpenCode
    expect(h['x-opencode-session']).toBeUndefined()
  })

  it('★ body 不被 transport 改写 —— 用户的 patch 在 API Key 供应商上照常生效', async () => {
    const r = rig('sk-plain-key', () => sse(responseDone([messageItem])), aliasWith(storePatch))
    await drain(r.router, r.host)
    // transport 是恒等变换，所以这条 patch 一路活到线上
    expect(JSON.parse(r.calls[0]?.body ?? '{}').store).toBe(true)
  })

  it('★ API Key 遇到 401 不会去刷新（那条路只属于 OAuth）', async () => {
    const r = rig('sk-plain-key', () => new Response('{}', { status: 401 }))
    await drain(r.router, r.host)
    expect(r.calls.every((c) => !c.url.includes('/oauth/token'))).toBe(true)
  })
})
