/**
 * 规格表本身 —— 只测**数据**,不测流程。
 *
 * ★ 这份文件的存在理由是 `redirectUriOf`:授权请求和换 token 请求里的
 * redirect_uri 必须**逐字相同**,不一致就是一个不说明原因的 `invalid_grant`。
 * 它现在还多了一个 `host` 变量,而那个变量错了只会在**真登录的最后一步**炸。
 */
import { describe, expect, it } from 'vitest'
import { OAUTH_ISSUER_IDS } from '../../../../shared/domain/oauth-issuer'
import { OAUTH_SPECS, oauthSpecOf, redirectUriOf, type OAuthProviderSpec } from '../registry'

function withRedirect(redirect: OAuthProviderSpec['redirect']): OAuthProviderSpec {
  return { ...oauthSpecOf('chatgpt'), redirect }
}

describe('redirectUriOf · host', () => {
  it('不写 host 时是 localhost —— 这是加 host 字段之前的行为，不能变', () => {
    expect(redirectUriOf(withRedirect({ kind: 'loopback-fixed', port: 1455, path: '/auth/callback' }))).toBe(
      'http://localhost:1455/auth/callback'
    )
  })

  it('★★ 写了 127.0.0.1 就得逐字用它 —— 两者不是同一个 redirect_uri', () => {
    /*
      服务端比对的是**字符串**,不是解析出来的地址。`localhost` 和 `127.0.0.1`
      在网络上等价,在这条比对里不等价 —— 而 ZCode CLI 注册的那个是后者。
      拼错的表现是登录走到最后一步失败,且错误信息里不会出现「redirect_uri」。
    */
    expect(
      redirectUriOf(withRedirect({ kind: 'loopback-fixed', port: 9999, path: '/callback', host: '127.0.0.1' }))
    ).toBe('http://127.0.0.1:9999/callback')
  })

  it('临时端口用 bind 完的那个，host 一样跟着走', () => {
    const spec = withRedirect({ kind: 'loopback-ephemeral', path: '/callback', host: '127.0.0.1' })
    expect(redirectUriOf(spec, 54321)).toBe('http://127.0.0.1:54321/callback')
  })

  it('手动粘贴那种原样返回（自定义 scheme，拼不出端口）', () => {
    expect(redirectUriOf(withRedirect({ kind: 'manual-paste', redirectUri: 'zcode://oauth/callback' }))).toBe(
      'zcode://oauth/callback'
    )
  })
})

describe('OAUTH_SPECS', () => {
  it.each(OAUTH_ISSUER_IDS)('%s 查得到，且 spec.id 和键一致', (issuer) => {
    /*
      ★ 键和 `spec.id` 对不上时,登录能走完、凭证也存下了,但存进去的
      `issuer` 是**另一家** —— 下一次刷新会拿错规格表去刷,而那个失败
      指向的是「登录已失效」。
    */
    expect(oauthSpecOf(issuer).id).toBe(issuer)
  })

  it('★ 每家都给得出一个非空的 redirect_uri', () => {
    for (const issuer of OAUTH_ISSUER_IDS) {
      expect(redirectUriOf(OAUTH_SPECS[issuer], 1), issuer).not.toBe('')
    }
  })
})
