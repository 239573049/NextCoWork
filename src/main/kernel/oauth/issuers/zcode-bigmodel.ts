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
 * ============================ 实测进展(2026-09-09) ============================
 * **登录整条链路已经打通** —— 用户实测确认「登陆成功了」。走到这一步改了三处**数据**:
 * `provider: 'bigmodel'`(见下)、`tokenRedirectUri`(见下)、`callbackCodeParam: 'authCode'`。
 * 流程代码一处分支都没加。换码的响应体仍然没被抓到,但既然凭证落库了,
 * `tokenKey: 'bigmodel'` 那条(或它的平铺回退)至少有一条是对的。
 *
 * 登录之后发 AI 请求一度回 `[1234][网络错误…]`,当时归因于「少了第三跳」并填上了
 * `businessLoginUrl` —— **2026-09-15 这个结论被证伪**(真 token 打 z/login 同样被拒,
 * 详见下面 `apiKeyProvision` 那段的定案记录),已移除。1234 的真实原因同日从 ZCode.app
 * 打包的 CLI 里逆向定案:**coding 端点要的是真 API Key,OAuth token 要先经三步供应**
 * (见 `apiKeyProvision` 注释),现在登录链路已逐字对齐。
 *
 * ============================ 排查时少走的两条弯路 ============================
 * ① **1234 不是端点选错。** 先怀疑过是登录后被自动切到了
 *    `open.bigmodel.cn/api/anthropic`(预设注释记着官方 FAQ:该端点仅限加白账号),
 *    切回 coding 端点后**同样是 1234**。那次自动切换的行为仍然改掉了 ——
 *    按 issuer 查表(`renderer/.../provider-auth.ts` 的 `SIGN_IN_PROTOCOL`),
 *    Z.AI 那条要切、这条不切 —— 但它不是 1234 的原因。
 *
 * ② **`zcode.z.ai` 上没有任何 AI 代理**(`/api/anthropic`、`/api/v1/anthropic`、
 *    `/api/v1/proxy/anthropic`、`/api/coding/paas/v4` 一律 404),别再往那边找端点。
 *    AI 端点只在 `open.bigmodel.cn` 和 `api.z.ai` 上。
 *
 * ★ 探路方法记一笔:`open.bigmodel.cn` 的 `/api/paas/*` 和 `bigmodel.cn` 的 `/api/biz/*`
 *   **鉴权跑在路由之前**,乱码路径也回鉴权错误 —— 在这两个前缀下扫路径是白费。
 *   其他前缀(如 `/api/auth/*` 里公开的那几条)才会干净地回 `404 NOT_FOUND`。
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
 * ★★ 2026-09-15 起这条结论**同时服务两条路径**:主路径(cli/init 服务端发起)
 * 拿到的 authorize_url 同样把 `redirect` 覆盖成回环地址 —— 「没有白名单」这个
 * 前提不变,覆盖对象从本地拼的登录页换成了服务端签发的授权 URL 而已。
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
    (2026-09-15 逆向 ZCode.app 再次确认:官方 init body 发的就是 `provider:"bigmodel"`。)
  */
  provider: 'bigmodel',
  /*
    ★ 响应体没被抓到过,这里赌它和 zai 那条同构(`data.bigmodel.access_token`)。
    赌错也不致命:`finishExchange` 会退回到平铺的 `data.access_token`。
    (B 通道的 poll ready 响应里这一层就叫 `bigmodel`,含 refresh_token —— 逆向确认。)
  */
  tokenKey: 'bigmodel',
  clientId: APP_ID,
  /*
    ★★ 主路径的服务端发起流程。`redirect` 这个参数名是 2026-09-15 逆向
    ZCode.app v3.11.2 确认的:官方客户端对 bigmodel 渠道覆盖的是 `redirect`
    (zai 那条覆盖的是 `redirect_uri`,两家不一样)。
  */
  cli: {
    initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
    redirectParam: 'redirect'
  },
  redirect: { kind: 'loopback-ephemeral', path: CALLBACK_PATH, host: '127.0.0.1' },
  /*
    ★★ **换码那跳发的是 ZCode 注册的那个地址,不是我们真用的回环地址。**
    授权在 bigmodel.cn、换码在 zcode.z.ai,而 bigmodel 那边只认 appId=zcode 的注册值。
    详见 `zcode.ts` 里 `tokenRedirectUri` 的注释。
    ★ 如果还是换不到码,第二个候选值是逆向文档记的旧地址
    `zcode://bigmodel-auth/callback`。
  */
  tokenRedirectUri: 'zcode://oauth/callback',
  /*
    ★★★ **第四跳 = 把 OAuth token 供应成一把真 API Key。** 2026-09-15 逆向
    ZCode.app 打包的 CLI(`Resources/glm/zcode.cjs` 的 `resolveCodingPlanApiKey`)
    拿到的完整链路,登录最后一步逐字对齐:

      ① GET bigmodel.cn/api/biz/customer/getCustomerInfo  Authorization: <token>(裸值)
         → 挑「默认机构」/「默认项目」(名字含关键字的第一条,否则 [0])
      ② GET …/api/biz/v1/organization/{org}/projects/{proj}/api_keys
         → 找 name='zcode-api-key';没有就 POST 创建一把
      ③ GET …/api_keys/copy/{apiKey} → secretKey
      最终 accessToken = `apiKey.secretKey`(bigmodel 的标准 API Key 形态)

    **这就是 1234 的真相**:coding 端点(`/api/coding/paas/v4` 或 `/api/anthropic`)
    要的是真 API Key,OAuth token 直接当 key 用它不认。CLI 登录完成后把这把 key
    写进用户配置(`provider.bigmodel.options.apiKey`),之后当普通 key 用。

    ⚠️ 前两轮的结论都写在这里防再犯:
    - z/login 第四跳已被证伪(真 token 也被拒,`z.ai用户信息异常`)—— 别加回来;
    - 「OAuth token 直接当 key」也已被证伪(1234)—— 必须走这三步供应。
  */
  apiKeyProvision: {
    /*
      ★ CLI 的 `hje()`:生产缺省 `https://bigmodel.cn`(env 可覆盖)。
      注意 biz API 在 bigmodel.cn 主域上,而 AI 端点在 open.bigmodel.cn —— 两个域名,
      别合并。
    */
    bizHost: 'https://bigmodel.cn',
    keyName: 'zcode-api-key'
  },
  /*
    ★ **不填 `userinfoUrl`。** 逆向文档记的 `zcode.z.ai/api/oauth/userinfo`
    2026-09-09 实测是 404(Z.AI 那条 `chat.z.ai/api/oauth/userinfo` 回 401,是活的)。
    它只用来在设置页显示邮箱,失败本来就不致命 —— 但留着一个已知 404 的地址,
    只会让下一个排查的人以为这里还有一条没走通的链路。
  */
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
