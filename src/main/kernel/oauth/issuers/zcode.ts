/**
 * ZCode 登录链路的**公共实现** —— Z.AI 和智谱(BigModel)两条渠道共用。
 *
 * ============================ 证据等级 ============================
 * 协议来自**第三方逆向文档,非官方**:Vibe Coding Labs《ZCode RE》(GPL-3.0)
 * https://vibe-coding-labs.github.io/zcode-reverse-engineer/auth/oauth-flow.html
 * OAuth 页生成于 2026-07-04,分析报告 2026-06-15,逆向对象 ZCode v3.0.1 / v2.13.0。
 *
 * **2026-09-09 我自己直连复现到的**(不需要代理):
 * - `POST zcode.z.ai/api/v1/oauth/token`,JSON body `{provider:"zai",code:无效,…}`
 *   → `500 {"code":2007,"msg":"http error"}`,与文档记的「code 过期」逐字对上。
 *   证明:端点活着、**JSON body 的形状被服务端接受**、普通 TLS 栈没被 WAF 拦。
 * - `GET chat.z.ai/api/oauth/authorize`,redirect_uri 取 `127.0.0.1` / `localhost` /
 *   `evil.example.com` 三种 → 一律 307 → `/auth` 并原样透传。
 *   **authorize 阶段不校验 redirect_uri**,白名单只能靠真登录一次验。
 * - WAF(阿里云 ESA)只拦 `zcode.z.ai/api/v1/zcode-plan/*` 那两个计费接口,
 *   认证链路和 AI 端点都不受影响。
 *
 * **2026-09-15 逆向 ZCode.app v3.11.2(app.asar)拿到的服务端发起流程** —— 现在
 * 两条渠道的主路径(`cli` 字段),证据等级高于上面的逆向文档(是官方客户端
 * 自己跑的代码,不是猜的):
 * - `POST /api/v1/oauth/cli/init`,头 `Authorization: Bearer <pollToken>`、JSON
 *   body `{provider}`,pollToken 是**客户端自生成**的 32 字节随机数(服务端只
 *   存储回显,格式无所谓);响应 `{code:0, data:{flow_id, authorize_url,
 *   expires_at(秒), poll_interval_sec}}`,authorize_url 自带服务端签发的 state。
 * - 官方客户端把 authorize_url 的 redirect(bigmodel)/ redirect_uri(zai)覆盖成
 *   `zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback` 中转页;我们
 *   覆盖成自己的回环地址(理由见 `zcode-bigmodel.ts` 文件头:中转页指不到
 *   我们,自定义协议又会被已装的 ZCode 抢走)。
 * - `GET /api/v1/oauth/cli/poll/{flow_id}`(同源,Bearer 同一个 pollToken):
 *   `data.status` ∈ pending / ready / failed;**ready 的响应直接带全套凭证**
 *   `{token, user:{user_id,name,email,avatar}, zai|bigmodel:{access_token
 *   (,refresh_token)}}` —— 和换码响应同构,所以 `finishExchange` 两条通道共用。
 * - 官方客户端对 poll 的错误分类:4xx(408/429 除外)致命、网络/5xx 可重试、
 *   本地兜底超时 min(300s, expires_at-now)。`flow.ts` 的 `runCliPollFlow`
 *   逐条照抄了这些判定。
 * - 官方客户端**双通道**完成(轮询 + `zcode://` 深链换码,先到先得、30 秒去重
 *   窗吸收迟到方);我们同样双通道,只是 A 通道换成回环。
 * - 官方客户端没实现任何 refresh 端点适配(两个 adapter 都没有 refreshToken
 *   方法),过期即重登 —— 我们保留自己的刷新语义(重跑第三跳,见 `refresh`)。
 *
 * ============================ 链路全貌 ============================
 * ```
 * ① POST {cliInitUrl}        Bearer pollToken, {provider}
 *        → {code:0, data:{flow_id, authorize_url, expires_at, poll_interval_sec}}
 * ② GET  {authorize_url}     (redirect* 已覆盖为回环地址;state 是服务端签发的)
 *        → 浏览器授权,落回回环: ?code|authCode=…&state=…
 * ③ POST {tokenUrl}          Content-Type: application/json     ← A 通道
 *        {provider, code, redirect_uri, state}          ← 注意:没有 grant_type
 *        → {code:0, data:{zai:{access_token,…}, expires_in:null, user:{id}}}
 * ③' GET  {init 同源}/cli/poll/{flow_id}  Bearer pollToken      ← B 通道
 *        → {code:0, data:{status:'ready', token, user, zai|bigmodel:{access_token}}}
 * ④ POST {businessLoginUrl}  {token: ③/③' 拿到的 access_token}
 *        → {code:0, data:{access_token: 业务 JWT}}
 * ⑤ 发 AI 请求:x-api-key: <业务 JWT>
 * ```
 * ③ 和 ③' 赛跑,先到先得;init(①)失败时整体降级为旧链路 —— 本地拼授权 URL
 * (`authorizeParams`)→ ③ → ④,一个字节都不走服务端发起的那套。
 *
 * ★ 一条要记录的事实:我们用的是 **ZCode 的 client_id / appId**,等于对 Z.AI
 * 自称是 ZCode。仓库里已有同性质先例 —— `chatgpt.ts` 用的是 Codex CLI 的
 * client_id,还带着 `originator: codex_cli_rs`。写在这里是为了别让后人以为
 * 这是官方给我们的客户端。
 */
import type { OAuthCredential } from '../../../../shared/domain/credential'
import type { OAuthIssuerId } from '../../../../shared/domain/oauth-issuer'
import type { TransportContext, UpstreamTransport } from '../../upstream/transport'
import { OAuthFailedError } from '../errors'
import type {
  OAuthAuthorizeArgs,
  OAuthExchangeContext,
  OAuthGrant,
  OAuthIdentity,
  OAuthProviderSpec,
  OAuthRedirect
} from '../registry'
import { decodeJwtPayload, record, str } from './shared'

/**
 * ★ 两跳都要带这两个头。文档记的是 WAF / 来源校验要看它们。
 * 版本号写死一个真实存在过的值 —— 编一个不存在的版本号是在赌上游不做版本白名单,
 * 而那个赌输了的表现是一个不解释原因的 403。
 * `3.10.2` 取自 2026-09-09 抓到的真实授权链接里的 `app_version`(智谱那条),
 * 比逆向文档记的 v3.0.1 新,所以两处统一用这个。
 */
export const ZCODE_APP_VERSION = '3.10.2'
const ZCODE_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': `ZCode/${ZCODE_APP_VERSION}`,
  'http-referer': 'https://zcode.z.ai'
}

export interface ZcodeChannel {
  id: OAuthIssuerId
  label: string
  authorizeUrl: string
  /** ③ 换码端点 */
  tokenUrl: string
  /** ③ body 里那个 `provider` 字段的值 */
  provider: string
  /**
   * ③ 响应里包着 access_token 的那一层子对象的键。Z.AI 那条是 `zai`。
   * ★ 找不到这一层时会退回到 `data.access_token`(平铺形态),两种都试是因为
   * 只有 Z.AI 那条的响应体被真正抓到过。B 通道(poll)的 ready 响应里这一层
   * 键名相同(2026-09-15 逆向确认),两条通道共用这一个值。
   */
  tokenKey: string
  clientId: string
  /**
   * ★★ ZCode 两条渠道的回调只可能是回环 —— `manual-paste` 形态在这条链路上
   * 从没存在过,把联合收窄成回环两种,`createZcodeSpec` 里取 `path`/`host`
   * (落地页要用)就不需要再收窄一次。
   */
  redirect: Extract<OAuthRedirect, { kind: 'loopback-fixed' | 'loopback-ephemeral' }>
  /**
   * ★★ 配了它 = 走**服务端发起 + 双通道**(`cli/init` + `cli/poll`,现在是
   * 两条渠道的主路径);没配 = 纯旧链路(本地拼授权 URL + 换码)。
   *
   * 配了之后本接口里那批旧字段(`authorizeUrl` / `authorizeParams` /
   * `callbackCodeParam` / `redirect` / `tokenRedirectUri`)**没有作废** —— 它们
   * 整体变成 fallback 的配置:init 失败时 `runCliPollFlow` 降级跑的就是它们。
   * 换句话说:旧链路从「主路径」降为「保底」,数据一行没删。
   */
  cli?: {
    initUrl: string
    /**
     * authorize_url 上要被回环地址覆盖的参数名。**2026-09-15 逆向 ZCode.app
     * 确认两家不同**:bigmodel 覆盖 `redirect`,zai 覆盖 `redirect_uri`。
     */
    redirectParam: 'redirect' | 'redirect_uri'
  }
  /**
   * ③ body 里 `redirect_uri` 发的值。**省略 = 本次授权真正用的那个**(标准做法,
   * 也是 Z.AI 那条验证过的行为)。
   *
   * ★★ 智谱那条要覆盖它。原因是那条链路的授权和换码**不在同一家**:授权在
   * `bigmodel.cn`,换码在 `zcode.z.ai`(它再转发给 bigmodel —— 2007 的 msg 是字面的
   * `http error`,即上游那一跳失败)。而 `bigmodel.cn` 的前端对 `redirect` 只有一条
   * XSS 黑名单、压根不记录我们发的地址,所以上游能比对的只有**注册值**
   * `zcode://oauth/callback`。发我们自己的回环地址在那边匹配不上。
   *
   * ★ 探针证明这个字段只查存在性、不当场校验值(乱填也返回同样的 2007),
   * 所以它错了的表现不是一句「redirect_uri 不对」,而是和「code 无效」一模一样。
   */
  tokenRedirectUri?: string
  /**
   * ④ 拿业务令牌的端点。**省略 = 没有这一跳**,直接把 ③ 的 access_token 当
   * 发请求用的令牌。
   *
   * ★ 省略时(且没配 `apiKeyProvision`)`refresh` 会返回 null(= 让用户重新登录),
   * 因为没有第四跳就没有「再换一把」的动作可做。这比假装刷新成功、然后每次请求
   * 都 401 要诚实。
   */
  businessLoginUrl?: string
  /**
   * ★★★ ④':把 OAuth access_token **供应成一把真 API Key**(bigmodel 那条)。
   * 配了它,`businessLoginUrl` 就不该再配 —— 两者是同一个槽位的两种实现。
   *
   * 完整链路和证据见 `provisionBizApiKey` 上面那段注释(逆向自 ZCode.app 打包的
   * CLI):查机构/项目 → 找或建名为 `keyName` 的 API Key → copy 出 secretKey,
   * 最终 apiToken = `apiKey.secretKey`。它**不会过期**,刷新 = 幂等地重跑一遍。
   *
   * ★ 鉴权头是**裸 `Authorization: <token>`**(不带 Bearer)—— CLI 原样如此,
   * biz API 只认这个形状。
   */
  apiKeyProvision?: {
    /** biz API 的主机,如 `https://bigmodel.cn`(CLI 的 BIGMODEL_API_BASE_URL 缺省值) */
    bizHost: string
    /** 要找/建的那把 key 的名字。CLI 用死值 `zcode-api-key` */
    keyName: string
  }
  /** 可选的用户信息端点,只为了在设置页显示邮箱。**失败一律不致命** */
  userinfoUrl?: string
  /**
   * 授权入口不是标准 OAuth 授权端点时,自己拼查询参数(见 `registry.ts` 的
   * `authorizeParams`)。省略 = 标准那一套。**fallback 路径专用**(主路径的
   * 授权 URL 由服务端签发)。
   */
  authorizeParams?: (args: OAuthAuthorizeArgs) => Readonly<Record<string, string>>
  /** 回调里装授权码的参数名。省略 = `code` */
  callbackCodeParam?: string
}

/** ③ / ③' 共同的信封:`{code, msg, data}`,`code !== 0` 即业务失败 */
function unwrapEnvelope(json: unknown, what: string): Record<string, unknown> {
  const body = record(json)
  if (body === undefined) throw new OAuthFailedError(`${what}失败：响应不是一个对象`)
  const code = body['code']
  if (typeof code === 'number' && code !== 0) {
    const msg = str(body['msg']) ?? str(body['message']) ?? '未说明原因'
    /*
      ★ 把上游的 code 原样带出来。2007 = 授权码过期/无效(实测),1000 = 服务端
      内部错。用户看到的那句话里有这个数字,才有可能对上文档或搜到别人的记录。
    */
    throw new OAuthFailedError(`${what}失败（${code}）：${msg}`)
  }
  const data = record(body['data'])
  if (data === undefined) throw new OAuthFailedError(`${what}失败：响应里没有 data`)
  return data
}

/** ★ 账号 id 在有的响应里是数字。数字 0 不算有效 id,和空串一样丢掉 */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value)
  return str(value)
}

async function postJson(
  ctx: OAuthExchangeContext,
  url: string,
  body: Readonly<Record<string, unknown>>,
  what: string
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...ZCODE_HEADERS },
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    throw new OAuthFailedError(`${what}失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthFailedError(`${what}失败：响应不是 JSON —— ${text.slice(0, 300)}`)
  }
}

/**
 * `finishExchange` 之后、喂给 `identity()` 之前的中间形态。
 *
 * ★★ 它存在的理由是 `identity()` 必须是**同步纯函数**(测试要能摆布 `now`),
 * 而这条链路要发两三个请求才凑得齐一条凭证。异步的部分全在 `finishExchange`,
 * 同步的字段映射全在 `identity` —— 于是后者可以拿一个字面量对象直接测。
 */
interface ZcodeExchange {
  /** ③ 的 access_token。**它会被存进 `refreshToken` 槽,见下面 `identity` 的注释** */
  oauthAccessToken: string
  /** 真正发出去的那把(有第三跳就是业务 JWT,没有就等于 `oauthAccessToken`) */
  apiToken: string
  /** ③/③' 响应里的 `data.user` —— 业务 JWT 里解不出 user_id 时的兜底 */
  fallbackAccountId?: string
  email?: string
}

/** ④:拿业务令牌。**刷新时也走这里**,所以单独一个函数 */
async function businessLogin(
  channel: ZcodeChannel,
  ctx: OAuthExchangeContext,
  oauthAccessToken: string
): Promise<string> {
  const url = channel.businessLoginUrl
  if (url === undefined) return oauthAccessToken
  const data = unwrapEnvelope(
    await postJson(ctx, url, { token: oauthAccessToken }, '换取业务令牌'),
    '换取业务令牌'
  )
  const jwt = str(data['access_token'])
  if (jwt === undefined) throw new OAuthFailedError('换取业务令牌失败：响应里没有 access_token')
  return jwt
}

/*
 * ================== ④':把 OAuth token 供应成一把真 API Key ==================
 *
 * ★★★ 2026-09-15 逆向 ZCode.app 打包的 CLI(`Resources/glm/zcode.cjs` 的
 * `resolveCodingPlanApiKey`)得到的完整链路 —— 这就是「拿 OAuth token 直接当
 * API key 会 1234」的真相:**coding 端点要的是一把真 API Key(`id.secret` 形态),
 * 不是 OAuth token**。真实客户端在登录的最后一步就把这把 key 配好了:
 *
 *   ① GET  {bizHost}/api/biz/customer/getCustomerInfo
 *          Authorization: <OAuth token>(裸值,不带 Bearer —— CLI 的 createBizAuthHeaders 原样如此)
 *          → data.organizations[]:名字含「默认机构」的第一个,否则第 [0] 个;
 *            其下 projects[] 同样规则挑「默认项目」
 *   ② GET  {bizHost}/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys
 *          → 找 name === keyName 的那条;没有就 POST 同地址 {name: keyName} 创建
 *   ③ GET  {…}/api_keys/copy/{apiKey} → secretKey
 *   最终 apiToken = `${apiKey}.${secretKey}`(copy 没给 secretKey 时就只用 apiKey)
 *
 * 拿到的 key 被写进配置当普通 API Key 用(anthropic 端点 x-api-key、openai 端点
 * Bearer 都行) —— 它**不是令牌、不会过期**,所以刷新 = 重跑一遍供应(对付 key
 * 被用户在控制台删掉的情况),平时什么都不用做。
 *
 * ★ 信封成功码是 `{null, 0, 200, "0", "200"}`(CLI 的 isSuccessfulRemoteCode),
 * 和 `unwrapEnvelope` 那套「数字非 0 即失败」不同 —— 这套 API 对 200 和 0 都算成功。
 */

/** biz API 的信封:成功码比换码那套宽(0/200/缺省都算成功) */
function isBizSuccess(code: unknown): boolean {
  return (
    code === null ||
    code === undefined ||
    code === 0 ||
    code === 200 ||
    code === '0' ||
    code === '200'
  )
}

async function bizRequest(
  ctx: OAuthExchangeContext,
  url: string,
  oauthAccessToken: string,
  what: string,
  init: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' }
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method: init.method,
    headers: {
      authorization: oauthAccessToken,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    throw new OAuthFailedError(`${what}失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new OAuthFailedError(`${what}失败：响应不是 JSON —— ${text.slice(0, 300)}`)
  }
  const body = record(json)
  const code = body?.['code']
  if (body === undefined || !isBizSuccess(code)) {
    const msg = str(body?.['msg']) ?? str(body?.['message']) ?? '未说明原因'
    throw new OAuthFailedError(`${what}失败（${String(code)}）：${msg}`)
  }
  return body['data'] ?? null
}

/** 只看含「默认机构」名字段的那半边 —— 项目那边字段名不同,分开写比合着一个函数猜字段诚实 */
function toRecords(list: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list.map((item) => record(item)).filter((item): item is Record<string, unknown> => item !== undefined)
}

/** 名字含 marker 的第一个,否则第 [0] 个 —— CLI 的 pickOrgAndProject 原样规则 */
function pickByMarker(
  list: unknown,
  marker: string,
  nameKey: 'organizationName' | 'projectName'
): Record<string, unknown> | undefined {
  const records = toRecords(list)
  if (records === undefined || records.length === 0) return undefined
  return records.find((r) => str(r[nameKey])?.includes(marker)) ?? records[0]
}

/**
 * ④':三步供应。**刷新时也走这里** —— API Key 不过期,但可能被用户在控制台删掉,
 * 重跑一遍就是幂等的找回(存在就直接用,不存在就重建)。
 */
async function provisionBizApiKey(
  channel: ZcodeChannel,
  ctx: OAuthExchangeContext,
  oauthAccessToken: string
): Promise<string> {
  const provision = channel.apiKeyProvision
  if (provision === undefined) return oauthAccessToken
  const host = provision.bizHost

  const customer = record(
    await bizRequest(
      ctx,
      `${host}/api/biz/customer/getCustomerInfo`,
      oauthAccessToken,
      '查询账号机构信息'
    )
  )
  const org = pickByMarker(customer?.['organizations'], '默认机构', 'organizationName')
  const orgId = str(org?.['organizationId'])
  const project = pickByMarker(org?.['projects'], '默认项目', 'projectName')
  const projectId = str(project?.['projectId'])
  if (orgId === undefined || projectId === undefined) {
    throw new OAuthFailedError('换取 API Key 失败：账号下没有可用的机构/项目')
  }

  const keysUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`
  const existing = await bizRequest(ctx, keysUrl, oauthAccessToken, '查询 API Key')
  const found = toRecords(existing)?.find((r) => str(r['name']) === provision.keyName)
  const entry =
    found ??
    record(
      await bizRequest(ctx, keysUrl, oauthAccessToken, '创建 API Key', {
        method: 'POST',
        body: JSON.stringify({ name: provision.keyName })
      })
    )
  const apiKey = str(entry?.['apiKey'])
  if (apiKey === undefined) throw new OAuthFailedError('换取 API Key 失败：响应里没有 apiKey')

  /*
   * ★ copy 这一步失败不致命(CLI 对 bigmodel 也不强制 secretKey):只有 `id` 没有
   *   `secret` 的 key 形态上不完整,但让它抛出去的表现是「登录失败」,而其实有得用
   *   —— 先把能用的返回,让请求端去暴露真实问题。
   */
  try {
    const copied = record(
      await bizRequest(
        ctx,
        `${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
        oauthAccessToken,
        '复制 API Key'
      )
    )
    const secretKey = str(copied?.['secretKey'])
    if (secretKey !== undefined) return `${apiKey}.${secretKey}`
  } catch {
    /* 吞掉 —— 见上面那段注释 */
  }
  return apiKey
}

/**
 * 可选的用户信息。**任何失败都吞掉**。
 *
 * ★ 为一个只在设置页显示的邮箱让整个登录失败,是拿一个装饰性字段去赌用户的登录 ——
 * 完全不划算。所以这里连超时都交给 ctx.signal,自己一个错都不往上抛。
 */
async function fetchEmail(
  channel: ZcodeChannel,
  ctx: OAuthExchangeContext,
  oauthAccessToken: string
): Promise<string | undefined> {
  const url = channel.userinfoUrl
  if (url === undefined) return undefined
  try {
    const res = await ctx.fetch(url, {
      headers: {
        authorization: `Bearer ${oauthAccessToken}`,
        accept: 'application/json',
        ...ZCODE_HEADERS
      },
      signal: ctx.signal
    })
    if (!res.ok) return undefined
    const body = record(await res.json())
    if (body === undefined) return undefined
    const data = record(body['data']) ?? body
    return str(data['email'])
  } catch {
    return undefined
  }
}

/**
 * 从业务 JWT(和 ③ 响应 user 的兜底)里定出 accountId。
 *
 * ★ 这条链路的 accountId **不进任何请求头** —— 它只是凭证的身份字段。但
 * `parseCredential` 要求它非空(见 `shared/domain/credential.ts`),空了的表现是
 * **登录成功、下一秒显示未登录**。所以宁可多试几个来源。
 */
function accountIdOf(apiToken: string, fallback: string | undefined): string | undefined {
  const claims = decodeJwtPayload(apiToken)
  return idOf(claims?.['user_id']) ?? idOf(claims?.['sub']) ?? fallback
}

export function createZcodeSpec(channel: ZcodeChannel): OAuthProviderSpec {
  const identity = (json: unknown, _now: number): OAuthIdentity | null => {
    const x = record(json)
    if (x === undefined) return null
    const oauthAccessToken = str(x['oauthAccessToken'])
    const apiToken = str(x['apiToken'])
    if (oauthAccessToken === undefined || apiToken === undefined) return null

    const accountId = accountIdOf(apiToken, str(x['fallbackAccountId']))
    if (accountId === undefined) return null

    const email = str(x['email'])
    return {
      accessToken: apiToken,
      /*
        ★★★ **这里存进 `refreshToken` 槽的不是 refresh token。**
        这条链路没有可用的 refresh token(换码响应里 `refresh_token` 是 null;
        poll 响应里 bigmodel 那条虽然带,但对应的刷新端点官方客户端都没实现),
        但有**等价物**:③ 的 access_token 可以重跑第四跳再换一把业务 JWT。
        所以这个槽装的是「用来再换一次的那个东西」,`refresh` 钩子照这个语义读它。

        为什么不给 `OAuthCredential` 加个新字段:`parseCredential` 对
        `refreshToken` 的非空校验是一条安全相关的解析规则,放宽它要动的地方比
        在这里写清楚语义多得多,而收益是零。
      */
      refreshToken: oauthAccessToken,
      /*
        ★★ `expiresAt: null` = **不知道什么时候过期**,不是永不过期。
        上游 `expires_in` 回的就是 null,而**编一个假的过期时间比承认不知道更糟**:
        猜短了平白多刷几次,猜长了会拿一把死 token 去撞 401 并废掉那次对话。
        未知时靠 401 触发刷新(`router.ts` 的 401 重试路径本来就在)。
      */
      expiresAt: null,
      accountId,
      ...(email === undefined ? {} : { email })
    }
  }

  /*
    ★★ grant 怎么建只看 `channel.cli` 有没有配:配了 = 服务端发起 + 双通道,
    没配 = 旧链路原样。**fallback 里那份 authorization-code 用的就是渠道表上
    原来那几个字段**,一行不差 —— init 失败降级后的行为和改造前逐字节相同,
    这句话是 fallback 敢当保底的全部依据。

    ★ 落地回环**强制临时端口**:服务端发起的这条链路对 redirect 没有注册值
    约束(它本来就打算发一个自定义协议地址),没理由占 zai 那个 9999 ——
    用户机器上真在跑的 ZCode CLI 就监听在那儿。
  */
  const grant: OAuthGrant =
    channel.cli === undefined
      ? { kind: 'authorization-code', authorizeUrl: channel.authorizeUrl, redirect: channel.redirect }
      : {
          kind: 'cli-poll',
          initUrl: channel.cli.initUrl,
          provider: channel.provider,
          redirectParam: channel.cli.redirectParam,
          landingPath: channel.redirect.path,
          ...(channel.redirect.host === undefined ? {} : { host: channel.redirect.host }),
          fallback: {
            kind: 'authorization-code',
            authorizeUrl: channel.authorizeUrl,
            redirect: channel.redirect
          }
        }

  return {
    id: channel.id,
    label: channel.label,
    tokenUrl: channel.tokenUrl,
    clientId: channel.clientId,
    grant,
    /*
      ★ 这条链路**不支持 PKCE**,授权 URL 里不能有 code_challenge;也没有 scope。
      两者都是「省略」而不是「置空」——`scope=` 和「没有 scope」在有的服务端上
      是两种反应。
    */
    pkce: false,
    ...(channel.authorizeParams === undefined
      ? {}
      : { authorizeParams: channel.authorizeParams }),
    ...(channel.callbackCodeParam === undefined
      ? {}
      : { callbackCodeParam: channel.callbackCodeParam }),

    tokenRequest: (args) => ({
      contentType: 'json',
      /*
        ★★ **整体替换,而不是在标准 body 上加字段。** 这里没有 `grant_type`、
        没有 `client_id`、没有 `code_verifier` —— 标准 OAuth 的那几个字段一个都不发。
        2026-09-09 实测:正是这个形状的 body 才会走到「换码」那一步(返回 2007),
        换成表单编码或加上 grant_type 都没验过。
      */
      body: {
        provider: channel.provider,
        code: args.code,
        // ★ 省略时用本次真正的回调地址 —— Z.AI 那条走的就是这条，行为一个字没变
        redirect_uri: channel.tokenRedirectUri ?? args.redirectUri,
        state: args.state
      },
      headers: ZCODE_HEADERS
    }),

    finishExchange: async (json, ctx) => {
      const data = unwrapEnvelope(json, '换取授权令牌')
      const nested = record(data[channel.tokenKey])
      const oauthAccessToken = str(nested?.['access_token']) ?? str(data['access_token'])
      if (oauthAccessToken === undefined) {
        throw new OAuthFailedError('换取授权令牌失败：响应里没有 access_token')
      }

      /*
        ★★ 第四跳的三种形态,由渠道数据决定(优先级:apiKeyProvision > businessLoginUrl > 无):
        - apiKeyProvision(bigmodel):OAuth token → 真 API Key(`id.secret`)
        - businessLoginUrl(zai):OAuth token → 业务 JWT
        - 都没有:token 原样就是发请求用的令牌
      */
      const apiToken =
        channel.apiKeyProvision !== undefined
          ? await provisionBizApiKey(channel, ctx, oauthAccessToken)
          : await businessLogin(channel, ctx, oauthAccessToken)
      /*
        ★★ `user.id` 和 `user.user_id` 两个都认:换码响应(A 通道)用的是 `id`
        (逆向文档记的形状),poll 的 ready 响应(B 通道)用的是 `user_id`
        (2026-09-15 逆向 ZCode.app 确认)。这里只是业务 JWT/供应出的 key 里解不出
        user_id 时的兜底,取不到不致命(见 `identity` 的判空),但取到了就能少一次
        「登录成功却报凭证不完整」的假故障。
      */
      const user = record(data['user'])
      const fallbackAccountId = idOf(user?.['id']) ?? idOf(user?.['user_id'])
      /*
        ★★ 邮箱**优先从响应自带的 user 里读**,userinfo 端点只是兜底 ——
        poll 的 ready 响应带 user.{user_id,name,email,avatar}(逆向确认),这部分
        数据已经在手里,再发一次 userinfo 请求是白花一次网络;而 bigmodel 压根
        没配 userinfoUrl(已知 404),没有这一层它的邮箱永远拿不到。
      */
      const email = str(user?.['email']) ?? (await fetchEmail(channel, ctx, oauthAccessToken))

      const exchange: ZcodeExchange = {
        oauthAccessToken,
        apiToken,
        ...(fallbackAccountId === undefined ? {} : { fallbackAccountId }),
        ...(email === undefined ? {} : { email })
      }
      return exchange
    },

    identity,

    /**
     * 刷新 = **重跑第四跳**,不是标准的 `grant_type=refresh_token`。
     *
     * ★★ accountId 必须沿用旧的:新令牌里解得出 `user_id` 就用新的,
     * 解不出就用 `cred.accountId`。**漏掉这一步的表现是每刷新一次就把用户踢下线**
     * —— `CredentialResolver` 拿到 `null` 会 `markReauth`。
     *
     * ★ 两种第四跳都能重跑:apiKeyProvision 是幂等供应(key 被删了就重建),
     * businessLoginUrl 是再换一把业务 JWT。**两者都没有**的渠道返回 `null`
     * = 让用户重新登录 —— 真实 ZCode.app 同样没给这类渠道实现刷新。
     */
    refresh: async (cred, ctx) => {
      if (channel.apiKeyProvision === undefined && channel.businessLoginUrl === undefined) {
        return null
      }
      const apiToken =
        channel.apiKeyProvision !== undefined
          ? await provisionBizApiKey(channel, ctx, cred.refreshToken)
          : await businessLogin(channel, ctx, cred.refreshToken)
      return {
        accessToken: apiToken,
        refreshToken: cred.refreshToken,
        expiresAt: null,
        accountId: accountIdOf(apiToken, cred.accountId) ?? cred.accountId,
        ...(cred.email === undefined ? {} : { email: cred.email }),
        ...(cred.planType === undefined ? {} : { planType: cred.planType })
      }
    },

    /*
      ★★ 有第四跳的渠道(zai / bigmodel):鉴权头**这里一个字都不写** ——
      最终 accessToken 要么是业务 JWT(zai)、要么是一把真 API Key(bigmodel,
      `id.secret` 形态),两种都是上游编码器认得的凭证:
      anthropic 协议 `encode/anthropic.ts` 首发就写 `x-api-key`,401 重发路径
      `transport.ts` 的 `authHeader` 对 anthropic 也返回 `x-api-key`,openai 协议
      两个 encode 写的都是 `Authorization: Bearer <同一个串>` —— 两条路径本来就对。
      在这里再写一遍等于给同一件事开第二个真相来源。

      ★★ 两种第四跳**都没有**的渠道:accessToken 就是 OAuth token 本身,要**补一个
      `Authorization: Bearer`** —— 2026-09-15 逆向 ZCode.app v3.11.2:它发 anthropic
      请求时 `Authorization: Bearer` 和 `x-api-key` **双头都带**,biz API 校验也用
      裸 `Authorization` 头。OpenAI 族的 encode 本来写的就是 Bearer,这一层对它们
      是恒等的;anthropic 族则从只有 x-api-key 变成双头。
      (今天没有渠道走这条分支 —— 留着它是给「直接用 OAuth token 发请求」的那天。)
    */
    transport: (cred: OAuthCredential, _ctx: TransportContext): UpstreamTransport => ({
      headers: {
        ...(channel.businessLoginUrl === undefined && channel.apiKeyProvision === undefined
          ? { authorization: `Bearer ${cred.accessToken}` }
          : {}),
        ...ZCODE_HEADERS
      },
      body: (body) => body
    })
  }
}
