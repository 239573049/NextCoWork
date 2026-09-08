/**
 * 登录态两个纯函数的测试。
 *
 * ★ 最要紧的两条:
 * 1. 「该画登录按钮还是密钥框」判的是**预设**,不是凭证 —— 否则未登录时会退化成
 *    一个填了也没用的密钥框,而那正是用户最需要登录入口的时刻;
 * 2. **正在登录时压过一切** —— 此刻库里那条旧凭证还在,显示它会让人以为已经登完了。
 */
import { describe, expect, it } from 'vitest'
import type { CredentialInfo } from '../../../../../../shared/domain/provider'
import { oauthView, providerAuthMode, providerOAuthIssuer } from '../provider-auth'

function info(auth?: Partial<NonNullable<CredentialInfo['auth']>>): CredentialInfo {
  return {
    hasKey: auth !== undefined,
    last4: null,
    encryptionAvailable: true,
    ...(auth === undefined
      ? {}
      : {
          auth: {
            issuer: 'chatgpt' as const,
            accountId: 'acct-1',
            expiresAt: 1,
            expired: false,
            needsReauth: false,
            ...auth
          }
        })
  }
}

describe('providerAuthMode', () => {
  it('★ 预设声明了 oauthIssuer 的走登录', () => {
    expect(providerAuthMode('codex')).toBe('oauth')
    expect(providerOAuthIssuer('codex')).toBe('chatgpt')
  })

  it('其余一律走 API Key', () => {
    expect(providerAuthMode('openai')).toBe('api-key')
    expect(providerAuthMode('anthropic')).toBe('api-key')
    expect(providerOAuthIssuer('openai')).toBeNull()
  })

  it('认不出的自定义供应商也走 API Key', () => {
    expect(providerAuthMode('my-own-relay')).toBe('api-key')
  })
})

describe('oauthView', () => {
  it('没有 auth 字段 = 未登录', () => {
    expect(oauthView(info(), null)).toEqual({ state: 'signed-out' })
    expect(oauthView(null, null)).toEqual({ state: 'signed-out' })
  })

  it('正常登录态带出邮箱和档位', () => {
    expect(oauthView(info({ email: 'a@b.test', planType: 'plus' }), null)).toEqual({
      state: 'signed-in',
      email: 'a@b.test',
      plan: 'plus'
    })
  })

  it('邮箱缺失不影响判定，只是显示上退一步', () => {
    expect(oauthView(info({}), null)).toEqual({ state: 'signed-in', email: null, plan: null })
  })

  it('★★ 正在登录时压过旧凭证 —— 否则会让人以为登录已经完成了', () => {
    const view = oauthView(info({ email: 'old@b.test' }), { phase: 'waiting' })
    expect(view).toEqual({ state: 'signing-in', phase: 'waiting' })
  })

  it('三个中间阶段都算 signing-in', () => {
    for (const phase of ['opening', 'waiting', 'exchanging'] as const) {
      expect(oauthView(null, { phase }).state).toBe('signing-in')
    }
  })

  it('终态阶段不算 signing-in —— 那时该看凭证本身了', () => {
    for (const phase of ['done', 'failed', 'cancelled'] as const) {
      expect(oauthView(info({ email: 'a@b.test' }), { phase }).state).toBe('signed-in')
    }
  })

  it('★ needsReauth 优先于 expired —— 上游明确拒过，比「时间到了」更确定', () => {
    expect(oauthView(info({ needsReauth: true, expired: false, email: 'a@b.test' }), null)).toEqual({
      state: 'expired',
      email: 'a@b.test',
      reason: 'revoked'
    })
  })

  it('★ expired 直接读主进程算好的布尔，渲染层不碰时钟', () => {
    expect(oauthView(info({ expired: true }), null)).toEqual({
      state: 'expired',
      email: null,
      reason: 'expired'
    })
  })
})
