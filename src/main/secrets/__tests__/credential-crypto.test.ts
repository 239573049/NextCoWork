import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decryptCredentialValue,
  encryptCredentialValue,
  isProgramEncrypted,
  loadOrCreateMasterKey,
  migrateCredentialRows
} from '../credential-crypto'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncw-secrets-'))
  tempDirs.push(dir)
  return dir
}

describe('credential blob format', () => {
  it('round-trips utf8 content including OAuth JSON shapes through encrypt/decrypt', () => {
    const key = randomBytes(32)
    for (const plain of [
      'sk-plain-api-key',
      '{"kind":"oauth","issuer":"chatgpt","accessToken":"at","refreshToken":"rt","expiresAt":null,"accountId":"acc"}',
      '中文密钥/emoji 🔑'
    ]) {
      const blob = encryptCredentialValue(key, plain)
      expect(isProgramEncrypted(blob)).toBe(true)
      expect(decryptCredentialValue(key, blob)).toBe(plain)
    }
  })

  it('uses a fresh nonce per encryption so identical plaintexts never share bytes', () => {
    const key = randomBytes(32)
    const a = encryptCredentialValue(key, 'same')
    const b = encryptCredentialValue(key, 'same')
    expect(a.equals(b)).toBe(false)
  })

  it('recognizes only NCK1-prefixed full-length blobs as program-encrypted', () => {
    expect(isProgramEncrypted(new TextEncoder().encode('{"kind":"api-key"}'))).toBe(false)
    expect(isProgramEncrypted(new TextEncoder().encode('NCK1'))).toBe(false)
    expect(isProgramEncrypted(new Uint8Array(0))).toBe(false)
    // 长度够、magic 对,才认 —— 两者缺一不可
    const real = encryptCredentialValue(randomBytes(32), '')
    expect(isProgramEncrypted(real)).toBe(true)
  })

  it('throws on wrong key, tampered ciphertext and unknown version instead of returning garbage', () => {
    const key = randomBytes(32)
    const blob = encryptCredentialValue(key, 'sk-secret')
    expect(() => decryptCredentialValue(randomBytes(32), blob)).toThrow()
    const tampered = Buffer.from(blob)
    const last = tampered.length - 1
    tampered[last] = (tampered[last] ?? 0) ^ 0xff
    expect(() => decryptCredentialValue(key, tampered)).toThrow()
    const reversioned = Buffer.from(blob)
    reversioned[4] = 99
    expect(() => decryptCredentialValue(key, reversioned)).toThrow('未知的凭证密文版本')
    expect(() => decryptCredentialValue(key, new TextEncoder().encode('not-ours'))).toThrow(
      '凭证密文不是程序加密格式'
    )
  })
})

describe('master key file', () => {
  it('creates a 32-byte key file with 0600 perms and reuses it on next load', () => {
    const dir = tempDir()
    const file = join(dir, 'credential.key')
    const first = loadOrCreateMasterKey(dir)
    expect(first.length).toBe(32)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(loadOrCreateMasterKey(dir).equals(first)).toBe(true)
  })

  it('tightens an existing key to 0600 and rejects a symlink key path', () => {
    const dir = tempDir()
    const file = join(dir, 'credential.key')
    writeFileSync(file, randomBytes(32), { mode: 0o644 })
    chmodSync(file, 0o644)
    loadOrCreateMasterKey(dir).fill(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const linked = tempDir()
    const target = join(linked, 'real-key')
    writeFileSync(target, randomBytes(32))
    symlinkSync(target, join(linked, 'credential.key'))
    expect(() => loadOrCreateMasterKey(linked)).toThrow('主密钥路径不是普通文件')
  })

  it('refuses to regenerate when the existing key file has a wrong length', () => {
    const dir = tempDir()
    const file = join(dir, 'credential.key')
    // 预置一个损坏文件:证明抛错来自校验而不是「文件已存在」本身
    writeFileSync(file, new Uint8Array(7))
    expect(() => loadOrCreateMasterKey(dir)).toThrow('主密钥文件损坏')
  })
})

describe('legacy row migration', () => {
  it('rewrites safeStorage rows as NCK1, leaves program rows and undecryptable rows untouched', () => {
    const key = randomBytes(32)
    const legacyBlob = new TextEncoder().encode('legacy-safe-storage-bytes')
    const failedBlob = new TextEncoder().encode('corrupt-legacy-row')
    const alreadyNew = encryptCredentialValue(key, 'already-migrated')
    const rows = [
      { ref: 'provider:a', blob: legacyBlob },
      { ref: 'provider:b', blob: alreadyNew },
      { ref: 'provider:c', blob: failedBlob }
    ]
    const put = vi.fn()
    const result = migrateCredentialRows({
      list: () => rows,
      put,
      decryptLegacy: (blob) => (blob === legacyBlob ? 'sk-legacy-plain' : null),
      encrypt: (plain) => encryptCredentialValue(key, plain)
    })
    expect(result).toEqual({ migrated: 1, skipped: 1, failed: 1 })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('provider:a', expect.any(Buffer))
    // 写回去的那行必须真能用主密钥解开,并且内容等于旧明文
    const written = put.mock.calls[0]?.[1]
    expect(written !== undefined && decryptCredentialValue(key, written)).toBe('sk-legacy-plain')
  })

  it('is idempotent: a second run over converted rows performs zero writes', () => {
    const key = randomBytes(32)
    const rows = [{ ref: 'provider:a', blob: encryptCredentialValue(key, 'sk-x') }]
    const put = vi.fn()
    const result = migrateCredentialRows({
      list: () => rows,
      put,
      decryptLegacy: () => null,
      encrypt: (plain) => encryptCredentialValue(key, plain)
    })
    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 })
    expect(put).not.toHaveBeenCalled()
  })
})
