/**
 * 传输装饰的边界测试。
 *
 * ★ 最重要的是「API Key 凭证 → 头是空对象、body 恒等」那两条 ——
 * 它们守的是**现有全部供应商零回归**。这一层是插在每一个请求的必经之路上的,
 * 装错了不是某一家坏,是全都坏。
 */
import { describe, expect, it } from 'vitest'
import type { OAuthCredential } from '../../../../shared/domain/credential'
import { CLIENT_PROVIDER_ID } from '../../../../shared/domain/presets'
import type { UpstreamProvider } from '../../../../shared/domain/provider'
import { platformLoginAuth, sessionUuid, upstreamTransport } from '../transport'

const provider: UpstreamProvider = {
  id: 'p',
  name: 'P',
  protocol: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  credentialRef: 'provider:p',
  priority: 60,
  enabled: true
}

const oauth: OAuthCredential = {
  kind: 'oauth',
  issuer: 'chatgpt',
  accessToken: 'at-123',
  refreshToken: 'rt-456',
  expiresAt: 9_999_999_999_999,
  accountId: 'acct-789'
}

describe('upstreamTransport · API Key 零回归', () => {
  it('★ 头是空对象 —— 老供应商一个额外的头都不会多出来', () => {
    const t = upstreamTransport(provider, { kind: 'api-key', apiKey: 'sk-1' }, {})
    expect(t.headers).toEqual({})
  })

  it('★ body 是恒等,连对象引用都不换', () => {
    const t = upstreamTransport(provider, { kind: 'api-key', apiKey: 'sk-1' }, {})
    const body = { model: 'm', stream: true }
    expect(t.body(body)).toBe(body)
  })
})

/**
 * 平台那条上游存的是登录 JWT,而平台网关按头分流:`x-api-key` 查 API Key 表、
 * `Authorization: Bearer` 才验登录态。翻成 Anthropic 格式之后每次对话都是
 * 「API Key 无效或已停用」,而用户从没填过 key。
 */
describe('upstreamTransport · NextCoWork 平台登录态', () => {
  const platform: UpstreamProvider = { ...provider, id: CLIENT_PROVIDER_ID, protocol: 'anthropic' }

  it('登录 token 走 Authorization: Bearer', () => {
    const t = upstreamTransport(platform, { kind: 'api-key', apiKey: 'jwt-1' }, {})
    expect(t.headers.authorization).toBe('Bearer jwt-1')
  })

  it('★ x-api-key 是删掉而不是置空 —— 非空就会被判进 API Key 分支', () => {
    const t = upstreamTransport(platform, { kind: 'api-key', apiKey: 'jwt-1' }, {})
    expect(t.dropHeaders).toContain('x-api-key')
  })

  it('别的供应商不受影响', () => {
    expect(platformLoginAuth('p', 'sk-1')).toBeNull()
  })
})

describe('upstreamTransport · ChatGPT 订阅通道', () => {
  it('四个头齐全', () => {
    const t = upstreamTransport(provider, oauth, { sessionId: 's-1' })
    expect(t.headers['chatgpt-account-id']).toBe('acct-789')
    expect(t.headers['openai-beta']).toBe('responses=experimental')
    expect(t.headers['originator']).toBe('codex_cli_rs')
    expect(t.headers['session_id']).toBe(sessionUuid('s-1'))
  })

  it('★ 用户 patch 把 store 改成 true,仍被按回 false', () => {
    // 从别处抄来的 requestAdapter patch 带个 store:true,会让这家整个不可用,
    // 而报错指向的是上游而不是那条 patch —— 所以硬约束压在最终线上边界
    const t = upstreamTransport(provider, oauth, {})
    expect(t.body({ model: 'm', store: true, stream: false })).toEqual({
      model: 'm',
      store: false,
      stream: true
    })
  })

  it('★ 摘掉 max_output_tokens 和 temperature —— 这条通道对它们直接 400', () => {
    // 实测:Unsupported parameter: max_output_tokens。encode 那边写进去对
    // api.openai.com 是对的,所以只能在这个凭证专属的边界上摘
    const t = upstreamTransport(provider, oauth, {})
    expect(t.body({ model: 'm', max_output_tokens: 8192, temperature: 0.7, input: [] })).toEqual({
      model: 'm',
      input: [],
      store: false,
      stream: true
    })
  })

  it('不动 body 里其他字段', () => {
    const t = upstreamTransport(provider, oauth, {})
    expect(t.body({ model: 'm', input: [{ role: 'user' }] })).toMatchObject({
      model: 'm',
      input: [{ role: 'user' }]
    })
  })
})

describe('sessionUuid', () => {
  it('★ 确定性 —— 同一个 sessionId 任何进程任何时刻算出同一个值', () => {
    expect(sessionUuid('01JABCDEF')).toBe(sessionUuid('01JABCDEF'))
  })

  it('不同 sessionId 不相等', () => {
    expect(sessionUuid('a')).not.toBe(sessionUuid('b'))
  })

  it('是合法的 v4 形状(version 4 + variant 10xx)', () => {
    expect(sessionUuid('01JABCDEF')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
  })

  it('sessionId 缺失时用固定种子,而不是每次现摇一个', () => {
    expect(sessionUuid(undefined)).toBe(sessionUuid(''))
    expect(sessionUuid(undefined)).toMatch(/^[0-9a-f]{8}-/u)
  })
})
