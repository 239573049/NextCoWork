/**
 * Ollama 密钥绑定链路的**协议实现**测试 —— 不碰网络,SSH 解析/生成用真实算法
 * 自洽验证(生成 → 解析 → 签名 → 用推导公钥验签),端点交互全用假 fetch。
 *
 * ★ 这里守的不是「能不能真登上去」(那要浏览器),是**协议形状**:签名格式错一位,
 * 服务端回的就是一个不解释的 401,而错误信息里不会出现任何可对表的字段。
 */
import { createPublicKey, verify as ed25519Verify, createPrivateKey } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OAuthExchangeContext } from '../../registry'
import {
  connectUrl,
  generateKeyPair,
  loadOrCreateKeypair,
  parseOpenSSHEd25519,
  signAuthorization,
  OLLAMA_CLOUD_OAUTH
} from '../ollama'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ctxWith(fetchImpl: typeof globalThis.fetch): OAuthExchangeContext {
  return { fetch: fetchImpl, signal: new AbortController().signal, now: 1_000 }
}

/** 从 seed 推导原始 ed25519 公钥(32 字节)—— 验签和官方 .pub 推导共用这条路径 */
function rawPublicKeyOf(privateKeyPem: string): Buffer {
  const { seed } = parseOpenSSHEd25519(privateKeyPem)
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  })
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)
}

describe('ollama · SSH 密钥的生成与解析', () => {
  it('★★ 生成 → 解析 → 拿回 32 字节 seed(官方 openssh-key-v1 无口令格式)', () => {
    const pair = generateKeyPair()
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/u)
    expect(pair.publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/u)
    const { seed } = parseOpenSSHEd25519(pair.privateKeyPem)
    expect(seed).toHaveLength(32)
  })

  it('★ 公钥行和从 seed 推导的公钥逐字节一致 —— 服务端绑的就是这把', () => {
    const pair = generateKeyPair()
    const pubBlobB64 = pair.publicKeyLine.split(' ')[1] ?? ''
    const blob = Buffer.from(pubBlobB64, 'base64')
    // wire:string("ssh-ed25519")(4+11) + string(pub32)(4+32) → 公钥从第 19 字节起
    expect(blob.subarray(19)).toEqual(rawPublicKeyOf(pair.privateKeyPem))
  })

  it('带口令的私钥报人话,而不是解析到一半炸出没人懂的错', () => {
    expect(() => parseOpenSSHEd25519('-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'YWJj'.repeat(40))).toThrow(
      /openssh-key-v1/u
    )
  })
})

describe('ollama · loadOrCreateKeypair(复用 ~/.ollama)', () => {
  function tempHome(): string {
    return mkdtempSync(join(tmpdir(), 'ollama-kp-'))
  }

  it('★★ 文件不存在 → 生成并落盘(私钥 0600 的位置就是官方 CLI 的位置)', () => {
    const home = tempHome()
    const pair = loadOrCreateKeypair(home)
    expect(existsSync(join(home, '.ollama', 'id_ed25519'))).toBe(true)
    expect(existsSync(join(home, '.ollama', 'id_ed25519.pub'))).toBe(true)
    expect(parseOpenSSHEd25519(pair.privateKeyPem).seed).toHaveLength(32)
  })

  it('★★ 文件已存在 → 原样复用(官方 CLI 绑过 = 这边已登录的全部依据)', () => {
    const home = tempHome()
    const first = loadOrCreateKeypair(home)
    // 模拟外部写入(官方 CLI 重新生成)后,读回来的是文件里的那把,不是内存里的
    const second = loadOrCreateKeypair(home)
    expect(second.privateKeyPem).toBe(first.privateKeyPem)
  })

  it('★ .pub 丢失也不依赖 —— 公钥行永远从私钥 seed 推导', () => {
    const home = tempHome()
    const first = loadOrCreateKeypair(home)
    writeFileSync(join(home, '.ollama', 'id_ed25519.pub'), 'ssh-ed25519 GARBAGE\n')
    const second = loadOrCreateKeypair(home)
    expect(second.publicKeyLine).toBe(first.publicKeyLine)
  })
})

describe('ollama · 签名格式(官方 auth.Sign 的逐字复刻)', () => {
  it('★★★★ Authorization = <公钥blob的b64std>:<ed25519裸签名的b64std>,且签名可被公钥验证', () => {
    const pair = generateKeyPair()
    const fixedNow = 1_760_000_000_000
    const { authorization, ts } = signAuthorization(
      pair.privateKeyPem,
      pair.publicKeyLine,
      `POST,/api/me?ts=${Math.floor(fixedNow / 1000)}`,
      () => fixedNow
    )
    const [pubB64, sigB64] = authorization.split(':')
    expect(ts).toBe('1760000000')
    expect(pubB64).toBe(pair.publicKeyLine.split(' ')[1])
    // 签名必须真的对得上这把公钥 —— 格式对而签名错,服务端只会回一个不解释的 401
    const ok = ed25519Verify(
      null,
      Buffer.from(`POST,/api/me?ts=${ts}`, 'utf8'),
      createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          parseOpenSSHEd25519(pair.privateKeyPem).seed
        ]),
        format: 'der',
        type: 'pkcs8'
      }),
      Buffer.from(sigB64 ?? '', 'base64')
    )
    expect(ok).toBe(true)
  })

  it('connectUrl:完整公钥行 base64url 进 key,hostname 进 name', () => {
    const pair = generateKeyPair()
    const url = new URL(connectUrl(pair.publicKeyLine, 'My-Mac'))
    expect(url.origin).toBe('https://ollama.com')
    expect(url.pathname).toBe('/connect')
    expect(url.searchParams.get('name')).toBe('My-Mac')
    expect(Buffer.from(url.searchParams.get('key') ?? '', 'base64url').toString('utf8')).toBe(
      pair.publicKeyLine
    )
  })
})

describe('ollama · whoami 轮询与验证探针', () => {
  const pair = generateKeyPair()

  it('★★ 未绑定 = 200 全零值用户(官方语义) → 继续轮询;401 视同', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/api/me?ts=')
      return jsonResponse({ ID: '00000000-0000-0000-0000-000000000000', Name: '', Email: '' })
    }) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.poll(pair, ctxWith(fetchImpl))).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('★ 绑定完成 → 用户名', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Name: 'alice', Email: 'a@o.test', Plan: 'pro' })) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.poll(pair, ctxWith(fetchImpl))).resolves.toBe('alice')
  })

  it('★ 轮询容忍一切抖动:网络错误/5xx 都归「还没绑好」', async () => {
    const bad = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.poll(pair, ctxWith(bad))).resolves.toBeNull()
    const fiveHundred = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.poll(pair, ctxWith(fiveHundred))).resolves.toBeNull()
  })

  it('★★★ 探针:401 = /v1 网关不认签名 → 当场说清楚,给出 API Key 退路', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Unauthorized' } }, 401)) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.verify!(pair, ctxWith(fetchImpl))).rejects.toThrow(
      /API Key/u
    )
  })

  it('★★★ 探针:非 401(哪怕 404) = 鉴权已过,死在模型名上 → 通过', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push(String(url))
      expect(String(url)).toContain('/v1/chat/completions?ts=')
      expect(JSON.parse(String(init?.body ?? '{}')).model).toBe('__nextcowork_auth_probe__')
      return jsonResponse({ error: { message: 'model not found' } }, 404)
    }) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.keypairBinding!.verify!(pair, ctxWith(fetchImpl))).resolves.toBeUndefined()
    expect(seen).toHaveLength(1)
  })
})

describe('ollama · identity / refresh / transport', () => {
  const pair = generateKeyPair()

  it('★★ 两槽的语义:accessToken=私钥,refreshToken=公钥行(都不是字面 token)', () => {
    const id = OLLAMA_CLOUD_OAUTH.identity(
      { username: 'alice', privateKeyPem: pair.privateKeyPem, publicKeyLine: pair.publicKeyLine },
      1_000
    )
    expect(id).toMatchObject({
      accessToken: pair.privateKeyPem,
      refreshToken: pair.publicKeyLine,
      expiresAt: null,
      accountId: 'alice'
    })
    // 缺任何一块 → null(由调用方判登录失败)
    expect(OLLAMA_CLOUD_OAUTH.identity({ username: 'alice' }, 1_000)).toBeNull()
  })

  it('★★ refresh:绑定还在 → 原样返回并带上 plan;解绑(全零值)→ null 走登出', async () => {
    const cred = {
      kind: 'oauth' as const,
      issuer: 'ollama-cloud' as const,
      accessToken: pair.privateKeyPem,
      refreshToken: pair.publicKeyLine,
      expiresAt: null,
      accountId: 'alice'
    }
    const bound = vi.fn(async () => jsonResponse({ Name: 'alice', Plan: 'pro' })) as unknown as typeof globalThis.fetch
    const id = await OLLAMA_CLOUD_OAUTH.refresh!(cred, ctxWith(bound))
    expect(id).toMatchObject({ accessToken: pair.privateKeyPem, accountId: 'alice', planType: 'pro' })

    const unbound = vi.fn(async () => jsonResponse({ Name: '' })) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.refresh!(cred, ctxWith(unbound))).resolves.toBeNull()

    // 网络抖动 → 抛错(refresh 调用方按可重试故障处理,不登出)
    const flaky = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    await expect(OLLAMA_CLOUD_OAUTH.refresh!(cred, ctxWith(flaky))).rejects.toThrow()
  })

  it('★★★ transport.signRequest:头是签名不是 Bearer,query 带 ts,静态头为零', () => {
    const t = OLLAMA_CLOUD_OAUTH.transport(
      {
        kind: 'oauth',
        issuer: 'ollama-cloud',
        accessToken: pair.privateKeyPem,
        refreshToken: pair.publicKeyLine,
        expiresAt: null,
        accountId: 'alice'
      },
      { sessionId: 's' }
    )
    expect(t.headers).toEqual({})
    const signed = t.signRequest!({ method: 'POST', path: '/v1/chat/completions' })
    expect(signed.query?.['ts']).toMatch(/^\d{10}$/u)
    expect(signed.headers['authorization']).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u)
    // 签名头绝不可能是凭证槽原文 —— 那意味着把私钥 PEM 发了出去
    expect(signed.headers['authorization']).not.toContain('OPENSSH PRIVATE KEY')
  })
})
