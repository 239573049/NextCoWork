/**
 * 「这家该画登录按钮还是画密钥输入框」+「登录态是四态里的哪一个」——两个纯函数。
 *
 * 抽成 `.ts` 而不是留在 `ProviderPanel.tsx` 里,理由和 `provider-edit.ts` 文件头
 * 写的一样:`vitest.config.ts` 是 node 环境、`include` 只收 `.ts`,
 * 留在 `.tsx` 里写了测试也不会跑。
 */
import type { OAuthIssuerId } from '../../../../../shared/domain/oauth-issuer'
import { findPreset } from '../../../../../shared/domain/presets'
import type { CredentialInfo, UpstreamProtocol, UpstreamProvider } from '../../../../../shared/domain/provider'
import { baseUrlForProtocol } from './provider-edit'

/**
 * 这家该画什么。
 *
 * ★★ `'both'` 不是「两种任选其一」那么轻松 —— `provider:<id>` **只有一个凭证槽**
 * (见 `shared/domain/credential.ts` 的文件头:五处代码把它当成一个事实),
 * 所以两种凭证的真实关系是**后写的覆盖先写的**。界面必须把这句话说出来,
 * 否则用户填了 key 之后发现登录态没了,会以为是我们把他登出了。
 */
export type ProviderAuthMode = 'api-key' | 'oauth' | 'both'

/** 登录流程走到哪一步(和主进程 `provider:authProgress` 的 phase 同一套值) */
export type OAuthPhase = 'opening' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'

export type OAuthView =
  | { state: 'signed-out' }
  /**
   * ★ `needsPaste` 只在 `waiting` 时有意义:这条流程没有回环端口能接回调,
   * 得用户自己把地址栏里那条粘回来。少了它,粘贴形态的登录在界面上是一个
   * **永远转下去的 spinner**,而用户手里正拿着那条回调地址无处可放。
   */
  | { state: 'signing-in'; phase: 'opening' | 'waiting' | 'exchanging'; needsPaste: boolean }
  | { state: 'signed-in'; email: string | null; plan: string | null }
  | { state: 'expired'; email: string | null; reason: 'expired' | 'revoked' }

/**
 * ★★ **判据是预设的 `oauthIssuer`,不是凭证。**
 *
 * 照凭证判的话,一家 OAuth 供应商在**还没登录**时凭证是空的,会被认成
 * API Key 供应商 —— 于是界面画出一个填了也没用的密钥框,而真正的登录入口
 * 一个都没有。那正是用户最需要它的时刻。
 */
export function providerAuthMode(providerId: string): ProviderAuthMode {
  const preset = findPreset(providerId)
  if (preset?.oauthIssuer === undefined) return 'api-key'
  /*
    ★ `credentialKind === 'oauth'` = 这家**根本没有**可粘贴的密钥(拿凭证的方式
    就是登录本身),那才是纯 OAuth。GLM Coding Plan 两家官方既发订阅 key
    也能账号登录,判成纯 OAuth 会把已经在用 key 的用户的输入框拿走。
  */
  return preset.credentialKind === 'oauth' ? 'oauth' : 'both'
}

/**
 * 登录按钮上那个名字。
 *
 * ★★ **这是一个穷尽的 Record,不是 `issuer === 'chatgpt' ? … : ''`。**
 * 原来那个三元在加 issuer 时**一个编译错都不报**,表现是按钮写着
 * 「使用  账号登录」—— 中间空一格,没有任何一处指向 issuer 漏了。
 * 写成 `Record<OAuthIssuerId, string>` 之后,加值不补这里就是编译失败。
 *
 * ★ 名字和 `main/kernel/oauth/registry.ts` 里那些 spec 的 `label` 是同一批字面量,
 * 但**不能**从那边 import:规格表整个留在 main 是有意的(见 registry 文件头),
 * 渲染层碰不得。重复的代价由 `provider-auth.test.ts` 的穷尽性断言兜着。
 */
const ISSUER_LABELS: Readonly<Record<OAuthIssuerId, string>> = {
  chatgpt: 'ChatGPT',
  'zcode-zai': 'Z.AI',
  'zcode-bigmodel': '智谱'
}

export function oauthIssuerLabel(issuer: OAuthIssuerId): string {
  return ISSUER_LABELS[issuer]
}

export function providerOAuthIssuer(providerId: string): OAuthIssuerId | null {
  return findPreset(providerId)?.oauthIssuer ?? null
}

/**
 * 四态。
 *
 * ★ **正在登录时压过一切**:此刻库里那条旧凭证还在(可能是上一个账号、
 * 也可能是一条已失效的),显示它只会让人以为登录已经完成了。
 *
 * ★ `expired` / `needsReauth` **不在这里算**,直接读主进程给的布尔 ——
 * 渲染层不碰时钟,两个进程不是同一个时钟源(见 `CredentialAuthInfo` 的注释)。
 */
export function oauthView(
  info: CredentialInfo | null,
  flow: { phase: OAuthPhase; needsPastedCode?: boolean } | null
): OAuthView {
  if (flow !== null && (flow.phase === 'opening' || flow.phase === 'waiting' || flow.phase === 'exchanging')) {
    return { state: 'signing-in', phase: flow.phase, needsPaste: flow.needsPastedCode === true }
  }

  const auth = info?.auth
  if (auth === undefined) return { state: 'signed-out' }

  const email = auth.email ?? null
  if (auth.needsReauth) return { state: 'expired', email, reason: 'revoked' }
  if (auth.expired) return { state: 'expired', email, reason: 'expired' }
  return { state: 'signed-in', email, plan: auth.planType ?? null }
}

/**
 * 这个槽里现在装的是哪一种凭证。
 *
 * ★★ **`hasKey` 对两种凭证都为真** —— 它的意思是「槽里有东西」,不是「有一把 key」。
 * 直接拿它当「已填密钥」用的话,登录成功之后密钥框会显示一串掩码点,
 * 而那串点背后是一个 JWT;用户会以为自己的 key 还在,点「更换」才发现不对。
 */
export function credentialInUse(info: CredentialInfo | null): 'oauth' | 'api-key' | null {
  if (info === null || !info.hasKey) return null
  return info.auth === undefined ? 'api-key' : 'oauth'
}

/**
 * 登录成功之后要不要把接口地址挪到另一个端点。
 *
 * ★★ **两种凭证打的不是同一个地址。** GLM Coding Plan:订阅 key 走
 * `…/api/coding/paas/v4`(openai-chat),而登录换来的 JWT 走 `…/api/anthropic`。
 * 不挪的话,用户会在「已登录」的界面上发出第一条消息,然后撞上一个
 * **不解释原因**的错误 —— 而表单从头到尾看着都是对的。
 *
 * ★ 复用 `baseUrlForProtocol` 而不是自己拼地址,是为了白拿它那条规则:
 * **用户自己改过地址就一个字都不动**(`provider-edit.ts` 文件头)。
 * 而 `changed === false` 时这里返回 `null` 而不是「只换协议」——
 * 协议换了地址没换,等于拿 anthropic 协议去打 coding 端点,比不换更坏。
 */
export function signInEndpointSwitch(
  provider: Pick<UpstreamProvider, 'id' | 'baseUrl' | 'protocol'>,
  target: UpstreamProtocol = 'anthropic'
): { protocol: UpstreamProtocol; baseUrl: string } | null {
  if (provider.protocol === target) return null
  const r = baseUrlForProtocol(provider, target)
  return r.changed ? { protocol: target, baseUrl: r.baseUrl } : null
}
