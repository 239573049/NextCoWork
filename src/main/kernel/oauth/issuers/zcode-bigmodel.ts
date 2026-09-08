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
 * ============================ 交互上的坑(2026-09-09 读中转页源码定案) ============================
 * 回调是 `zcode://` 自定义协议。注册系统级协议处理器
 * (`app.setAsDefaultProtocolClient`)**本计划不做** —— 那会影响没装 ZCode 的用户。
 * 所以走手动粘贴。但「让用户复制那条 `zcode://…` 」这个做法是**行不通**的:自定义协议
 * 会被系统直接交给已装的 ZCode,浏览器地址栏里根本留不下东西给用户复制
 * —— 用户实测反馈:「拿不到返回的 token,因为他固定打开他的软连接程序」。
 *
 * 真正能拿到码的地方是**中转页自己的地址**:`bigmodel.cn` 是往
 * `https://zcode.z.ai/app/oauth/login?…&authCode=…&state=…` 跳的,由那个页面再往
 * `zcode://` 跳。所以要粘的是**中转页那一条 https 地址**,它一直留在地址栏里。
 *
 * 中转页的 JS(`_next/static/chunks/app/app/oauth/login/page-*.js`)读下来,它只做两件事,
 * 而**这两件事都会把我们的 authCode 抢走**,所以下面那个 `BOUNCE_URL` 是精心削光的:
 *
 * 1. 跳 deep link。跳之前会校验 `redirect` 参数:
 *    `if (protocol !== 'zcode:' || hostname !== 'oauth' || pathname !== '/callback') return null`
 *    —— **写死的三段校验**,所以「把 `redirect` 指向我们自己的回环端口来全自动接码」
 *    这条路是死的,不用再试。反过来用:`redirect` 校验不过时它 `return null`,
 *    `window.location.assign` 那一句就不执行,**ZCode 不会被拉起,码也就不会被它换掉**。
 *    我们干脆一个 `redirect` 都不传(`if(!e.redirect) return null`,同一个分支)。
 * 2. 打自己的「CLI 桥」:`GET /api/v1/oauth/cli/callback/bigmodel?authCode=…&state=…`
 *    (探过,活的:假码返回一张 `<title>Authorization Failed / 授权失败</title>` 的页面)。
 *    这一步只在 `app_version > 3.9.1` 时才做(源码里 `f=[3,9,1]` 的版本比较)。
 *    服务端会不会把码标记成已用未知,**不赌** —— 所以 `app_version` 也不传,
 *    版本号正则匹配不上 → 桥关闭。
 *
 * 削光之后页面会显示「无法打开 ZCode / 登录回调地址无效,请重新从 ZCode 桌面端发起登录」。
 * ★ **这句话是预期结果,不是故障** —— 它恰恰说明 deep link 没跳、码还是我们的。
 * 地址栏里那条 `https://zcode.z.ai/app/oauth/login?authCode=…&state=…` 就是要粘的东西,
 * `pastedCallbackCode` 认 `authCode` 参数,不关心主机名和协议。
 *
 * ★★ **做不通时的修法是改这个文件里的数据,不是改流程代码。** 流程那边
 * (`zcode.ts` / `flow.ts` / `registry.ts`)已经为这条链路撑开过两次;再为它加分支
 * 只会把已经验证过的 Z.AI 那条也搅浑。拿到实测结果后,把结论连同日期写进这段注释。
 */
import { createZcodeSpec } from './zcode'
import type { OAuthProviderSpec } from '../registry'

/** ★ 实测抓到的值,字面量就是 `zcode`(不是 Z.AI 那种 `client_…` 形状) */
const APP_ID = 'zcode'

/**
 * ★ ZCode 自己注册的自定义协议回调。我们不注册协议。
 *
 * 削光 `BOUNCE_URL` 之后,这个值**只在换码那一跳当 `redirect_uri` 发出去**,
 * 授权 URL 里一个字都不出现了(出现就等于请系统把码交给已装的 ZCode)。
 */
const REDIRECT_URI = 'zcode://oauth/callback'

/**
 * 中转页 —— **`redirect` 参数里装的是它,不是最终那个 `zcode://` 地址。**
 *
 * ★ 这一层不能省:`bigmodel.cn/login` 授权完是往这个 https 地址跳的,由它把
 * `authCode` / `state` 拼在自己的地址栏上。这条地址就是用户要复制的东西。
 *
 * ★★ **一个 query 参数都不带,是故意的。** ZCode 自己发的是
 * `?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.10.2`,那两个参数会让中转页
 * 分别去拉起 ZCode、去打它自己的 CLI 桥 —— 两条都会把我们刚拿到的 authCode 抢走。
 * 削光之后页面显示「登录回调地址无效」,**那正是我们要的状态**。
 * 完整推导见文件头「交互上的坑」。
 */
const BOUNCE_URL = 'https://zcode.z.ai/app/oauth/login'

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
    redirect: BOUNCE_URL,
    state: args.state
  }),
  callbackCodeParam: 'authCode'
})
