/**
 * 代理设置的形状与全部纯逻辑。
 *
 * 单独成文件而不是塞进 `settings.ts`,是因为**三边都要用它**:
 * `settings.ts` 要类型和迁移函数、`main/net/proxy.ts` 要拼 Electron 的
 * `proxyRules` / `proxyBypassRules`、渲染层的表单要解析用户打进来的那一行。
 * 放在 settings 里会让 settings ⇄ proxy 变成一个循环 import。
 *
 * ## 为什么是「协议 / 地址 / 端口」三段拆开,而不是一个 url 字符串
 *
 * 旧字段是 `proxy.url`,一个框全填。参考实现拆成三个,这不是审美 ——
 * `socks5://user@host` 这种半截输入在单框里没法给出有意义的报错,
 * 而拆开之后每一段的合法性是独立可判的。旧库里存的 `url` 由
 * `migrateLegacyProxy` 拆开,**只在字段缺失时才生效**,不会覆盖用户新填的值。
 */

export const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks4'] as const
export type ProxyScheme = (typeof PROXY_SCHEMES)[number]

export interface ProxySettings {
  enabled: boolean
  /** `system` = 跟随系统代理(Electron 的 mode:'system');`manual` = 用下面三段 */
  mode: 'system' | 'manual'
  scheme: ProxyScheme
  host: string
  /** 0 = 没填 */
  port: number
  authEnabled: boolean
  authUser: string
  /**
   * 用户填的直连白名单,一行一条(界面是多行框)。**内置那张表不存在这里** ——
   * 存进去的话用户删掉一条,下次启动又会被塞回来,看起来像 bug。
   */
  bypass: string
}

export const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  mode: 'system',
  scheme: 'http',
  host: '',
  port: 0,
  authEnabled: false,
  authUser: '',
  bypass: ''
}

/**
 * 内置直连表。参考图上那句「已自动添加 N 个直连域名」的 N **由这张表的长度算出来**,
 * 不写死 —— 写死的数字和表分叉时没有任何机制会报警。
 *
 * 收录判据只有一条:**走代理反而会坏**。回环与私有网段(本地网关、局域网服务、
 * 本仓库自己的 `127.0.0.1:19836`)是显然的;域名那几条是国内服务,
 * 从境内经境外代理绕一圈只会更慢,而且不少会因为出口 IP 变化被风控。
 */
export const DIRECT_BYPASS: readonly string[] = [
  // 回环与本机
  'localhost',
  '127.0.0.1',
  '::1',
  '<local>',
  // 私有网段(RFC 1918)与链路本地
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
  // 国内大模型 / 云厂商:走代理只会更慢,出口 IP 变化还容易被风控
  '*.aliyuncs.com',
  '*.aliyun.com',
  '*.dashscope.aliyuncs.com',
  '*.volces.com',
  '*.volcengine.com',
  '*.bigmodel.cn',
  '*.moonshot.cn',
  '*.deepseek.com',
  '*.baidu.com',
  '*.bce.baidu.com',
  '*.tencent.com',
  '*.tencentcloudapi.com',
  '*.myqcloud.com',
  '*.huaweicloud.com',
  '*.metaso.cn',
  '*.qq.com',
  '*.163.com',
  '*.cn'
]

/**
 * 多行/逗号/分号混着填都认,去空白、去重、保序。
 *
 * 保序而不是排序:用户是按自己的心智顺序写的,重排之后再打开设置页会觉得
 * 「它把我写的东西弄乱了」。去重是必要的,重复条目对 Chromium 无害但会让
 * 「已添加 N 条」这个计数骗人。
 */
export function normalizeBypassList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\n,;]+/)) {
    const s = part.trim()
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * Chromium 的 `proxyBypassRules` —— 分号分隔。用户填的在前,内置的在后:
 * 规则是「命中任意一条即直连」,顺序不影响语义,但影响用户在预览里
 * 一眼能不能看见自己刚填的那条。
 */
export function proxyBypassRules(p: ProxySettings): string {
  return [...normalizeBypassList(p.bypass), ...DIRECT_BYPASS].join(';')
}

/** `scheme://host:port`;`port` 为 0 时省略端口,交给协议默认值 */
export function composeProxyUrl(p: Pick<ProxySettings, 'scheme' | 'host' | 'port'>): string {
  if (p.host.trim() === '') return ''
  return p.port > 0 ? `${p.scheme}://${p.host}:${p.port}` : `${p.scheme}://${p.host}`
}

/**
 * Electron `session.setProxy()` 那个入参的形状。**这里重新声明一遍而不是
 * import electron 的类型** —— 这个文件要能在 node 环境的单测里被直接 import,
 * 而拼规则串正是代理这块最容易写错、也最值得穷举的一段。
 */
export interface ProxyRuleConfig {
  mode?: 'direct' | 'system'
  proxyRules?: string
  proxyBypassRules?: string
}

/**
 * 三种状态 → Chromium 的三种配置。
 *
 * ★★ **「关闭」是 `system`,不是 `direct`。这条曾经反了,而且反得很贵。**
 *
 * `mode: 'direct'` 不是「没有配置代理」,它是一个**主动要求**:绕过操作系统那份
 * 设置去直连。而 Chromium 在**没人调 `setProxy`** 时的原生行为本来就是跟随系统 ——
 * 也就是说,过去那行 `if (!p.enabled) return { mode: 'direct' }` 把「用户没开这个
 * 开关」翻译成了「用户要求无视系统代理」,比什么都不做更强硬。
 *
 * 代价是具体的:开箱即用状态下,**每一个**出站请求都绕过系统代理。在需要靠系统
 * 代理才能连通上游的网络环境里,表现是一个和代理毫无关联的错误 ——
 * 实测撞到的是换取 OAuth 凭证时的 `HTTP 403 unsupported_country_region_territory`,
 * 而设置页上「启用代理」那个开关关着,看起来完全正常。
 *
 * ★ 于是「开 + 跟随系统」和「关闭」现在是同一个结果。这是**对的**:那个开关的
 * 含义变成了「我要自己指定代理」,而不指定时本来就该交回给系统。
 *
 * ★ **「开了但地址没填完」仍然走直连。** 这一条以前的理由是「直连至少和关掉代理
 * 是同一个可观察行为」—— 那句话随着上面的改动**已经不成立了**,但结论还成立,
 * 靠的是另一条理由:用户明确选了「手动」,此时静默退回系统代理,会让他在
 * 「我明明填了自定义代理」的同时走着另一条完全不同的线路,而界面上两种情况
 * 长得一模一样。半截配置就该是**明显坏掉**的,而不是悄悄换一条路。
 * (真正该拦住它的是表单校验,不是这里。)
 */
export function proxyConfigFor(p: ProxySettings): ProxyRuleConfig {
  if (!p.enabled) return { mode: 'system' }
  if (p.mode === 'system') return { mode: 'system' }

  const url = composeProxyUrl(p)
  if (url === '') return { mode: 'direct' }

  /*
    单个 `scheme://host:port` 对所有协议生效,这正是我们要的 ——
    参考图上那一栏就是一个协议选择器加一个地址,不是「按目标协议分别配置」。
  */
  return { proxyRules: url, proxyBypassRules: proxyBypassRules(p) }
}

export interface ProxyEndpoint {
  scheme: ProxyScheme
  host: string
  port: number
}

/**
 * 把用户打进来的一行拆成三段。`null` = 不合法。
 *
 * ★ **缺协议时补 `http://` 而不是拒绝。** 用户十有八九只会打 `127.0.0.1:7890` ——
 * 那正是各家代理软件在自己界面上显示的样子。判它不合法,用户会以为是自己打错了。
 * (这一条是从原来的 `normalizeProxyUrl` 搬过来的,连同它的理由。)
 */
export function parseProxyEndpoint(input: string): ProxyEndpoint | null {
  const raw = input.trim()
  if (raw === '') return null

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  if (!(PROXY_SCHEMES as readonly string[]).includes(scheme)) return null
  if (url.hostname === '') return null

  /*
    端口不能只信 `url.port` —— 它在**两种完全相反的情况下都是空串**:

    1. `127.0.0.1:99999` 越界,`URL` 把它当路径吞了,用户的意图静悄悄没了;
    2. `https://a.b.c:443` 合法,`URL` 只是把协议默认端口规范化掉了。

    只判「空串 + 原文以 `:数字` 结尾 ⇒ 不合法」的话,第 2 种会被误杀 ——
    而 443 / 80 上的企业代理是很常见的一种部署。所以从原文里把那串数字
    自己取出来判范围,让两种情况分开。
  */
  const trailing = /:(\d+)$/.exec(raw)
  const written = url.port !== '' ? url.port : trailing?.[1]
  // `written === undefined` 才是「没写端口」。写了 `:0` 是写了,而且不合法 ——
  // 用 `port === 0` 当哨兵会把这两件事混成一件。
  let port = 0
  if (written !== undefined) {
    port = Number(written)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  }

  // IPv6 字面量带方括号,原样保留 —— 去掉之后拼回 url 就不合法了
  return { scheme: scheme as ProxyScheme, host: url.hostname, port }
}

/**
 * 旧库迁移:`proxy.url` → `scheme` / `host` / `port` + `mode: 'manual'`。
 *
 * ★ **只在新字段缺失时才动。** 这个函数的调用点是 `mergeSettings`,而
 * `mergeSettings` 同时承担「读库时铺默认值」和「处理一次 patch」两件事 ——
 * 后者的 patch 里带着用户刚在表单上改的 host,要是被一条陈年 url 盖回去,
 * 表现就是「我改了地址,一松手它又变回来了」。
 *
 * 解析不出来就只丢掉那条 url(返回不带三段的补丁),不整个拒绝:
 * 一条存坏的旧值不该让其余设置也读不出来。
 */
export function migrateLegacyProxy(patch: Partial<ProxySettings>): Partial<ProxySettings> {
  const legacyUrl = (patch as { url?: unknown }).url
  if (typeof legacyUrl !== 'string' || legacyUrl.trim() === '') return patch
  if (patch.host !== undefined || patch.mode !== undefined) return patch

  const ep = parseProxyEndpoint(legacyUrl)
  if (ep === null) return patch
  return { ...patch, mode: 'manual', scheme: ep.scheme, host: ep.host, port: ep.port }
}

/**
 * `proxy:*` 那三条频道的回程。
 *
 * ★ **刻意没有 `last4`**,和 `CredentialInfo` 不一样。末四位存在的意义是
 * 让用户在好几把 Key 里认出「这是哪一把」;代理密码只有一把,认不认得出
 * 没有区别,而四个字符是实打实地漏出去了。
 */
export interface ProxyPasswordInfo {
  hasKey: boolean
  /** Linux 无 keyring 时为 false —— 界面据此显示横幅,而不是假装存上了 */
  encryptionAvailable: boolean
}
