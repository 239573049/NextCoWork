/**
 * 「从服务商拉取模型列表」—— 参考图那颗按钮背后的东西。
 *
 * ★ **纯函数,不发请求。** 拼地址、拼鉴权头、解响应体三件事都在这里,
 * 真正的 `host.fetch` 留在 `ipc/provider.ts`。这么切是因为**协议差异全在这三件事里**,
 * 而它们全是算术和字符串 —— 放在这里 `vitest` 直接测得到
 * (`vitest.config.ts` 只收 `src/**\/*.test.ts`,node 环境)。
 *
 * ★★ **两族协议在这条路上有三处真差异,一处都不能省:**
 *
 * | | Anthropic | OpenAI 族 |
 * |---|---|---|
 * | 路径 | `/v1/models` | `/models` |
 * | 鉴权 | `x-api-key` + `anthropic-version` | `Authorization: Bearer` |
 * | 分页 | **默认只回 20 条**,要 `?limit=…` | 一次回全 |
 *
 * 第一行的理由和 `REQUEST_PATH` 上面那张表**逐字相同**(两族的版本段约定是反的:
 * Anthropic 的 base 不带 `/v1`,OpenAI 族的带)——所以这两张表必须一起改。
 *
 * 第三行是最容易漏的:Anthropic 的 `/v1/models` 是**游标分页**的,不传 `limit`
 * 只给 20 条。漏了它的表现不是报错,是**列表少了一截** —— 用户看见 20 个模型,
 * 以为这家就这些,而他要的那个恰好在第 21 条。
 */
import type { FetchedModel, UpstreamProtocol } from '../../../shared/domain/provider'
import { joinUpstreamUrl } from '../../../shared/domain/baseurl'

/*
  ★ `FetchedModel` 住在 `shared/domain/provider.ts`,不在这里 ——
  它要**穿过 IPC** 给渲染层的导入弹窗用,而渲染层 import 不到 `main/`。
*/

/**
 * 拉列表的路径。**和 `REQUEST_PATH`(`shared/domain/baseurl.ts`)是同一套约定的两张表**,
 * 改一张必须改另一张。
 *
 * `openai-responses` 和 `openai-chat` 用同一条 —— Responses API 没有自己的模型列表端点,
 * 它和 Chat Completions 共用 `/models`。
 */
export const MODEL_LIST_PATH: Readonly<Record<UpstreamProtocol, string>> = {
  anthropic: '/v1/models',
  'openai-chat': '/models',
  'openai-responses': '/models'
}

/**
 * Anthropic 分页的一页上限(官方文档写的 max)。
 *
 * ★ 直接顶满,**不做翻页循环**。顶满之后还 `has_more` 的情况需要多打几次请求,
 * 而没有任何一家上游有 1000 个模型 —— 真出现了,下面 `parseModelList`
 * 会照实回它给的那些,不会假装拉全了。
 */
const ANTHROPIC_PAGE_LIMIT = 1000

/**
 * 拼出「拉模型列表」这一次请求。
 *
 * `apiKey` 为 null = 不带鉴权头(预设表里 `modelListPublic` 的那几家实测 200)。
 * ★ 传 null 而不是空串:空串会拼出 `Authorization: Bearer `,那是一个**格式合法
 * 但值为空**的头,有些网关会当成「鉴权失败」而不是「没带鉴权」,报出来的 401
 * 会让用户去查自己的 key,而他压根没填。
 */
export function modelListRequest(
  protocol: UpstreamProtocol,
  baseUrl: string,
  apiKey: string | null
): { url: string; headers: Record<string, string> } {
  const url = joinUpstreamUrl(baseUrl, MODEL_LIST_PATH[protocol])
  const headers: Record<string, string> = { accept: 'application/json' }

  if (protocol === 'anthropic') {
    // 和 `encode/anthropic.ts` 用同一组头。版本号写死是官方要求的形式
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey !== null) headers['x-api-key'] = apiKey
    return { url: `${url}?limit=${String(ANTHROPIC_PAGE_LIMIT)}`, headers }
  }

  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`
  return { url, headers }
}

/**
 * 解模型列表。
 *
 * ★ **容错的对象是「外壳」,不是「条目」。** OpenAI 兼容层是各家自己实现的,
 * 外壳五花八门(`{data:[…]}` / `{models:[…]}` / 直接一个数组),但**条目里的
 * `id` 是这个协议唯一真正稳定的东西**。所以外壳认三种,条目只认 `id`(以及
 * 「整条就是一个字符串」这种偷懒实现)。
 *
 * ★★ **认不出 id 的条目直接丢掉,不给它编一个。** 编出来的那条会被当成
 * `upstreamModel` 存进别名表,然后在某次真实对话里以一个 404 出现 ——
 * 而那时用户早忘了他是从这个列表里勾的。少一条是看得见的,多一条错的不是。
 */
export function parseModelList(protocol: UpstreamProtocol, payload: unknown): FetchedModel[] {
  const rows = envelope(payload)
  const out: FetchedModel[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const id = idOf(row)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    const displayName = protocol === 'anthropic' ? displayNameOf(row) : null
    out.push(displayName === null ? { id } : { id, displayName })
  }
  // ★ 保持上游顺序,不按字典序重排:Anthropic 是**新的在前**,那个顺序有信息量
  return out
}

/** `{data:[…]}` / `{models:[…]}` / 裸数组 → 条目数组。都不是就空数组(不抛) */
function envelope(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== 'object' || payload === null) return []
  const o = payload as Record<string, unknown>
  if (Array.isArray(o.data)) return o.data
  if (Array.isArray(o.models)) return o.models
  return []
}

function idOf(row: unknown): string | null {
  if (typeof row === 'string') return row.trim() === '' ? null : row.trim()
  if (typeof row !== 'object' || row === null) return null
  const id = (row as Record<string, unknown>).id
  if (typeof id !== 'string' || id.trim() === '') return null
  return id.trim()
}

function displayNameOf(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null
  const n = (row as Record<string, unknown>).display_name
  if (typeof n !== 'string' || n.trim() === '') return null
  return n.trim()
}

/**
 * 把一次失败的拉取变成一句能给用户看的话。
 *
 * ★ **不要把响应体原样贴到界面上。** 网关和反代在出错时回的往往是一整页 HTML
 * (Cloudflare 的拦截页、nginx 的 502),几 KB 的标签糊在弹窗里,用户看不出
 * 「这是网关拦的」还是「key 错了」。所以:能解出 JSON 里的 message 就只显示它,
 * 解不出就截断到一行。
 *
 * 401/403 单独给一句 —— 这是这条路上最常见的失败,而它的修法(去填 key)
 * 和别的失败完全不同。
 */
export function modelListErrorMessage(status: number, body: string): string {
  const detail = extractMessage(body)
  const tail = detail === null ? '' : `:${detail}`
  if (status === 401 || status === 403) {
    return `上游拒绝了这次请求(HTTP ${String(status)})—— 通常是 API 密钥没填或者填错了${tail}`
  }
  if (status === 404) {
    return `这个地址上没有模型列表端点(HTTP 404)—— 检查 API 地址里的版本段是否正确${tail}`
  }
  return `拉取失败(HTTP ${String(status)})${tail}`
}

/** Anthropic 是 `{error:{message}}`,OpenAI 是 `{error:{message}}` 或 `{message}` */
function extractMessage(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const line = body.trim().split('\n')[0]?.trim() ?? ''
    // 一看就是 HTML 的直接不显示 —— 显示 `<!DOCTYPE html>` 对用户没有任何帮助
    if (line === '' || line.startsWith('<')) return null
    return truncate(line)
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const err = o.error
  if (typeof err === 'string') return truncate(err)
  if (typeof err === 'object' && err !== null) {
    const m = (err as Record<string, unknown>).message
    if (typeof m === 'string' && m.trim() !== '') return truncate(m)
  }
  if (typeof o.message === 'string' && o.message.trim() !== '') return truncate(o.message)
  return null
}

function truncate(s: string): string {
  const t = s.trim()
  return t.length <= 200 ? t : `${t.slice(0, 200)}…`
}
