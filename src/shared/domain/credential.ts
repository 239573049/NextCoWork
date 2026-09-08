/**
 * 供应商凭证 —— **同一个槽里可能是一把 API Key,也可能是一组 OAuth token。**
 *
 * ★★ **为什么不给 OAuth 单开一个 credentialRef 前缀。**
 * `provider:<id>` 这一个 ref 被五处代码当成「这家供应商的凭证」这**一个**事实:
 * `upsertProvider` 派生它、`removeProvider` 删它、`storage.ts` 的 `credentialRefs()` /
 * `credentialImportPlan()` / `snapshotCredentialRollback` 三处按它导出导入和回滚。
 * 加第二个前缀意味着这五处**每一处**都要变成「两条 ref」,而漏掉任何一处的表现
 * 都是静默的:删供应商留下孤儿 token、导出漏掉登录态、导入回滚只回滚一半。
 * 一个槽一个 ref,那五处一行不用改。
 *
 * ★ `secrets` 的接口(`kernel/host.ts`)仍然是**字符串**契约,这里只是约定了
 * 那个字符串的两种形状。safeStorage 加密的是什么它并不关心。
 */
import type { OAuthIssuerId } from './oauth-issuer'

export type { OAuthIssuerId }

/** 用户手工粘进来的那把 key。**全部历史记录都是这一种。** */
export interface ApiKeyCredential {
  kind: 'api-key'
  apiKey: string
}

export interface OAuthCredential {
  kind: 'oauth'
  /**
   * ★ 刷新和发请求时靠它查规格表(`main/kernel/oauth/registry.ts`),
   * 而不是靠 provider.id 猜 —— 用户改过名字、换过地址,凭证照样自解释。
   */
  issuer: OAuthIssuerId
  accessToken: string
  refreshToken: string
  /**
   * ★ **绝对毫秒时间戳,不存 `expires_in`。**
   * 相对值一旦落盘就开始腐烂:重启后没人知道那 3600 秒是从哪一刻算起的。
   */
  expiresAt: number
  /** 各家 API 要求带的账号标识(ChatGPT 是 `chatgpt-account-id` 头的值) */
  accountId: string
  /** 只给设置页显示用。缺失不影响请求能不能发出去 */
  email?: string
  planType?: string
  /**
   * 刷新时被上游**明确拒绝**过(`invalid_grant`)。界面据此显示「请重新登录」。
   * ★ 网络失败不置这个位 —— 见 `credential-resolver.ts` 的失败分类。
   */
  needsReauth?: boolean
  refreshedAt?: number
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential

function isIssuer(value: unknown): value is OAuthIssuerId {
  return value === 'chatgpt'
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析存在 `credentials` 表里的那个字符串。
 *
 * ★★ **判据是「能不能解成一个带已知 kind 的对象」,而不是一个版本号字段。**
 * 版本号要写迁移,而迁移要在所有安装上跑对一次;这条判据不用动任何历史数据。
 *
 * ★★ **解析失败一律退回「当作裸 API key」,绝不抛。**
 * 一把恰好以 `{` 开头的 key 如果在这里抛异常,用户看到的是「还没有配置密钥」——
 * 而他明明配过。那是一次**无法自查**的假故障:设置页显示已配置,请求说没配置。
 * 退回去最多是拿一把畸形的 key 去换一个 401,而 401 至少指向真正的问题。
 */
export function parseCredential(raw: string | null | undefined): ProviderCredential | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (!raw.startsWith('{')) return { kind: 'api-key', apiKey: raw }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'api-key', apiKey: raw }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'api-key', apiKey: raw }
  }

  const o = parsed as Record<string, unknown>
  if (o['kind'] === 'api-key') {
    const key = str(o['apiKey'])
    return key === undefined ? null : { kind: 'api-key', apiKey: key }
  }
  if (o['kind'] !== 'oauth') return { kind: 'api-key', apiKey: raw }

  // OAuth 记录缺了任何一个必需字段都发不出请求。退回当 API key 会拿整个 JSON
  // 去做 Bearer token —— 那个 401 比「没配置」更难看懂,所以这里判「没配置」
  const issuer = o['issuer']
  const accessToken = str(o['accessToken'])
  const refreshToken = str(o['refreshToken'])
  const accountId = str(o['accountId'])
  const expiresAt = o['expiresAt']
  if (
    !isIssuer(issuer) ||
    accessToken === undefined ||
    refreshToken === undefined ||
    accountId === undefined ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null
  }

  const email = str(o['email'])
  const planType = str(o['planType'])
  const refreshedAt = typeof o['refreshedAt'] === 'number' ? o['refreshedAt'] : undefined
  return {
    kind: 'oauth',
    issuer,
    accessToken,
    refreshToken,
    expiresAt,
    accountId,
    ...(email === undefined ? {} : { email }),
    ...(planType === undefined ? {} : { planType }),
    ...(o['needsReauth'] === true ? { needsReauth: true as const } : {}),
    ...(refreshedAt === undefined ? {} : { refreshedAt })
  }
}

/**
 * ★★ **API Key 回吐的是裸字符串,不是 JSON。** 这条是降级兼容的守门线:
 * 用户退回旧版本时,库里那把 key 照样能用。反过来,如果我们把已有的 key
 * 重写成 `{"kind":"api-key",...}`,旧版本会把**整个 JSON** 当 Bearer token
 * 发出去 —— 401,且没有任何线索指向「是新版本改了存储格式」。
 */
export function serializeCredential(cred: ProviderCredential): string {
  return cred.kind === 'api-key' ? cred.apiKey : JSON.stringify(cred)
}

/** 发请求时真正塞进鉴权头的那个串。两种凭证在这一点上是同构的 */
export function bearerOf(cred: ProviderCredential): string {
  return cred.kind === 'api-key' ? cred.apiKey : cred.accessToken
}
