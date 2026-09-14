import { describe, expect, it } from 'vitest'
import { decryptCredentialMap, encryptCredentialMap } from '../provider-export-crypto'

describe('provider export credential encryption', () => {
  it('round trips API key and OAuth serialized credentials', () => {
    const values = {
      'provider:openai': 'sk-test',
      'provider:kimi': JSON.stringify({ kind: 'oauth', issuer: 'kimi-code', accessToken: 'access', refreshToken: 'refresh', expiresAt: null, accountId: 'acct' })
    }
    const encrypted = encryptCredentialMap(values, 'correct horse battery staple')
    expect(decryptCredentialMap(encrypted, 'correct horse battery staple')).toEqual(values)
  })

  it('rejects a wrong password without returning plaintext', () => {
    const encrypted = encryptCredentialMap({ 'provider:test': 'secret' }, 'correct horse battery staple')
    expect(() => decryptCredentialMap(encrypted, 'wrong password')).toThrow('密码验证失败')
  })
})

