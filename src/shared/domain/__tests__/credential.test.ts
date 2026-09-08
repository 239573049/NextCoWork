/**
 * 凭证格式的边界测试。
 *
 * ★ 这个文件里最重要的是 `serialize(parse(裸key)) === 裸key` 那条 ——
 * 它守的是**降级兼容**:用户退回旧版本时,库里那把 API Key 必须还能用。
 */
import { describe, expect, it } from 'vitest'
import {
  bearerOf,
  parseCredential,
  serializeCredential,
  type OAuthCredential
} from '../credential'

const oauth: OAuthCredential = {
  kind: 'oauth',
  issuer: 'chatgpt',
  accessToken: 'at-123',
  refreshToken: 'rt-456',
  expiresAt: 1_700_000_000_000,
  accountId: 'acct-789',
  email: 'a@b.test',
  planType: 'plus'
}

describe('parseCredential · 历史记录', () => {
  it('裸字符串是 API Key,零迁移', () => {
    expect(parseCredential('sk-abc')).toEqual({ kind: 'api-key', apiKey: 'sk-abc' })
  })

  it('空与 null 都是「没配」', () => {
    expect(parseCredential(null)).toBeNull()
    expect(parseCredential('')).toBeNull()
    expect(parseCredential(undefined)).toBeNull()
  })

  it('★ 以 { 开头但解析失败的,退回当 API Key —— 绝不抛', () => {
    // 一把恰好像 JSON 的 key 如果在这里抛,用户会看到「还没有配置密钥」而他明明配过
    expect(parseCredential('{not json')).toEqual({ kind: 'api-key', apiKey: '{not json' })
    expect(parseCredential('{"a":1}')).toEqual({ kind: 'api-key', apiKey: '{"a":1}' })
    expect(parseCredential('{"kind":"nope"}')).toEqual({
      kind: 'api-key',
      apiKey: '{"kind":"nope"}'
    })
  })

  it('JSON 数组不是对象,也退回当 API Key', () => {
    expect(parseCredential('["x"]')).toEqual({ kind: 'api-key', apiKey: '["x"]' })
  })
})

describe('serializeCredential · 降级兼容', () => {
  it('★★ API Key 回吐裸字符串,不是 JSON —— 旧版本读到的必须还是那把 key', () => {
    const raw = 'sk-live-abcdefgh'
    const parsed = parseCredential(raw)
    expect(parsed).not.toBeNull()
    expect(serializeCredential(parsed!)).toBe(raw)
  })

  it('OAuth 往返不丢字段', () => {
    expect(parseCredential(serializeCredential(oauth))).toEqual(oauth)
  })

  it('可选字段缺失时往返仍相等,且不冒出 undefined 键', () => {
    const minimal: OAuthCredential = {
      kind: 'oauth',
      issuer: 'chatgpt',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1,
      accountId: 'acct'
    }
    const back = parseCredential(serializeCredential(minimal))
    expect(back).toEqual(minimal)
    expect(Object.hasOwn(back as object, 'email')).toBe(false)
  })

  it('needsReauth 为真时保留', () => {
    const flagged: OAuthCredential = { ...oauth, needsReauth: true }
    expect(parseCredential(serializeCredential(flagged))).toEqual(flagged)
  })
})

describe('parseCredential · OAuth 记录残缺', () => {
  // 残缺的 OAuth 记录发不出请求。退回当 API Key 会拿整个 JSON 做 Bearer,
  // 那个 401 比「没配置」更难看懂 —— 所以判「没配置」
  it.each([
    ['缺 accessToken', { ...oauth, accessToken: '' }],
    ['缺 refreshToken', { ...oauth, refreshToken: '' }],
    ['缺 accountId', { ...oauth, accountId: '' }],
    ['issuer 未知', { ...oauth, issuer: 'somebody-else' }],
    ['expiresAt 不是数字', { ...oauth, expiresAt: 'soon' }]
  ])('%s → null', (_label, record) => {
    expect(parseCredential(JSON.stringify(record))).toBeNull()
  })
})

describe('bearerOf', () => {
  it('两种凭证在鉴权头这一点上同构', () => {
    expect(bearerOf({ kind: 'api-key', apiKey: 'sk-1' })).toBe('sk-1')
    expect(bearerOf(oauth)).toBe('at-123')
  })
})
