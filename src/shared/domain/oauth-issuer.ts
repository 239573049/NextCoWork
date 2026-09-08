/**
 * OAuth 授权服务器的身份 —— **一个纯类型,单独一个文件。**
 *
 * ★ 它必须在 `src/shared/` 里,因为两边都要用:`presets.ts` 的 `oauthIssuer`
 * 字段(渲染层要靠它决定画登录按钮还是画密钥输入框)和 `credential.ts` 的
 * `OAuthCredential.issuer`(主进程要靠它查规格表)。而 `src/shared/` **不能**
 * 反向 import `src/main/`。
 *
 * ★★ 但**规格本身(client_id / 端点 / scope / 回调策略)不在这里**,在
 * `src/main/kernel/oauth/registry.ts`。那些是主进程事实:放进 shared 等于邀请
 * 渲染层去 import 它们,而渲染层碰不得这条流程的任何一半 —— 授权 URL 带着
 * 我们自己生成的 state,从渲染层过一遍手就等于把 CSRF 防线交给了它。
 *
 * ★ 加一家(Claude Code 的 Anthropic、Gemini CLI 的 Google …)只需要在这个
 * 联合里加一个值 —— 然后所有 switch 会在编译期告诉你还差哪里没写。
 */
export type OAuthIssuerId = 'chatgpt'

export const OAUTH_ISSUER_IDS: readonly OAuthIssuerId[] = ['chatgpt']
