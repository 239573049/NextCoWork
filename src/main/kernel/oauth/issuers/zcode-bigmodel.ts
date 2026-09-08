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
 * **换码那一跳的响应体没有被抓到过**,但它的请求形状 2026-09-09 已经用错误码分层
 * 定下来了(见下面 `provider` 字段那段注释):端点、body 形状、`provider: 'bigmodel'`
 * 都能让服务端走到「验码」那一步。剩下未知的只有**成功响应长什么样**。
 *
 * `redirect_uri` 这一跳该发什么同样未知。这里发的是我们自己那个回环地址 ——
 * 好处是它和授权请求里的 `redirect` **逐字相同**,符合 OAuth 对这两处的一般要求。
 * 但 ZCode 桌面端发的多半是 `zcode://oauth/callback` 字面量,如果服务端比的是
 * 「注册值」而不是「本次授权用的值」,那就得改发它。**换不到 token 时这是第一个
 * 该试的变量**:给 `createZcodeSpec` 传一个固定的 `redirect_uri` 即可,不要动流程。
 *
 * **第三跳(换业务令牌)的端点也未知**,所以省略了 `businessLoginUrl` —— 即
 * 「拿 ② 的 access_token 直接当 API key」。逆向报告里 BigModel 的 AI 端点
 * (`open.bigmodel.cn/api/anthropic`)吃的确实是 `x-api-key`,但那说的是用户自己
 * 填的那把 key。
 *
 * ============================ 回调策略(2026-09-09 读双方前端源码定案) ============================
 * ZCode 桌面端的回调是 `zcode://oauth/callback` 这个自定义协议,而**我们不注册协议**
 * (`app.setAsDefaultProtocolClient` 会影响没装 ZCode 的用户)。照抄它的参数会得到一个
 * 死局:系统把回调直接交给已装的 ZCode,浏览器地址栏里留不下任何东西
 * —— 用户实测:「拿不到返回的 token,因为他固定打开他的软连接程序」。
 *
 * 于是去读了链路两头的前端代码,发现**根本不必照抄**:
 *
 * ① `bigmodel.cn/login` 对 `redirect` **没有白名单**。整个校验就一条 XSS 黑名单
 *    (`static.bigmodel.cn/wd-paas-front/js/app.*.js`):
 *
 *    ```js
 *    s = /^(javascript|data|vbscript):/i
 *    function u(e, {authCode, error, state}) {
 *      if (!e) return ''
 *      var o = decodeURIComponent(e)
 *      if (s.test(o.trim())) return ''            // ← 唯一的一道关
 *      return l(o, [['authCode', n], ['state', i]])   // new URL() + searchParams.set
 *    }
 *    // handleOAuthLoginSuccess: r ? window.location.replace(r) : 警告('跳转失败')
 *    ```
 *
 *    登录成功的两条路径(`handleOAuthLoginSuccess` / `jumpBackAccessParty`)都汇到这里。
 *    所以 `redirect` 填我们自己的 `http://127.0.0.1:<临时端口>/callback` 是合法的,
 *    它会原样 `location.replace` 过来,并把 `authCode` / `state` 拼在后面。
 *
 * ② ZCode 的中转页(`zcode.z.ai/app/oauth/login`)**不能用**,而且不只是「多此一举」:
 *    它拿到码之后会主动送走两次 —— 校验 `redirect` 合法就
 *    `window.location.assign('zcode://…')` 把码交给已装的 ZCode;`app_version > 3.9.1`
 *    还会再打一次它自己的 CLI 桥 `GET /api/v1/oauth/cli/callback/bigmodel?authCode=…`。
 *    顺带一提,它那个 `redirect` 校验是写死的三段
 *    (`protocol==='zcode:' && hostname==='oauth' && pathname==='/callback'`),
 *    **指不到我们的回环端口上** —— 这条路试过了,是死的,不用再试。
 *
 * 结论:**绕开中转页,直接走回环。** 全自动,不用粘贴,也没有任何东西来抢这个码。
 * 端口用临时的而不是 ZCode 那个 9999 —— 既然没有白名单就没必要占固定端口,
 * 还能避开用户机器上真在跑的 ZCode。
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
 * ★ 回调路径。端口是临时的,由回环服务器 bind 完才知道,`flow.ts` 会用它回填
 * `redirect_uri` —— 所以这里只写路径。
 */
const CALLBACK_PATH = '/callback'

export const ZCODE_BIGMODEL_OAUTH: OAuthProviderSpec = createZcodeSpec({
  id: 'zcode-bigmodel',
  label: '智谱 BigModel',
  authorizeUrl: 'https://bigmodel.cn/login',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  /*
    ★★★ **`bigmodel`,不是逆向文档写的 `zcode`。** 2026-09-09 用户实测到
    `{"code":1000,"msg":"something went wrong"}`,和我拿**假 code** 探到的一模一样
    —— 说明它压根没走到验码那一步。把 provider 名当变量扫一遍,错误码干净地分成两层:

      zai / bigmodel / ''                          → 2007 `http error`（认识，在验码）
      zcode / zhipu / BigModel / qqqqqq-not-a-…    → 1000 `something went wrong`（不认识）

    独立佐证:ZCode 中转页里那个 CLI 桥的路径段也是
    `/api/v1/oauth/cli/callback/bigmodel`(zai 那条是 `/zai`)。
    `zcode` 是**桌面端的 appId**,和这个字段不是一回事 —— 逆向文档把两者混了。
  */
  provider: 'bigmodel',
  /*
    ★ 响应体没被抓到过,这里赌它和 zai 那条同构(`data.bigmodel.access_token`)。
    赌错也不致命:`finishExchange` 会退回到平铺的 `data.access_token`。
  */
  tokenKey: 'bigmodel',
  clientId: APP_ID,
  redirect: { kind: 'loopback-ephemeral', path: CALLBACK_PATH, host: '127.0.0.1' },
  /*
    ★★ **换码那跳发的是 ZCode 注册的那个地址,不是我们真用的回环地址。**
    授权在 bigmodel.cn、换码在 zcode.z.ai,而 bigmodel 那边只认 appId=zcode 的注册值。
    详见 `zcode.ts` 里 `tokenRedirectUri` 的注释。
    ★ 如果还是换不到码,第二个候选值是逆向文档记的旧地址
    `zcode://bigmodel-auth/callback`。
  */
  tokenRedirectUri: 'zcode://oauth/callback',
  userinfoUrl: 'https://zcode.z.ai/api/oauth/userinfo',
  /*
    ★★ 标准那三个参数(`response_type` / `client_id` / `redirect_uri`)一个都不发 ——
    这是抓到的真实链接的形状。多发不是「无害的冗余」:这是一个登录页而不是授权端点,
    它拿不认识的参数怎么办完全未知。
  */
  authorizeParams: (args) => ({
    appId: args.clientId,
    redirect: args.redirectUri,
    state: args.state
  }),
  callbackCodeParam: 'authCode'
})
