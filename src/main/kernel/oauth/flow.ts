/**
 * OAuth 登录流程的**通用编排** —— 一份代码跑所有 issuer。
 *
 * ★★ 这里没有任何一家的知识:端点、client_id、回调怎么接、怎么提账号身份,
 * 全部从 `OAuthProviderSpec` 里读(见 `registry.ts` 的文件头)。加一家 = 加一行数据。
 *
 * ★ 两种授权方式各一段编排,分岔点只有 `runOAuthFlow` 里那一个 switch:
 * - **授权码**(ChatGPT / ZCode):开授权页 → 从回调或粘贴里取 code → 换 token
 * - **设备码**(RFC 8628,Kimi):申请配对码 → 用户去浏览器输 → 按 interval 轮询
 * 拿到 token 之后的一切(第二跳、身份提取、凭证落盘)两条路共用。
 *
 * ★ 零 Electron import。`shell.openExternal` 是**注入**进来的(`openBrowser`),
 * `fetch` 和 `now` 也是 —— 于是整条流程可以在纯 Node 里用假上游跑完。
 */
import type { OAuthCredential } from '../../../shared/domain/credential'
import { OAuthAbandonedError, OAuthFailedError } from './errors'
import { awaitOAuthCallback, type LoopbackResult } from '../../net/oauth-loopback'
import { record, str } from './issuers/shared'
import { createPkce, randomState, stateMatches } from './pkce'
import {
  redirectUriOf,
  type OAuthGrant,
  type OAuthProviderSpec,
  type OAuthTokenRequest,
  type OAuthTokenRequestArgs
} from './registry'

export type OAuthPhase =
  | 'opening'
  | 'waiting'
  | 'exchanging'
  | 'done'
  | 'failed'
  | 'cancelled'

// ★ 定义挪到了 `errors.ts`(见那边的文件头:issuer 要抛它们,留在这里会成环),
// 这里原样 re-export —— 既有的 `from './flow'` 一个都不用改
export { OAuthAbandonedError, OAuthFailedError }

/**
 * 设备码流程里**必须显示给用户看**的两样东西。
 *
 * ★★ 它跟着 `waiting` 阶段一起推给上层,而不是另开一个事件:配对码是「等待授权」
 * 这个状态**的内容**,不是一件独立发生的事。分成两个事件的话,上层要自己保证
 * 两者的先后和配对,而错配的表现是界面上一个空的配对码框 —— 用户无从下手。
 */
export interface OAuthDeviceHint {
  /** 用户要在浏览器里核对/输入的配对码,如 `B7MB-FOW3` */
  userCode: string
  /** 输码的页面(不带码的那个)。给「浏览器没自动打开」时手动访问用 */
  verificationUri: string
}

export interface OAuthFlowDeps {
  spec: OAuthProviderSpec
  /**
   * ★ 注入 `host.fetch` 不只是为了可测:它是 Electron 的 `net.fetch`,走 Chromium
   * 网络栈,于是**设置页那份代理配置对换 token 这一步一样生效**。用全局 fetch 的话,
   * 企业代理后面的用户会遇到「授权页能开、换 token 超时」这种只在这一步失败的怪象。
   */
  fetch: typeof globalThis.fetch
  now: () => number
  openBrowser: (url: string) => Promise<void>
  /**
   * ★ 第二个参数只在**设备码流程的 `waiting`** 上出现。授权码流程一如既往
   * 只推一个阶段名 —— 那条路径的调用方一个字都不用改。
   */
  onPhase?: (phase: OAuthPhase, device?: OAuthDeviceHint) => void
  signal: AbortSignal
  /** `manual-paste` 形态下,等用户把 code 粘回来 */
  awaitPastedCode?: () => Promise<string>
}

function authorizeUrl(
  spec: OAuthProviderSpec,
  endpoint: string,
  args: { challenge: string; state: string; redirectUri: string }
): string {
  const u = new URL(endpoint)
  const custom = spec.authorizeParams?.({ ...args, clientId: spec.clientId })
  if (custom === undefined) {
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', spec.clientId)
    u.searchParams.set('redirect_uri', args.redirectUri)
    // ★ 没声明 scope 的家**一个字都不写**,而不是写成空串 —— 有的服务端对
    //   `scope=` 和「没有 scope」的反应不一样
    if (spec.scope !== undefined) u.searchParams.set('scope', spec.scope)
    u.searchParams.set('state', args.state)
    if (spec.pkce !== false) {
      u.searchParams.set('code_challenge', args.challenge)
      u.searchParams.set('code_challenge_method', 'S256')
    }
  } else {
    // ★ 整体替换:标准那几个参数一个都不写(见 `authorizeParams` 的注释)
    for (const [k, v] of Object.entries(custom)) u.searchParams.set(k, v)
  }
  for (const [k, v] of Object.entries(spec.extraAuthorizeParams ?? {})) {
    u.searchParams.set(k, v)
  }
  return u.toString()
}

/**
 * 换 token。授权码流程和刷新流程共用这一个 —— 两边的差别只有 body 里那几个字段,
 * 而**错误处理、超时、内容类型这些坑是同一批**,写两遍就会有一遍漏掉。
 *
 * ★ body 的**形状**由调用方给(`OAuthTokenRequest`),因为标准 OAuth 是表单
 * 而有的家(ZCode)要 JSON;但上面那批坑仍然只有这一份。
 */
export async function postToken(
  spec: OAuthProviderSpec,
  fetchImpl: typeof globalThis.fetch,
  request: OAuthTokenRequest,
  signal: AbortSignal
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: string }> {
  const merged: Record<string, unknown> = { ...request.body, ...(spec.extraTokenParams ?? {}) }
  const asJson = request.contentType === 'json'
  const res = await fetchImpl(spec.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(request.headers ?? {})
    },
    body: asJson
      ? JSON.stringify(merged)
      : new URLSearchParams(merged as Record<string, string>).toString(),
    signal
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, body: text }
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, status: res.status, body: text }
  }
}

/**
 * 标准授权码换 token 的请求体 —— **`tokenRequest` 缺省时的那一份。**
 *
 * ★ 单独导出,是为了让「默认值等于今天的行为」这句话有个可以直接对照的实体:
 * 加了钩子之后 ChatGPT 那条路径走的仍然是这里,一个字节都没变。
 */
export function defaultTokenRequest(args: OAuthTokenRequestArgs): OAuthTokenRequest {
  return {
    contentType: 'form',
    body: {
      grant_type: 'authorization_code',
      code: args.code,
      client_id: args.clientId,
      // ★ 这里的 redirect_uri 必须和授权请求里那个**逐字相同** —— 服务端会比对,
      //   不一致就是一个不说明原因的 invalid_grant。所以两处都从 redirectUriOf 来
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier
    }
  }
}

/**
 * 手动粘贴形态下等用户的时长。
 *
 * ★★ 在此之前这条路径**根本没有超时** —— `await deps.awaitPastedCode()` 只能被
 * abort 或者一次 submitCode 唤醒,于是用户关掉授权页什么也不做,登录就永远挂在
 * 「等待授权中」,连一句「超时」都等不到。回环那条路径有五分钟兜底(见
 * `oauth-loopback.ts` 的 `DEFAULT_TIMEOUT_MS`),这里对齐它。
 */
const MANUAL_PASTE_TIMEOUT_MS = 5 * 60_000

/** 等用户粘贴,但**带上超时和取消** —— 三条路都收敛,不会留下一个吊着的 Promise */
async function awaitPasteWithDeadline(await_: () => Promise<string>, signal: AbortSignal): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      await_(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new OAuthAbandonedError('timeout'))
        }, MANUAL_PASTE_TIMEOUT_MS)
        onAbort = (): void => {
          reject(new OAuthAbandonedError('cancelled'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    // ★ 赢家出来之后必须把输家拆干净:留着定时器会在五分钟后 reject 一个
    //   已经没人接的 Promise,那就是一次 unhandled rejection
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 从用户粘回来的东西里取出授权码,并**校验 state**。
 *
 * ★★ **这里必须和回环那条路径一样校验 state。** 之前粘贴路径是直接把用户
 * 输入当 code 用的 —— 而 state 正是 CSRF 防线本身:没有它,一个「你的授权码是
 * xxx,请粘进应用」的钓鱼页就能把攻击者的账号绑到用户的应用上。回环那条早就
 * 校验了(`oauth-loopback.ts` 里那段注释),粘贴这条不能是个缺口。
 *
 * ★ 所以收的是**整条回调地址**,不是光秃秃一个 code:地址栏里一次全选复制,
 * code 不会被手抖截断,state 也跟着一起回来了。`zcode://oauth/callback?...`
 * 这种自定义 scheme 一样能被 `new URL` 解析。
 */
export function pastedCallbackCode(
  pasted: string,
  expectedState: string,
  codeParam = 'code'
): { ok: true; code: string } | { ok: false; reason: string } {
  const text = pasted.trim()
  if (text === '') return { ok: false, reason: '没有粘贴任何内容' }

  let params: URLSearchParams
  try {
    params = new URL(text).searchParams
  } catch {
    // 只复制了 `?` 后面那一段的情况
    params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text)
  }

  const error = params.get('error')
  if (error !== null) {
    return { ok: false, reason: params.get('error_description') ?? error }
  }

  // ★ 参数名不一定是 `code` —— 智谱那条回的是 `authCode`(2026-09-09 实测)
  const code = params.get(codeParam)
  if (code === null || code === '') {
    return { ok: false, reason: '这段内容里没有授权码，请把浏览器地址栏里完整的回调地址复制过来' }
  }
  if (!stateMatches(expectedState, params.get('state'))) {
    return { ok: false, reason: 'state 不匹配，请重新发起登录（不要使用旧的回调地址）' }
  }
  return { ok: true, code }
}

async function collectCode(
  deps: OAuthFlowDeps,
  endpoint: string,
  args: { challenge: string; state: string; redirectUri: string }
): Promise<string> {
  await deps.openBrowser(authorizeUrl(deps.spec, endpoint, args))
  deps.onPhase?.('waiting')
  const awaitPastedCode = deps.awaitPastedCode
  if (awaitPastedCode === undefined) {
    throw new OAuthFailedError('这家需要手动粘贴授权码，但没有提供输入通道')
  }
  const pasted = await awaitPasteWithDeadline(awaitPastedCode, deps.signal)
  // 空输入 = 用户在输入框里点了确定但没填,按放弃处理(和关掉授权页同一个结局)
  if (pasted.trim() === '') throw new OAuthAbandonedError('cancelled')

  const parsed = pastedCallbackCode(pasted, args.state, deps.spec.callbackCodeParam)
  if (!parsed.ok) throw new OAuthFailedError(parsed.reason)
  return parsed.code
}

function describe(result: LoopbackResult): never {
  if (result.status === 'cancelled' || result.status === 'timeout') {
    throw new OAuthAbandonedError(result.status)
  }
  throw new OAuthFailedError(result.reason ?? '授权未完成')
}

/**
 * 授权码流程:开浏览器 → 收 code → 换 token。**返回 token 端点原样的 JSON。**
 *
 * ★ 整段是从原来的 `runOAuthFlow` 里**原封不动**搬进来的,只多了一个 `grant`
 * 参数(端点和回调策略从它读,不再从 spec 顶层读)。ChatGPT / Z.AI / 智谱
 * 那三条路径的行为一个字节都没变。
 */
async function runAuthorizationCodeFlow(
  deps: OAuthFlowDeps,
  grant: Extract<OAuthGrant, { kind: 'authorization-code' }>
): Promise<unknown> {
  const { spec, signal } = deps
  const pkce = createPkce()
  const state = randomState()

  let code: string
  /*
    ★★ redirect_uri 在**授权请求**和**换 token 请求**里必须逐字相同 —— 服务端会
    比对这两处,不一致就是一个不说明原因的 `invalid_grant`。所以它只算一次,
    算完两处都用这一个变量,而不是各拼一遍。
  */
  let redirectUri = redirectUriOf(grant.redirect)

  deps.onPhase?.('opening')

  if (grant.redirect.kind === 'manual-paste') {
    code = await collectCode(deps, grant.authorizeUrl, {
      challenge: pkce.challenge,
      state,
      redirectUri
    })
  } else {
    /*
      ★★ **先把服务器起起来,再打开浏览器。** 反过来有一个真实的竞态:
      用户的浏览器可能已经缓存了授权同意,授权页一闪而过就打回来 —— 而那时
      我们还没 listen,回调撞上 ECONNREFUSED。用户看到一个连不上的错误页,
      而应用这边还停在「等待授权」。所以打开浏览器这一步挂在 `onListening` 上。
    */
    let opened = false
    /**
     * ★ 打不开浏览器必须**当场结束等待**,不能让它干等到 5 分钟超时。
     * 没有这个的话,`openExternal` 失败(没有默认浏览器、被策略禁掉)的表现是
     * 界面转五分钟然后说「授权超时」—— 一句和真实原因毫无关系的话。
     */
    let openError: unknown = null
    const inner = new AbortController()
    const forward = (): void => inner.abort()
    signal.addEventListener('abort', forward, { once: true })

    const redirect = grant.redirect
    const fixedPort = redirect.kind === 'loopback-fixed' ? redirect.port : 0

    let result: LoopbackResult
    try {
      result = await awaitOAuthCallback({
        expectedState: state,
        signal: inner.signal,
        path: redirect.path,
        port: fixedPort,
        // ★ 省略即 `code`,所以 ChatGPT / Z.AI 那两条的行为一个字都没变
        codeParam: spec.callbackCodeParam,
        onListening: (bound) => {
          if (opened) return
          opened = true
          redirectUri = redirectUriOf(redirect, bound)
          /*
            ★ `waiting` 在**发起**打开浏览器时就推,不挂在 `openBrowser().then()` 上。
            挂上去的话,浏览器缓存了授权同意时回调会先回来,于是阶段倒着走 ——
            界面先显示「完成」再跳回「等待授权中」并卡在那儿。
          */
          deps.onPhase?.('waiting')
          void deps
            .openBrowser(
              authorizeUrl(spec, grant.authorizeUrl, {
                challenge: pkce.challenge,
                state,
                redirectUri
              })
            )
            .catch((e: unknown) => {
              openError = e
              inner.abort()
            })
        }
      })
    } finally {
      signal.removeEventListener('abort', forward)
    }

    if (openError !== null) {
      const detail = openError instanceof Error ? openError.message : String(openError)
      throw new OAuthFailedError(`打不开浏览器：${detail}`)
    }
    // 外层 signal 被取消时,内层也 abort 了 —— 两者都归到「用户放弃」
    if (result.status !== 'ok' || result.code === undefined) describe(result)
    code = result.code
  }

  deps.onPhase?.('exchanging')
  const args: OAuthTokenRequestArgs = {
    code,
    redirectUri,
    verifier: pkce.verifier,
    state,
    clientId: spec.clientId
  }
  const token = await postToken(
    spec,
    deps.fetch,
    spec.tokenRequest?.(args) ?? defaultTokenRequest(args),
    signal
  )
  if (!token.ok) {
    throw new OAuthFailedError(`换取凭证失败（HTTP ${token.status}）：${token.body.slice(0, 300)}`)
  }
  return token.json
}

/* ======================= 设备码流程(RFC 8628) ======================= */

/**
 * 上游没给 `expires_in` 时的本地兜底。
 *
 * ★ 它不是「规范推荐值」—— RFC 8628 没规定默认时长。取 15 分钟是因为这条流程
 * 要用户切到浏览器、登录、输一串码,五分钟(粘贴那条的时长)偏紧;而更长的话,
 * 一个**服务端早就作废了 device_code** 的会话会在界面上一直转。
 * Kimi 实际会给 1800 秒,所以这个值在它身上根本用不到。
 */
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60_000

/**
 * 收到 `slow_down` 时轮询间隔的**永久**增量。
 *
 * ★★ RFC 8628 §3.5 的原话是「每收到一次就把间隔增加 5 秒」,而且**是累加、不回退**。
 * 写成「这一次多等 5 秒」的表现是:上游一直回 slow_down、我们一直以原速度撞上去,
 * 最坏情况是被限流到整个登录失败,而错误信息只会说一句 `slow_down`。
 */
const SLOW_DOWN_BUMP_MS = 5_000

/** 可被取消打断的 sleep。轮询等待期间用户点「取消」要立刻收敛,不能等满一个间隔 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthAbandonedError('cancelled'))
      return
    }
    /* ★ onAbort 只会在 setTimeout 之后被触发,所以闭包里引用 `timer` 不会撞上 TDZ */
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OAuthAbandonedError('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 表单 POST,**成功失败都把 JSON 解出来**。
 *
 * ★★ 不能复用 `postToken`:那个在非 2xx 时只回一段原文。而设备码轮询的正常状态
 * (`authorization_pending`)**本身就是一个 400** —— 错误码在 body 的 `error` 字段里。
 * 拿不到解析后的 body,就分不清「用户还没点同意」和「device_code 已失效」,
 * 而那两者一个该继续等、一个该当场报错。
 */
async function postFormJson(
  deps: OAuthFlowDeps,
  url: string,
  body: Readonly<Record<string, string>>
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(deps.spec.oauthHeaders ?? {})
    },
    body: new URLSearchParams(body).toString(),
    signal: deps.signal
  })
  const text = await res.text()
  let json: unknown = undefined
  try {
    json = JSON.parse(text)
  } catch {
    // 保持 undefined —— 调用方据此判「响应不是 JSON」
  }
  return { status: res.status, json, text }
}

/** RFC 8628 §3.2:申请设备码 */
async function requestDeviceAuthorization(
  deps: OAuthFlowDeps,
  grant: Extract<OAuthGrant, { kind: 'device-code' }>
): Promise<{
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresInMs: number
  intervalMs: number
}> {
  const res = await postFormJson(deps, grant.deviceAuthorizationUrl, {
    client_id: deps.spec.clientId,
    /*
      ★★ RFC 8628 §3.1 里 `scope` 是可选的,但**「可选」不等于「可以不发」** ——
      它决定的是换回来那把 access_token 带着哪些权限。xAI 那条 2026-09-14 实测:
      只发 `client_id` 照样 **200**,配对码、verification_uri 一应俱全;但那把令牌
      不带 `grok-cli:access`,于是表现是**登录一路成功、第一条消息 401**,
      而错误信息里一个字都不提 scope。(同一端点发一个不存在的 scope 回的是
      400 `invalid_scope`,说明它是真校验的,不是照单全收。)

      ★ 没声明 scope 的家(Kimi)这里**一个字都不写**,而不是写成空串 ——
      和 `authorizeUrl` 里那条是同一个理由。它那条路径的请求逐字节不变。
    */
    ...(deps.spec.scope === undefined ? {} : { scope: deps.spec.scope })
  })
  if (res.status < 200 || res.status >= 300) {
    throw new OAuthFailedError(`申请设备码失败（HTTP ${res.status}）：${res.text.slice(0, 300)}`)
  }
  const body = record(res.json)
  const deviceCode = str(body?.['device_code'])
  const userCode = str(body?.['user_code'])
  const verificationUri = str(body?.['verification_uri'])
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new OAuthFailedError('申请设备码失败：响应里缺少 device_code / user_code / verification_uri')
  }
  const expiresIn = body?.['expires_in']
  const interval = body?.['interval']
  return {
    deviceCode,
    userCode,
    verificationUri,
    // ★ 带码的那个链接可以省(RFC 里是可选的),省了就退回到不带码的页面 ——
    //   用户得自己抄一遍 user_code,能用,只是麻烦
    verificationUriComplete: str(body?.['verification_uri_complete']) ?? verificationUri,
    expiresInMs:
      typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn * 1000 : DEVICE_FLOW_TIMEOUT_MS,
    // ★ RFC 8628 §3.2:`interval` 省略时的默认值就是 5 秒,不是 0
    intervalMs: (typeof interval === 'number' && interval > 0 ? interval : 5) * 1000
  }
}

/**
 * 设备码流程:申请码 → 把码显示给用户 → 按 `interval` 轮询 token 端点。
 *
 * ★★ **这里没有 state、没有 PKCE、没有 redirect_uri。** 不是「省略了」,是 RFC 8628
 * 这条路上根本不存在这些东西 —— 防重放靠的是 device_code 本身只能兑换一次、且有
 * 服务端过期时间。硬塞一个 state 进去的话,上游会把它当未知参数忽略,而读代码的人
 * 会以为这里有一层并不存在的防护。
 */
async function runDeviceCodeFlow(
  deps: OAuthFlowDeps,
  grant: Extract<OAuthGrant, { kind: 'device-code' }>
): Promise<unknown> {
  deps.onPhase?.('opening')
  const device = await requestDeviceAuthorization(deps, grant)

  /*
    ★★ 配对码要在**开浏览器之前**推给界面。反过来的话,浏览器抢焦点的那一瞬间
    用户看到的是一个还没有码的空面板;而如果浏览器压根打不开,他连码都看不到。
  */
  deps.onPhase?.('waiting', {
    userCode: device.userCode,
    verificationUri: device.verificationUri
  })

  /*
    ★★ **打不开浏览器在这条路径上不致命** —— 和回环那条正相反(那边打不开就
    彻底没戏,因为 code 只会回到回调地址)。这里用户手上有配对码和地址,完全可以
    自己开一个浏览器输进去。所以这里只吞掉错误继续轮询,而不是中止登录。
  */
  await deps.openBrowser(device.verificationUriComplete).catch(() => undefined)

  const deadline = deps.now() + Math.min(device.expiresInMs, grant.timeoutMs ?? device.expiresInMs)
  let intervalMs = device.intervalMs

  for (;;) {
    await sleep(intervalMs, deps.signal)
    if (deps.now() >= deadline) throw new OAuthAbandonedError('timeout')

    const res = await postFormJson(deps, deps.spec.tokenUrl, {
      client_id: deps.spec.clientId,
      device_code: device.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })

    /*
      ★ 5xx 当**故障**处理而不是继续轮询:上游挂了的话再轮十五分钟也没用,
      而用户看着一个转圈的界面完全不知道发生了什么。kimi-code 自己也是这么做的。
    */
    if (res.status >= 500) {
      throw new OAuthFailedError(`等待授权失败（HTTP ${res.status}）：${res.text.slice(0, 300)}`)
    }
    if (res.status >= 200 && res.status < 300) {
      deps.onPhase?.('exchanging')
      return res.json
    }

    const error = str(record(res.json)?.['error'])
    switch (error) {
      case 'authorization_pending':
        // 用户还没点同意 —— 这是**正常状态**,不是错误
        continue
      case 'slow_down':
        intervalMs += SLOW_DOWN_BUMP_MS
        continue
      case 'expired_token':
        // 配对码过期 = 用户没在时限内完成,和超时是同一件事(不报红)
        throw new OAuthAbandonedError('timeout')
      case 'access_denied':
        throw new OAuthAbandonedError('cancelled')
      default: {
        const detail = error ?? res.text.slice(0, 300)
        throw new OAuthFailedError(`等待授权失败（HTTP ${res.status}）：${detail}`)
      }
    }
  }
}

export async function runOAuthFlow(deps: OAuthFlowDeps): Promise<OAuthCredential> {
  const { spec } = deps
  /*
    ★★ 两种授权方式在这里分岔,而且**只在这里分岔**:再往下(第二跳、身份提取、
    凭证落盘)两条路完全一样。switch 挂在一个联合类型上,于是将来加第三种授权方式时
    编译器会在这里报错,而不是让它在运行期走进 else。
  */
  const token =
    spec.grant.kind === 'device-code'
      ? await runDeviceCodeFlow(deps, spec.grant)
      : await runAuthorizationCodeFlow(deps, spec.grant)

  /*
    ★ 第二跳(有的家 token 端点给的还不是能发请求的令牌)。缺省是恒等,
    所以 ChatGPT 那条路径走到这里等于什么都没发生。
  */
  const exchanged =
    spec.finishExchange === undefined
      ? token
      : await spec.finishExchange(token, {
          fetch: deps.fetch,
          signal: deps.signal,
          now: deps.now()
        })

  const identity = spec.identity(exchanged, deps.now())
  if (identity === null) {
    throw new OAuthFailedError('授权信息不完整（缺少账号 id 或令牌），请重试登录')
  }

  deps.onPhase?.('done')
  return {
    kind: 'oauth',
    issuer: spec.id,
    accessToken: identity.accessToken,
    refreshToken: identity.refreshToken,
    expiresAt: identity.expiresAt,
    accountId: identity.accountId,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.planType === undefined ? {} : { planType: identity.planType }),
    refreshedAt: deps.now()
  }
}
