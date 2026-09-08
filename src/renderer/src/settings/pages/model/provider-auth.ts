/**
 * 「这家该画登录按钮还是画密钥输入框」+「登录态是四态里的哪一个」——两个纯函数。
 *
 * 抽成 `.ts` 而不是留在 `ProviderPanel.tsx` 里,理由和 `provider-edit.ts` 文件头
 * 写的一样:`vitest.config.ts` 是 node 环境、`include` 只收 `.ts`,
 * 留在 `.tsx` 里写了测试也不会跑。
 */
import type { OAuthIssuerId } from '../../../../../shared/domain/oauth-issuer'
import { findPreset } from '../../../../../shared/domain/presets'
import type { CredentialInfo } from '../../../../../shared/domain/provider'

export type ProviderAuthMode = 'api-key' | 'oauth'

/** 登录流程走到哪一步(和主进程 `provider:authProgress` 的 phase 同一套值) */
export type OAuthPhase = 'opening' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'

export type OAuthView =
  | { state: 'signed-out' }
  | { state: 'signing-in'; phase: 'opening' | 'waiting' | 'exchanging' }
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
  return findPreset(providerId)?.oauthIssuer === undefined ? 'api-key' : 'oauth'
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
  flow: { phase: OAuthPhase } | null
): OAuthView {
  if (flow !== null && (flow.phase === 'opening' || flow.phase === 'waiting' || flow.phase === 'exchanging')) {
    return { state: 'signing-in', phase: flow.phase }
  }

  const auth = info?.auth
  if (auth === undefined) return { state: 'signed-out' }

  const email = auth.email ?? null
  if (auth.needsReauth) return { state: 'expired', email, reason: 'revoked' }
  if (auth.expired) return { state: 'expired', email, reason: 'expired' }
  return { state: 'signed-in', email, plan: auth.planType ?? null }
}
