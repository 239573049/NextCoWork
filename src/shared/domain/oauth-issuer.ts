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
 * ★ 加一家(Claude Code 的 Anthropic、Gemini CLI 的 Google …)只需要在下面那个
 * 数组里加一个值 —— 然后所有 switch 会在编译期告诉你还差哪里没写。
 *
 * ★★ **类型从数组派生,而不是各写一份。** 反过来写(先声明联合类型、再手抄一份
 * 数组)的话,两者会分叉,而分叉的表现极其难查:`credential.ts` 的 `isIssuer`
 * 照数组判,漏了一个的症状是**登录成功、下一秒显示未登录** —— 凭证明明写进去了,
 * 读回来 `parseCredential` 判残缺返回 null,而界面和错误信息一个字都不提 issuer。
 * 派生之后这种分叉在语法上就不存在了。
 */
export const OAUTH_ISSUER_IDS = ['chatgpt', 'zcode-zai', 'zcode-bigmodel'] as const

export type OAuthIssuerId = (typeof OAUTH_ISSUER_IDS)[number]
