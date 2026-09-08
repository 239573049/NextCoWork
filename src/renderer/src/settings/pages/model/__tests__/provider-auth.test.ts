/**
 * 登录态两个纯函数的测试。
 *
 * ★ 最要紧的两条:
 * 1. 「该画登录按钮还是密钥框」判的是**预设**,不是凭证 —— 否则未登录时会退化成
 *    一个填了也没用的密钥框,而那正是用户最需要登录入口的时刻;
 * 2. **正在登录时压过一切** —— 此刻库里那条旧凭证还在,显示它会让人以为已经登完了。
 */
import { describe, expect, it } from 'vitest'
import { OAUTH_ISSUER_IDS } from '../../../../../../shared/domain/oauth-issuer'
import type { CredentialInfo } from '../../../../../../shared/domain/provider'
import {
  credentialInUse,
  oauthIssuerLabel,
  oauthView,
  providerAuthMode,
  providerOAuthIssuer,
  signInEndpointSwitch
} from '../provider-auth'

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
    // ★ `needsPaste` 缺省为 false —— 回环那条(绝大多数)不需要用户动手
    expect(view).toEqual({ state: 'signing-in', phase: 'waiting', needsPaste: false })
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

/**
 * 三态 与 显示名。
 *
 * ★ 这两组一起进来:GLM Coding Plan 那两家既有订阅 key 又能登录,而它们的
 * 登录按钮如果拿不到名字,画出来就是「使用  账号登录」。
 */
describe('providerAuthMode · 三态', () => {
  it('★★ 两种凭证都有的（GLM Coding Plan）判 both —— 判成 oauth 就等于把订阅 key 的输入框拿走', () => {
    expect(providerAuthMode('zai-coding')).toBe('both')
    expect(providerAuthMode('zhipu-coding')).toBe('both')
    expect(providerOAuthIssuer('zai-coding')).toBe('zcode-zai')
    expect(providerOAuthIssuer('zhipu-coding')).toBe('zcode-bigmodel')
  })

  it('★ 没有可粘贴密钥的那家仍然是纯 oauth', () => {
    expect(providerAuthMode('codex')).toBe('oauth')
  })
})

describe('oauthIssuerLabel', () => {
  it.each(OAUTH_ISSUER_IDS)('%s 有名字，且不是空串', (issuer) => {
    /*
      ★★ 空串就是「使用  账号登录」那颗按钮 —— 一句中间少了一个词的话,
      而界面上没有任何一处会说是 issuer 漏登记了。
    */
    expect(oauthIssuerLabel(issuer).trim()).not.toBe('')
  })

  it('登记的名字与预期一致', () => {
    expect(oauthIssuerLabel('chatgpt')).toBe('ChatGPT')
    expect(oauthIssuerLabel('zcode-zai')).toBe('Z.AI')
  })
})

describe('oauthView · 要不要粘', () => {
  it('★ 主进程说这次要粘，就把它带到视图里', () => {
    expect(oauthView(null, { phase: 'waiting', needsPastedCode: true })).toEqual({
      state: 'signing-in',
      phase: 'waiting',
      needsPaste: true
    })
  })
})

describe('credentialInUse', () => {
  it('★★ 登录态下不算「已填密钥」—— hasKey 对两种凭证都为真', () => {
    expect(credentialInUse(info({ email: 'a@b.test' }))).toBe('oauth')
  })

  it('纯 key 的槽认成 api-key，空槽认成 null', () => {
    expect(credentialInUse({ hasKey: true, last4: '1234', encryptionAvailable: true })).toBe(
      'api-key'
    )
    expect(credentialInUse({ hasKey: false, last4: null, encryptionAvailable: true })).toBeNull()
    expect(credentialInUse(null)).toBeNull()
  })
})

describe('signInEndpointSwitch', () => {
  const zai = { id: 'zai-coding', baseUrl: 'https://api.z.ai/api/coding/paas/v4' } as const

  it('★★ 停在 coding 端点上登录 → 挪到 anthropic 端点（否则第一条消息必失败）', () => {
    expect(signInEndpointSwitch({ ...zai, protocol: 'openai-chat' })).toEqual({
      protocol: 'anthropic',
      baseUrl: 'https://api.z.ai/api/anthropic'
    })
  })

  it('已经在目标协议上 → 不动', () => {
    expect(
      signInEndpointSwitch({ id: 'zai-coding', baseUrl: 'https://api.z.ai/api/anthropic', protocol: 'anthropic' })
    ).toBeNull()
  })

  it('★★ 用户自己改过地址 → 一个字都不动，连协议也不换', () => {
    /*
      只换协议不换地址 = 拿 anthropic 协议去打用户那个自建中转,
      比不换更坏 —— 不换他至少还在原来能用的状态上。
    */
    expect(
      signInEndpointSwitch({ ...zai, baseUrl: 'https://my-relay.test/v1', protocol: 'openai-chat' })
    ).toBeNull()
  })

  it('预设里没有那条端点（纯 OAuth 的 codex）→ 不动', () => {
    expect(
      signInEndpointSwitch({ id: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses' })
    ).toBeNull()
  })
})
