/**
 * 内置免 Key 源的第一层:向一个 SearxNG 实例要 JSON 结果。
 *
 * 需求:用户没配任何搜索服务时也要能真的搜到东西。SearxNG 是唯一免 Key 又返回
 * 结构化 JSON 的公开选项,所以它排在「直抓 SERP HTML」之前 —— JSON 不会因为
 * 页面改版而静默变成零结果。
 *
 * ## 失败就抛
 *
 * 与 `search/types.ts` 里那条分工同款:非 2xx、不是 JSON、解析后零条目,一律抛。
 * 上层(`index.ts`)据此换下一个候选实例。**不在这里重试** —— 一次搜索里对同一个
 * 限流的实例重试,只会把延迟翻倍。
 *
 * ## ★ 唯一一处放宽 SSRF 的地方
 *
 * `allowPrivate` 为真时**跳过地址筛查**,于是 `http://localhost:8080` 这类
 * 自建实例能用。这是本模块唯一一处破坏「网络工具只许访问公网」这条不变式的地方,
 * 三条约束缺一不可:
 *
 * 1. 只有 `settings.builtinSearch.searxngUrl` ——**用户在设置页亲手输入的那个值**——
 *    才会带着 `allowPrivate: true` 进来。模型、网页、Skill、MCP 都碰不到这个值。
 *    SSRF 防的是「模型被投毒后去请求内网地址」,而这里的地址来自用户自己。
 *    `WebFetch` / `browser_*` 的闸一律不动。
 * 2. 内置公共实例(`instances.ts` 里的常量)**照常过闸**。它们是代码里的字面量,
 *    但万一哪次改错成内网地址,这道闸还在。
 * 3. `redirect: 'manual'`,**不跟随跳转**;响应只按 JSON 解析。于是即便那个地址
 *    指向内网的某个别的服务,暴露面也仅限于「查询词发过去了 + 响应必须恰好是
 *    搜索结果形状的 JSON 才会被采用」。
 *
 * 如实记下代价:用户把地址填错成内网另一个服务时,查询词会发给它。
 * 这是用户自己输入地址的后果,和「模型构造地址」是两件事。
 */
import type { HarvestedItem } from '../harvest'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { ssrfRisk } from '../../kernel/tool/builtin/ssrf'

/** 错误信息里带多少响应正文。够看清 `{"error":…}`,又不至于把一整页 HTML 倒进去 */
const ERROR_BODY_CHARS = 200

/**
 * 「这个实例是好的,只是这个查询真的没有结果」。
 *
 * 需求:上层要把它和「实例坏了」分开 —— 前者换查询词有用,后者换查询词毫无意义。
 * 不分开的话,模型收到的永远是「搜索失败」,于是它会把同一个查询原样再试一遍。
 * 仍然要**抛**(而不是返回空数组):换下一个候选的动作两者是一样的,
 * 区别只体现在最后交给模型的那句话里。
 */
export class SearxngEmptyError extends Error {}

export interface SearxngDeps {
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  /** ★ 只对用户手填的自建实例为真。见文件头。 */
  allowPrivate: boolean
}

/**
 * `{base}/search?q=…&format=json`。
 *
 * ★ 用 `URLSearchParams` 拼,不手拼字符串 —— 中文查询词和 `&` `#` 这类字符
 * 手拼必错,表现是「英文搜得到、中文搜出来是别的东西」。
 *
 * 不带 `language` 参数:各实例支持的语言码集合不同,传一个它不认的会直接 4xx,
 * 而「用实例自己的默认值」在这条兜底链路上永远是能用的那个选择。
 */
export function searxngUrl(base: string, query: string): URL {
  const root = new URL(base)
  // 实例可能挂在子路径下(`https://host/searx/`),所以是拼接而不是覆盖 pathname
  root.pathname = `${root.pathname.replace(/\/+$/, '')}/search`
  root.search = new URLSearchParams({ q: query, format: 'json', safesearch: '0' }).toString()
  return root
}

/**
 * 从 SearxNG 的响应里取条目。首选 `results` 数组(官方字段),
 * 取不到再退到 `findResultArray` 的「找最像结果列表的那个数组」——
 * 与六家适配器同一套兜底策略,理由见 `harvest.ts` 文件头。
 */
export function harvestSearxng(payload: unknown): HarvestedItem[] {
  const preferred = arrayAt(payload, ['results'])
  const rows = preferred.length > 0 ? preferred : findResultArray(payload)
  return harvestAll(rows)
}

export async function searchSearxng(
  base: string,
  query: string,
  deps: SearxngDeps
): Promise<HarvestedItem[]> {
  const url = searxngUrl(base, query)

  if (!deps.allowPrivate) {
    const risk = ssrfRisk(url)
    if (risk !== null) throw new Error(`${url.host} 不是一个可以访问的地址。`)
  }

  const res = await deps.fetch(url, {
    signal: deps.signal,
    redirect: 'manual',
    headers: { accept: 'application/json' }
  })

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, ERROR_BODY_CHARS).trim()
    } catch {
      // 正文读不出来不影响我们已经知道的状态码
    }
    throw new Error(
      `HTTP ${String(res.status)}${res.statusText === '' ? '' : ` ${res.statusText}`}` +
        (detail === '' ? '' : `:${detail}`)
    )
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    /*
      需求:公共实例**普遍默认关掉 `format=json`**,关掉时返回的是一整页 HTML 而不是报错。
      不把这种情况说清楚的话,日志里只会留下一句「解析失败」,而真正该做的是换下一个实例。
    */
    throw new Error('这个实例没有返回 JSON(多半是它关掉了 format=json)。')
  }

  const items = harvestSearxng(payload)
  if (items.length === 0) throw new SearxngEmptyError('这个实例返回了 JSON,但里面没有结果。')
  return items
}
