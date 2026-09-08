/**
 * PKCE 的测试。**核心是那条 RFC 7636 附录 B 的已知向量** ——
 * 这个变换错一位,表现是换 token 时一个不说明原因的 `invalid_grant`,
 * 而那时你会去怀疑 client_id、redirect_uri、网络,唯独不会怀疑一次 sha256。
 */
import { describe, expect, it } from 'vitest'
import { codeChallengeOf, createPkce, randomState, stateMatches } from '../pkce'

describe('codeChallengeOf', () => {
  it('★ RFC 7636 附录 B 的已知向量', () => {
    expect(codeChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('输出是 base64url —— 不含 + / =', () => {
    expect(codeChallengeOf('x'.repeat(43))).toMatch(/^[A-Za-z0-9_-]+$/u)
  })
})

describe('createPkce', () => {
  it('verifier 落在 RFC 要求的 43–128 个 unreserved 字符里', () => {
    const { verifier } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/u)
  })

  it('challenge 和 verifier 对得上，method 固定 S256', () => {
    const p = createPkce()
    expect(p.challenge).toBe(codeChallengeOf(p.verifier))
    expect(p.method).toBe('S256')
  })

  it('★ 两次调用不相等 —— 可预测的 verifier 等于 PKCE 整个失效', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
  })
})

describe('randomState', () => {
  it('★ 两次不相等 —— 可预测的 state 等于 CSRF 防线整个失效', () => {
    expect(randomState()).not.toBe(randomState())
  })

  it('够长（32 字节 base64url）', () => {
    expect(randomState().length).toBeGreaterThanOrEqual(43)
  })
})

describe('stateMatches', () => {
  it('相等为真', () => {
    expect(stateMatches('abc', 'abc')).toBe(true)
  })

  it('不等为假', () => {
    expect(stateMatches('abc', 'abd')).toBe(false)
  })

  it('★ 长度不等必须先短路 —— timingSafeEqual 对不等长会抛，那个异常会伪装成登录失败', () => {
    expect(() => stateMatches('abc', 'ab')).not.toThrow()
    expect(stateMatches('abc', 'ab')).toBe(false)
    expect(stateMatches('abc', 'abcd')).toBe(false)
  })

  it('缺失为假', () => {
    expect(stateMatches('abc', null)).toBe(false)
    expect(stateMatches('abc', undefined)).toBe(false)
    expect(stateMatches('abc', '')).toBe(false)
  })
})
