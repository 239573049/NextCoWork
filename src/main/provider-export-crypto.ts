import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { EncryptedCredentials } from '../shared/domain/data'

export function encryptCredentialMap(values: Record<string, string>, password: string): EncryptedCredentials {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()])
  return {
    algorithm: 'scrypt-aes-256-gcm',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

export function decryptCredentialMap(block: EncryptedCredentials, password: string): Record<string, string> {
  try {
    const salt = Buffer.from(block.salt, 'base64')
    const nonce = Buffer.from(block.nonce, 'base64')
    const tag = Buffer.from(block.tag, 'base64')
    const ciphertext = Buffer.from(block.ciphertext, 'base64')
    if (salt.length < 16 || salt.length > 64 || nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted block')
    const key = scryptSync(password, salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed: unknown = JSON.parse(plain)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('credentials is not an object')
    const out: Record<string, string> = Object.create(null)
    for (const [keyName, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string' || keyName === '') throw new Error('credential value is not a string')
      out[keyName] = value
    }
    return out
  } catch {
    throw new Error('密码验证失败，未修改任何数据')
  }
}
