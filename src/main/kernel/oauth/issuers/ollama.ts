/**
 * Ollama Cloud —— **密钥绑定 + 逐请求签名**(官方 `ollama signin` 同款,不是传统 OAuth)。
 *
 * ============================ 证据等级 ============================
 * 2026-09-15 逆向 Ollama v0.34.0(本机 /Applications/Ollama.app 捆绑的 Go 二进制
 * + 同版本开源仓库交叉验证),并**直连实测**过关键两步:
 * - 签名格式:`Authorization: <base64std(SSH公钥blob)>:<base64std(ed25519裸签名)>`,
 *   challenge = `"METHOD,path?ts=<unix秒>"`,且 `ts` 必须同时出现在 URL query 里。
 *   (源码:`auth/auth.go` 的 `Sign` —— 公钥取自 `MarshalAuthorizedKey` 的第二段,
 *   签名取 `.Blob`(ed25519 就是裸 64 字节,不含 SSH wire 外壳)。)
 * - 绑定判定:`POST /api/me`(签名)对**未绑定**的合法签名返回 **200 + 全零值**
   用户对象(`Name:""`),CLI 据此继续转圈(`cmd/tui/signin.go` 的 `checkSignIn`);
 *   绑定后返回真实用户名。本机探针两种状态都复现过。
 * - 绑定页:`https://ollama.com/connect?name=<hostname>&key=<base64url(完整公钥行)>`
 *   (源码:`server/routes.go` 的 `signinURL`)。
 * - 密钥文件:`~/.ollama/id_ed25519`(OpenSSH 格式,**无口令**)+ `.pub`。
 *   ★ 我们**复用同一个文件** —— 官方 CLI 按「文件存在即用」处理,于是用户在
 *   官方 CLI 里 `ollama signin` 绑过一次,这边登录瞬时完成;反之亦然。
 *
 * ============================ 与其他家的本质差异 ============================
 * 全程**没有 token**:浏览器里绑定的是公钥,之后每个请求都现场签名 —— 等价物是
 * SSH 免密登录,而不是 OAuth 的「换一把令牌存起来」。所以:
 * - 凭证的 `accessToken` 槽装 **SSH 私钥 PEM**、`refreshToken` 槽装**公钥行**
 *   (`parseCredential` 两槽都要求非空;真正被用来发请求的只有前者);
 * - `expiresAt: null` —— 签名不过期,绑定被解除才算失效(`refresh` 里查一次
 *   whoami,解绑 → null → 登出);
 * - 鉴权头只能**逐请求**计算 → `UpstreamTransport.signRequest`(transport.ts)。
 *
 * ★★ 登录完成前有一个**可用性探针**:ollama 的 `/api/*` 认签名是逆向确认过的,
 * 但本应用打的是 `/v1`(OpenAI/Anthropic 兼容网关)—— 它认不认签名当时**没有**
 * 绑定的密钥无法验证(未绑定时所有端点一律 401)。于是登录最后一步拿一个
 * **不存在的模型名**打一次 `/v1/chat/completions`(零额度消耗):非 401
 * (= 鉴权已过、死在模型名上)才算登录成功;401 则把「这家网关只认 API Key」
 * 当场说清楚,而不是让第一条消息去撞墙。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as ed25519Sign,
  type KeyObject
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '../../../../shared/domain/credential'
import type { TransportContext, UpstreamTransport } from '../../upstream/transport'
import { OAuthFailedError } from '../errors'
import type {
  OAuthExchangeContext,
  OAuthIdentity,
  OAuthKeyPair,
  OAuthProviderSpec
} from '../registry'
import { record, str } from './shared'

const OLLAMA_BASE = 'https://ollama.com'
const WHOAMI_PATH = '/api/me'
/** 探针打的就是将来真请求会打的路径 —— 探过的才是验过的 */
const VERIFY_PATH = '/v1/chat/completions'
/** 探针用的模型名:故意不存在,让请求死在「模型」而不是「鉴权」上 */
const PROBE_MODEL = '__nextcowork_auth_probe__'

/** OpenSSH 私钥段里 ed25519 的「私钥」= seed(32) ‖ pub(32),PKCS8 只要 seed */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/* ============================ OpenSSH 密钥格式 ============================ */

/** SSH wire 格式的 string:4 字节大端长度 + 内容 */
function wireString(value: Buffer | string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length)
  return Buffer.concat([len, buf])
}

function wireUint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}

function pemWrap(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/**
 * 纯生成(不碰文件)—— 单独导出是为了测试能只测格式,不写用户家目录。
 *
 * ★ 格式对齐 `ssh-keygen -t ed25519` 的产物:openssh-key-v1、cipher/kdf 均为
 * `none`、单个 key、私钥段 checkint×2(相同随机数,解密侧的自检手段)。
 */
export function generateKeyPair(comment = 'nextcowork'): OAuthKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // JWK 的 d 就是 32 字节 seed;SPKI 的尾巴就是 32 字节公钥
  const seed = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url')
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)

  const pubBlob = Buffer.concat([wireString('ssh-ed25519'), wireString(pubRaw)])
  const check = randomBytes(4)
  const privSection = Buffer.concat([
    check,
    check,
    wireString('ssh-ed25519'),
    wireString(pubRaw),
    wireString(Buffer.concat([seed, pubRaw])),
    wireString(comment)
  ])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    wireString('none'),
    wireString('none'),
    wireString(''),
    wireUint32(1),
    wireString(pubBlob),
    wireString(privSection)
  ])
  return {
    privateKeyPem: pemWrap(body),
    publicKeyLine: `ssh-ed25519 ${pubBlob.toString('base64')}`
  }
}

/**
 * 解析无口令的 OpenSSH ed25519 私钥,返回 seed。
 *
 * ★★ 只支持 `cipher=none / kdf=none` —— 官方 CLI 生成的就是这种;带口令的文件
 * 在官方工具那边也只在签名时弹口令,而我们的使用场景(服务进程)根本无处弹。
 * 报错信息里说清楚「不支持加密私钥」,而不是让解析在半路抛一个没人懂的错。
 */
export function parseOpenSSHEd25519(pem: string): { seed: Buffer } {
  const lines = pem.trim().split('\n')
  if (lines[0] !== '-----BEGIN OPENSSH PRIVATE KEY-----') {
    throw new Error('不是 OpenSSH 格式的私钥')
  }
  const b64 = lines
    .slice(1)
    .filter((line) => !line.startsWith('-----'))
    .join('')
  const body = Buffer.from(b64, 'base64')

  const MAGIC = 'openssh-key-v1\0'
  if (!body.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) {
    throw new Error('私钥缺少 openssh-key-v1 头')
  }
  let p = MAGIC.length
  const readString = (): Buffer => {
    const len = body.readUInt32BE(p)
    p += 4
    const buf = body.subarray(p, p + len)
    p += len
    return buf
  }
  const cipher = readString().toString('utf8')
  const kdf = readString().toString('utf8')
  readString() // kdfoptions
  const nkeys = body.readUInt32BE(p)
  p += 4
  readString() // 公钥段(seed 里能重新导出,跳过)
  const priv = readString()
  if (cipher !== 'none' || kdf !== 'none') {
    throw new Error('不支持带口令的加密私钥(官方 ollama 生成的密钥没有口令)')
  }
  if (nkeys !== 1) throw new Error('私钥文件里应有且仅有一把密钥')

  let q = 0
  q += 8 // checkint ×2(自检用,签名不需要)
  const algoLen = priv.readUInt32BE(q)
  q += 4 + algoLen
  const pubLen = priv.readUInt32BE(q)
  q += 4 + pubLen
  /*
   * ★★ OpenSSH 的 ed25519「私钥」字段是 **64 字节 = seed(32) ‖ 公钥(32)**,
   * 不是裸 seed(RFC 8032 的私钥只取前 32 字节)。整段当 seed 用会把公钥尾巴
   * 也卷进去,签出来的名对不上公钥,服务端回一个不解释的 401。
   */
  const privLen = priv.readUInt32BE(q)
  q += 4
  if (privLen !== 64 || pubLen !== 32) throw new Error('不是 ed25519 密钥')
  return { seed: priv.subarray(q, q + 32) }
}

/* ============================ 签名 ============================ */

/** 同一把私钥在本进程里只解析一次 —— 逐请求签名不该每次都付解析的钱 */
const keyObjectCache = new Map<string, KeyObject>()

function privateKeyObjectOf(privateKeyPem: string): KeyObject {
  const cached = keyObjectCache.get(privateKeyPem)
  if (cached !== undefined) return cached
  const { seed } = parseOpenSSHEd25519(privateKeyPem)
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  keyObjectCache.set(privateKeyPem, key)
  return key
}

/**
 * 官方 `auth.Sign` 的逐字复刻:公钥部分取公钥行的第二段(base64std 的 SSH wire
 * blob),签名部分是 ed25519 裸签名的 base64std —— 不是 SSH wire 签名格式。
 */
export function signAuthorization(
  privateKeyPem: string,
  publicKeyLine: string,
  challenge: string,
  now: () => number = Date.now
): { authorization: string; ts: string } {
  const pubB64 = publicKeyLine.trim().split(' ')[1]
  if (pubB64 === undefined || pubB64 === '') throw new Error('公钥行格式不对,取不到 blob 段')
  const ts = Math.floor(now() / 1000).toString()
  const signature = ed25519Sign(null, Buffer.from(challenge, 'utf8'), privateKeyObjectOf(privateKeyPem))
  return { authorization: `${pubB64}:${signature.toString('base64')}`, ts }
}

/** 对一个(方法, 路径)发签名请求的全部材料:头 + 必须写进 URL 的 ts */
function signedRequest(
  key: OAuthKeyPair,
  method: string,
  path: string,
  now: () => number
): { url: string; headers: Record<string, string> } {
  const ts = Math.floor(now() / 1000).toString()
  const { authorization } = signAuthorization(
    key.privateKeyPem,
    key.publicKeyLine,
    `${method},${path}?ts=${ts}`,
    now
  )
  return {
    url: `${OLLAMA_BASE}${path}?ts=${ts}`,
    headers: {
      authorization,
      'content-type': 'application/json',
      accept: 'application/json'
    }
  }
}

/* ============================ 密钥文件(读写都在 ~/.ollama) ============================ */

/**
 * 读或生成 `~/.ollama/id_ed25519`。
 *
 * ★★ **复用官方 CLI 的文件**(而不是自己另放一处):绑定跟着公钥走,同一个文件
 * 意味着官方 CLI 绑过 = 这边已登录、这边绑过 = 官方 CLI 已登录。官方工具对
 * 这个文件的态度就是「存在即用」,不会因为多一个使用者而冲突。
 * ★ `.pub` 不读 —— 公钥从私钥 seed 推导,自洽且不依赖伴生文件的新鲜度。
 */
export function loadOrCreateKeypair(homeDir: string = homedir()): OAuthKeyPair {
  const dir = join(homeDir, '.ollama')
  const keyPath = join(dir, 'id_ed25519')
  if (existsSync(keyPath)) {
    const pem = readFileSync(keyPath, 'utf8')
    const { seed } = parseOpenSSHEd25519(pem)
    const pubRaw = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8'
      })
    )
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
    const pubBlob = Buffer.concat([wireString('ssh-ed25519'), wireString(pubRaw)])
    return { privateKeyPem: pem, publicKeyLine: `ssh-ed25519 ${pubBlob.toString('base64')}` }
  }

  const pair = generateKeyPair()
  mkdirSync(dir, { recursive: true })
  writeFileSync(keyPath, pair.privateKeyPem, { mode: 0o600 })
  writeFileSync(join(dir, 'id_ed25519.pub'), `${pair.publicKeyLine}\n`, { mode: 0o644 })
  return pair
}

/** 官方 `signinURL` 同款:hostname + base64url(完整公钥行) */
export function connectUrl(publicKeyLine: string, deviceName: string = hostname()): string {
  const encKey = Buffer.from(publicKeyLine, 'utf8').toString('base64url')
  return `${OLLAMA_BASE}/connect?name=${encodeURIComponent(deviceName)}&key=${encKey}`
}

/* ============================ 绑定轮询 / 探针 / 刷新 ============================ */

interface OllamaUser {
  name: string
  email?: string
  plan?: string
}

/**
 * 查一次绑定状态。
 *
 * ★★ 三种结局分清楚,调用方按语义消费:
 * - **抛错** = 网络故障(`refresh` 让它继续抛 → 按可重试故障处理,不动库);
 * - `null` = 未绑定/签名被拒(200 全零值是官方语义,401 视同);
 * - 对象 = 已绑定。
 */
async function whoami(
  key: OAuthKeyPair,
  ctx: OAuthExchangeContext,
  now: () => number = Date.now
): Promise<OllamaUser | null> {
  const req = signedRequest(key, 'POST', WHOAMI_PATH, now)
  const res = await ctx.fetch(req.url, { method: 'POST', headers: req.headers, signal: ctx.signal })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`查询 ollama 绑定状态失败（HTTP ${res.status}）`)
  const user = record(await res.json().catch(() => undefined))
  const name = str(user?.['Name'])
  return name === undefined ? null : { name, email: str(user?.['Email']), plan: str(user?.['Plan']) }
}

/** 登录流程里的轮询钩子:任何抖动都归「还没绑好」,上限是流程超时 */
async function pollBound(key: OAuthKeyPair, ctx: OAuthExchangeContext): Promise<string | null> {
  try {
    return (await whoami(key, ctx))?.name ?? null
  } catch {
    return null
  }
}

/**
 * ★★ 登录收尾的可用性探针 —— 见文件头。401 = `/v1` 网关不认签名,当场说清楚;
 * 其他任何结局(400/404 的「模型不存在」、甚至 5xx)都证明请求**穿过了鉴权层**。
 */
async function verifyGateway(key: OAuthKeyPair, ctx: OAuthExchangeContext): Promise<void> {
  const req = signedRequest(key, 'POST', VERIFY_PATH, Date.now)
  const res = await ctx.fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1 }),
    signal: ctx.signal
  })
  if (res.status !== 401) return
  // 读掉 body 再抛,别把连接吊着
  await res.text().catch(() => '')
  throw new OAuthFailedError(
    '已绑定成功，但 ollama.com 的 OpenAI/Anthropic 兼容网关不接受签名鉴权（只认 API Key）。' +
      '请继续使用下方的 API Key 方式，或在本地 Ollama 上跑云模型（模型名带 -cloud 后缀）。'
  )
}

/** 轮询/刷新都要从凭证两槽还原出密钥对 */
function keyPairOf(cred: Pick<OAuthCredential, 'accessToken' | 'refreshToken'>): OAuthKeyPair {
  return { privateKeyPem: cred.accessToken, publicKeyLine: cred.refreshToken }
}

/* ============================ spec ============================ */

/**
 * 密钥绑定流程交给 `identity()` 的中间形态(flow 不解包,原样透传):
 * `{username, privateKeyPem, publicKeyLine, email?}`。
 */
export const OLLAMA_CLOUD_OAUTH: OAuthProviderSpec = {
  id: 'ollama-cloud',
  label: 'Ollama Cloud',
  /*
     这两个字段在这条 grant 上没有对应物(没有 token 端点、没有 client 概念),
     但类型必填 —— 填官方域名的占位值并在此声明,免得后人以为它们被谁读过。
  */
  tokenUrl: OLLAMA_BASE,
  clientId: 'ollama',
  grant: { kind: 'keypair-binding' },
  pkce: false,

  identity: (json, _now): OAuthIdentity | null => {
    const b = record(json)
    if (b === undefined) return null
    const username = str(b['username'])
    const privateKeyPem = str(b['privateKeyPem'])
    const publicKeyLine = str(b['publicKeyLine'])
    const email = str(b['email'])
    if (username === undefined || privateKeyPem === undefined || publicKeyLine === undefined) {
      return null
    }
    return {
      /*
        ★★ 两槽的语义(见文件头):`accessToken` = 私钥(逐请求签名的原料),
        `refreshToken` = 公钥行(Authorization 头的前半段)。都不是字面意义的 token。
      */
      accessToken: privateKeyPem,
      refreshToken: publicKeyLine,
      expiresAt: null,
      accountId: username,
      ...(email === undefined ? {} : { email })
    }
  },

  keypairBinding: {
    loadOrCreate: async (): Promise<OAuthKeyPair> => loadOrCreateKeypair(),
    connectUrl: (publicKeyLine: string): string => connectUrl(publicKeyLine),
    poll: pollBound,
    verify: verifyGateway
  },

  /*
    ★★ 刷新 = 查一次绑定还在不在。签名不过期,「失效」只有一种形态:绑定被解除
    (用户在 ollama.com 删了这台设备)。still bound → 原样返回;unbound → null
    → `CredentialResolver.markReauth` 登出;网络抖动 → 抛错走可重试路径,不登出。
  */
  refresh: async (cred, ctx): Promise<OAuthIdentity | null> => {
    const user = await whoami(keyPairOf(cred), ctx)
    if (user === null) return null
    return {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: null,
      accountId: user.name,
      ...(cred.email === undefined ? {} : { email: cred.email }),
      ...(user.plan === undefined ? {} : { planType: user.plan })
    }
  },

  /*
    ★ 静态头一个都不写 —— 鉴权头随 method+path+ts 变,由 `signRequest` 逐请求现算
    (router.ts 的 send 里调用)。这里若再写一个静态 authorization,只会被签名头
    覆盖或制造第二个真相来源。
  */
  transport: (cred: OAuthCredential, _ctx: TransportContext): UpstreamTransport => ({
    headers: {},
    body: (body) => body,
    signRequest: ({ method, path }) => {
      const { authorization, ts } = signAuthorization(
        cred.accessToken,
        cred.refreshToken,
        `${method},${path}?ts=${Math.floor(Date.now() / 1000)}`
      )
      return { query: { ts }, headers: { authorization } }
    }
  })
}
