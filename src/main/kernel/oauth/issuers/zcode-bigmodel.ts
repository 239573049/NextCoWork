/**
 * 智谱(BigModel)渠道。
 *
 * ============================ 证据等级 ============================
 * 授权入口这一段是 **2026-09-09 从真实登录里抓到的**(用户提供),不是逆向文档的推测:
 *
 * ```
 * 发起:https://bigmodel.cn/login
 *        ?appId=zcode
 *        &redirect=https%3A%2F%2Fzcode.z.ai%2Fapp%2Foauth%2Flogin
 *                  %3Fredirect%3Dzcode%253A%252F%252Foauth%252Fcallback%26app_version%3D3.10.2
 *        &state=f83eff5e05300158e38b32eff504fc35
 * 回来:zcode://oauth/callback?authCode=FaYz_7QT6UA-…&state=f83eff5e05300158e38b32eff504fc35
 * ```
 *
 * 这组数据推翻了按逆向文档写法的两处:
 * 1. **参数不是标准 OAuth 那一套**。没有 `response_type` / `client_id` / `redirect_uri`,
 *    而是 `appId` / `redirect` / `state`;`redirect` 还是**套了两层**的:先跳
 *    `zcode.z.ai/app/oauth/login` 这个中转页,由它再跳回 `zcode://oauth/callback`。
 * 2. **回调里的授权码参数名是 `authCode`,不是 `code`**。按 `code` 取的表现是一句
 *    「这段内容里没有授权码」—— 而用户手里明明有一条带着授权码的回调地址。
 *
 * ============================ 仍然未知的部分 ============================
 * **换码那一跳没有被抓到过。** 这里沿用逆向文档的写法(打 `zcode.z.ai` 的 token
 * 端点、`provider: 'zcode'`),而我 2026-09-09 拿一个无效 code 探到的是
 * `{"code":1000,"msg":"something went wrong"}`(同样的请求带 `provider:"zai"` 返回
 * `{"code":2007,"msg":"http error"}`,即「走到了换码那一步」)。说明**服务端确有这条
 * 分支,但它要的东西和 zai 那条不同** —— 也可能只是因为我那个 code 是编的。
 *
 * `redirect_uri` 这一跳该发什么同样未知:授权阶段真正出现的是那个**中转地址**,
 * 而不是 `zcode://oauth/callback` 本身。这里发的是后者(`manual-paste` 的 redirectUri)。
 * 换不到 token 时,这是第一个该试的变量。
 *
 * **第三跳(换业务令牌)的端点也未知**,所以省略了 `businessLoginUrl` —— 即
 * 「拿 ② 的 access_token 直接当 API key」。逆向报告里 BigModel 的 AI 端点
 * (`open.bigmodel.cn/api/anthropic`)吃的确实是 `x-api-key`,但那说的是用户自己
 * 填的那把 key。
 *
 * ============================ 交互上的坑 ============================
 * 回调是 `zcode://` 自定义协议。注册系统级协议处理器
 * (`app.setAsDefaultProtocolClient`)**本计划不做** —— 那会影响没装 ZCode 的用户。
 * 所以走手动粘贴:用户在浏览器里授权完,把地址栏里那条
 * `zcode://oauth/callback?authCode=…&state=…` 整条复制回来。
 *
 * ★★ **做不通时的修法是改这个文件里的数据,不是改流程代码。** 流程那边
 * (`zcode.ts` / `flow.ts` / `registry.ts`)已经为这条链路撑开过两次;再为它加分支
 * 只会把已经验证过的 Z.AI 那条也搅浑。拿到实测结果后,把结论连同日期写进这段注释。
 */
import { createZcodeSpec, ZCODE_APP_VERSION } from './zcode'
import type { OAuthProviderSpec } from '../registry'

/** ★ 实测抓到的值,字面量就是 `zcode`(不是 Z.AI 那种 `client_…` 形状) */
const APP_ID = 'zcode'

/** ★ ZCode 自己注册的自定义协议回调。我们不注册协议,只把它原样发出去 */
const REDIRECT_URI = 'zcode://oauth/callback'

/**
 * 中转页 —— **`redirect` 参数里装的是它,不是最终那个 `zcode://` 地址。**
 *
 * ★ 这一层不能省。`bigmodel.cn/login` 授权完是往这个 https 地址跳的,由它再跳回
 * 自定义协议;直接把 `zcode://…` 塞进 `redirect` 等于要求一个网页登录流程
 * 直接吐出自定义协议,多半会被拒或者干脆卡住,而那时没有任何错误信息。
 */
function bounceUrl(): string {
  const u = new URL('https://zcode.z.ai/app/oauth/login')
  u.searchParams.set('redirect', REDIRECT_URI)
  u.searchParams.set('app_version', ZCODE_APP_VERSION)
  return u.toString()
}

export const ZCODE_BIGMODEL_OAUTH: OAuthProviderSpec = createZcodeSpec({
  id: 'zcode-bigmodel',
  label: '智谱 BigModel',
  authorizeUrl: 'https://bigmodel.cn/login',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  provider: 'zcode',
  tokenKey: 'zcode',
  clientId: APP_ID,
  redirect: { kind: 'manual-paste', redirectUri: REDIRECT_URI },
  userinfoUrl: 'https://zcode.z.ai/api/oauth/userinfo',
  /*
    ★★ 标准那三个参数(`response_type` / `client_id` / `redirect_uri`)一个都不发 ——
    这是抓到的真实链接的形状。多发不是「无害的冗余」:这是一个登录页而不是授权端点,
    它拿不认识的参数怎么办完全未知。
  */
  authorizeParams: (args) => ({
    appId: args.clientId,
    redirect: bounceUrl(),
    state: args.state
  }),
  callbackCodeParam: 'authCode'
})
