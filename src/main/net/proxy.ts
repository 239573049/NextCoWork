/**
 * 让「设置 › 连接 › 网络」那一页**真的作用于出站请求**。
 *
 * ## 在这之前它什么也不做
 *
 * `host/index.ts` 的表格里曾经写着「设置页的代理对模型请求生效,靠的就是
 * `net.fetch`」—— 那句话是错的,并且错得很隐蔽:`net.fetch` 确实走 Chromium
 * 网络栈,可 Chromium 默认跟随的是**系统**代理,从来没有人把 `settings.proxy`
 * 交给它。用户在设置页填了地址、开了开关,请求照旧直连,而界面上一切正常。
 * 这个文件是那句注释的兑现。
 *
 * ## ★★ 「关闭」曾经比「什么都不做」更糟
 *
 * 兑现那句注释的第一版有个反向的错:`proxyConfigFor` 在开关关着时返回
 * `{ mode: 'direct' }`。而上一段刚说过 —— Chromium **默认就跟随系统代理**。
 * 于是那一版做的事情是:把「用户没开这个开关」翻译成「用户要求无视系统代理」,
 * 主动关掉了一个本来好好的默认行为。
 *
 * 症状离原因非常远:开箱即用状态下每一个出站请求都绕过系统代理,而设置页上
 * 那个开关关着、界面一切正常。实测撞到的是换取 OAuth 凭证时的
 * `HTTP 403 unsupported_country_region_territory` —— 一句完全不提代理的话。
 *
 * 现在「关闭」= `{ mode: 'system' }`,理由与「开了但地址没填完仍走直连」的
 * 例外都写在 `shared/domain/proxy.ts` 的 `proxyConfigFor` 上。
 *
 * ## 为什么一次 `setProxy` 就够
 *
 * 全应用的出站请求只有一条路:`KernelHost.fetch` → `net.fetch` → `defaultSession`。
 * 模型请求、MCP 的 http/sse 传输、六家搜索适配器,全都从那里出去
 * (`search/types.ts` 文件头的第一条铁律就是「HTTP 一律走 deps.fetch」)。
 * 所以设置 `defaultSession` 一处,三者一起跟着走 —— 不需要逐个子系统去接。
 *
 * **例外:MCP 的 stdio 传输不受此约束。** 那是子进程,它自己怎么联网由它自己
 * (和它继承到的环境变量)决定,Chromium 的代理设置管不到。这不是疏漏,是边界。
 */
import { app, session } from 'electron'
import type { ProxyPasswordInfo, ProxySettings } from '../../shared/domain/proxy'
import { composeProxyUrl, proxyConfigFor } from '../../shared/domain/proxy'
import { removeCredential } from '../db/repo'
import { getHost } from '../runtime'

/** 代理密码在密钥环里的 ref。**只有这个文件读它**,没有任何 IPC 频道能取回明文。 */
export const PROXY_PASSWORD_REF = 'proxy:password'

/** 最近一次生效的配置 —— `app.on('login')` 要用它取用户名,以及判断认证开没开 */
let current: ProxySettings | null = null

/**
 * 这一套凭证试过没有。
 *
 * ★ **失败不重试第二次。** Chromium 在代理拒绝之后会再调一次这个回调,
 * 密码错的话就成了一个无限循环 —— 而不少企业代理接在 AD 上,连错几次
 * 会把**账号**锁掉。用户为此付出的代价远大于「多试一次万一成功了」。
 * 所以第二次直接 `cb()`(等于放弃认证),让请求以 407 失败,用户看得见。
 *
 * 存的是「上一次交出去的那把钥匙」的标识,`applyProxy` 换配置时清空:
 * 改了地址或用户名意味着这是一套新凭证,值得再试一次。
 */
let triedKey: string | null = null

function credentialKey(p: ProxySettings): string {
  return `${composeProxyUrl(p)}|${p.authUser}`
}

/**
 * 把设置推给 Chromium。**每次代理设置变化都要调一次**,包括改回「关闭」——
 * 只在开启时调的话,关掉开关之后上一次的 `proxyRules` 还留在 session 上,
 * 表现是「我关了代理,它还在走代理」。
 */
export async function applyProxy(p: ProxySettings): Promise<void> {
  current = p
  // 换了一套配置 = 换了一套凭证,上面那个「只试一次」的闸重新开一次
  triedKey = null

  const cfg = proxyConfigFor(p)
  await session.defaultSession.setProxy(cfg)
  /*
    ★ 已经建立的连接不受新代理设置影响 —— Chromium 的连接池会把它们复用下去。
    不清的话,改完代理之后正在进行的那一轮对话仍旧走老路径,而用户以为已经切了。
  */
  session.defaultSession.closeAllConnections()

  getHost().logger.info(
    `[proxy] ${
      !p.enabled || p.mode === 'system'
        ? '跟随系统'
        : (cfg.proxyRules ?? '(地址没填完,按直连处理)')
    }`
  )
}

/**
 * 装上代理认证的应答。**只在 app ready 之后调一次**(`main/index.ts`)。
 *
 * 这个回调是全局的,`event.preventDefault()` 之后 Electron 就不会再弹它自己那个
 * 系统登录框了 —— 所以 `authInfo.isProxy` 那一判必须在最前面:网站自己的
 * 401 Basic 认证也会走同一个事件,吞掉它等于让所有需要登录的网页静默失败。
 */
export function installProxyAuth(): void {
  app.on('login', (event, _webContents, _request, authInfo, callback) => {
    if (!authInfo.isProxy) return
    const p = current
    if (p === null || !p.enabled || p.mode !== 'manual' || !p.authEnabled) return

    event.preventDefault()

    const key = credentialKey(p)
    if (triedKey === key) {
      // 上面那把锁:这套凭证已经被拒过一次了,不再送第二次
      getHost().logger.warn('[proxy] 代理认证被拒,不再重试(避免账号被锁)')
      callback()
      return
    }
    triedKey = key

    void getHost()
      .secrets.get(PROXY_PASSWORD_REF)
      .then((password) => {
        callback(p.authUser, password ?? '')
      })
      .catch((err: unknown) => {
        // 密钥环读不出来 —— 放弃认证而不是卡住,请求会以 407 失败,用户看得见
        getHost().logger.error('[proxy] 读取代理密码失败', err)
        callback()
      })
  })
}

/**
 * 「保存密码」。写完**立刻重推一次配置** —— 不推的话,新密码要等到下次
 * 改代理设置或者重启才被 `app.on('login')` 用上,而用户刚点完保存就会去
 * 试一次请求,看到的还是旧密码那次失败。顺带把「只试一次」的闸重新开一次。
 */
export async function setProxyPassword(password: string): Promise<ProxyPasswordInfo> {
  const host = getHost()
  const trimmed = password.trim()
  if (trimmed === '') throw new Error('密码不能是空的。要清除请用「清除」。')

  await host.secrets.set(PROXY_PASSWORD_REF, trimmed)
  triedKey = null
  return { hasKey: true, encryptionAvailable: host.secrets.available() }
}

export async function clearProxyPassword(): Promise<ProxyPasswordInfo> {
  removeCredential(PROXY_PASSWORD_REF)
  triedKey = null
  return { hasKey: false, encryptionAvailable: getHost().secrets.available() }
}

/** ★ 只回「有没有」,回不了「是什么」—— 没有任何一条频道能把明文取出去 */
export async function getProxyPasswordInfo(): Promise<ProxyPasswordInfo> {
  const host = getHost()
  const v = await host.secrets.get(PROXY_PASSWORD_REF)
  return { hasKey: v !== null && v !== '', encryptionAvailable: host.secrets.available() }
}
