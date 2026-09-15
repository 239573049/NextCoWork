/**
 * 规格表本身 —— 只测**数据**,不测流程。
 *
 * ★ 这份文件的存在理由是 `redirectUriOf`:授权请求和换 token 请求里的
 * redirect_uri 必须**逐字相同**,不一致就是一个不说明原因的 `invalid_grant`。
 * 它现在还多了一个 `host` 变量,而那个变量错了只会在**真登录的最后一步**炸。
 */
import { describe, expect, it } from 'vitest'
import { OAUTH_ISSUER_IDS } from '../../../../shared/domain/oauth-issuer'
import { OAUTH_SPECS, oauthSpecOf, redirectUriOf, type OAuthRedirect } from '../registry'

describe('redirectUriOf · host', () => {
  it('不写 host 时是 localhost —— 这是加 host 字段之前的行为，不能变', () => {
    expect(redirectUriOf({ kind: 'loopback-fixed', port: 1455, path: '/auth/callback' })).toBe(
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
      redirectUriOf({ kind: 'loopback-fixed', port: 9999, path: '/callback', host: '127.0.0.1' })
    ).toBe('http://127.0.0.1:9999/callback')
  })

  it('临时端口用 bind 完的那个，host 一样跟着走', () => {
    const redirect: OAuthRedirect = {
      kind: 'loopback-ephemeral',
      path: '/callback',
      host: '127.0.0.1'
    }
    expect(redirectUriOf(redirect, 54321)).toBe('http://127.0.0.1:54321/callback')
  })

  it('手动粘贴那种原样返回（自定义 scheme，拼不出端口）', () => {
    expect(redirectUriOf({ kind: 'manual-paste', redirectUri: 'zcode://oauth/callback' })).toBe(
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

  it('★ 每家授权码流程都给得出一个非空的 redirect_uri', () => {
    for (const issuer of OAUTH_ISSUER_IDS) {
      const grant = OAUTH_SPECS[issuer].grant
      /*
        ★ 设备码那条**没有 redirect_uri**,不是「拼不出来」而是这个概念在
        RFC 8628 里根本不存在(见 `registry.ts` 的 `OAuthGrant`)。cli-poll 那条
        的落地回环端口要 bind 完才知道、且对服务端没有注册值约束,它的
        redirect_uri 形状由 `zcode.test.ts` 钉。这里都跳过,而不是编一个空串
        去满足断言。
      */
      if (grant.kind !== 'authorization-code') continue
      expect(redirectUriOf(grant.redirect, 1), issuer).not.toBe('')
    }
  })

  it('★★ 每家的 grant 端点都非空且是合法 URL(三种授权方式各认各的)', () => {
    /*
      三种 grant 各自的必填端点**不能是空串**,而空串在类型上完全合法。
      cli-poll 那种还有 fallback 端点(fallback 的授权入口),一并查 ——
      init 失败降级时它就是唯一的授权入口,空串的表现是打开一个空页。
    */
    for (const issuer of OAUTH_ISSUER_IDS) {
      const grant = OAUTH_SPECS[issuer].grant
      const endpoint =
        grant.kind === 'authorization-code'
          ? grant.authorizeUrl
          : grant.kind === 'cli-poll'
            ? grant.initUrl
            : grant.kind === 'keypair-binding'
              ? OAUTH_SPECS[issuer].tokenUrl
              : grant.deviceAuthorizationUrl
      expect(endpoint, issuer).not.toBe('')
      expect(() => new URL(endpoint), issuer).not.toThrow()

      if (grant.kind === 'cli-poll') {
        const fallback = grant.fallback
        if (fallback !== undefined) {
          expect(() => new URL(fallback.authorizeUrl), issuer).not.toThrow()
        }
      }
    }
  })
})
