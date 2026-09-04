/**
 * 「网络」那一页的表单纯逻辑。
 *
 * ★ **原来的 `normalizeProxyUrl` 已经删掉了。** 它做的事现在由
 * `shared/domain/proxy.ts` 的 `parseProxyEndpoint` 做 —— 那边必须有一份
 * (主进程拼 `proxyRules` 要用),这边再留一份就是两个解析器,而两个解析器
 * 迟早会对同一个输入给出不同答案。搬过去还顺带修了一个真 bug:
 * 协议默认端口(`https://proxy:443`)在旧实现里被判成不合法。
 *
 * 留在这个文件里的,是**只有表单需要**的那部分:逐字段的报错、把粘贴进来的
 * 整条地址拆开、以及白名单那句计数。
 */
import type { ProxySettings } from '../../../shared/domain/proxy'
import {
  DIRECT_BYPASS,
  normalizeBypassList,
  parseProxyEndpoint
} from '../../../shared/domain/proxy'

/** 逐字段的报错。key 是字段名,界面据此在那一栏下面标红 */
export type ProxyFormErrors = Partial<Record<'host' | 'port' | 'authUser', string>>

/**
 * 校验。★ **只在 `enabled && mode === 'manual'` 时才校验三段地址** ——
 * 关掉代理之后还红着一片,用户会以为自己关不掉。
 */
export function validateProxyForm(p: ProxySettings): ProxyFormErrors {
  const e: ProxyFormErrors = {}
  if (!p.enabled || p.mode !== 'manual') return e

  if (p.host.trim() === '') e.host = '要填代理服务器地址'
  if (p.port !== 0 && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535))
    e.port = '端口要在 1–65535 之间'
  if (p.authEnabled && p.authUser.trim() === '') e.authUser = '开了认证就要填用户名'

  return e
}

export function hasProxyErrors(e: ProxyFormErrors): boolean {
  return Object.keys(e).length > 0
}

/**
 * 端口输入框:字符串 → 数字。`0` = 没填(交给协议默认端口)。
 *
 * 打不出数字的输入返回 `null`,调用点据此**保持原值不动**,而不是清成 0 ——
 * 边打字边写回的话,用户删到只剩一位数时端口就已经变成别的了。
 */
export function parsePortInput(input: string): number | null {
  const raw = input.trim()
  if (raw === '') return 0
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 0 && n <= 65535 ? n : null
}

/**
 * 往「地址」那一栏里粘了一整条 `socks5://127.0.0.1:1080` 时,把它拆到三段上。
 *
 * ★ 这不是宽容,是**必然会发生**:各家代理软件在自己界面上显示的就是一整条,
 * 用户复制的也是一整条。不拆的话 host 里会留着 `socks5://127.0.0.1:1080`,
 * 拼出来的 `proxyRules` 是 `http://socks5://127.0.0.1:1080` —— 而这条烂规则
 * Chromium 是静默忽略的,表现为「我明明填了代理,它却直连」。
 *
 * 只有当输入**确实带协议或端口**时才拆;单纯打了个 `proxy.corp.com` 不动它,
 * 免得用户还没打完就被改。
 */
export function splitPastedAddress(
  input: string
): Pick<ProxySettings, 'scheme' | 'host' | 'port'> | null {
  const raw = input.trim()
  if (!/:\/\//.test(raw) && !/:\d+$/.test(raw)) return null
  const ep = parseProxyEndpoint(raw)
  return ep === null ? null : { scheme: ep.scheme, host: ep.host, port: ep.port }
}

/**
 * 白名单那句说明的两个数字。参考图上写的是「已自动添加 N 个直连域名」——
 * ★ N **由 `DIRECT_BYPASS` 的长度算出来**,不写死:写死的数字和表分叉时,
 * 没有任何机制会报警,而界面会一直理直气壮地报一个错数。
 */
export interface BypassSummary {
  /** 用户自己填的条数(去重后) */
  userCount: number
  /** 内置直连表的条数 */
  builtinCount: number
}

export function bypassSummary(bypass: string): BypassSummary {
  return {
    userCount: normalizeBypassList(bypass).length,
    builtinCount: DIRECT_BYPASS.length
  }
}
