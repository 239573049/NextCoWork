/**
 * 从各家的响应里把 title / url / snippet 挖出来。
 *
 * ## 为什么不是六个 `r.title` 就完事
 *
 * 核对文档时反复出现同一句话:「字段名因 SDK / 版本略有不同」(Serper 的
 * `organic` 与 `organic_results`、`link` 与 `url`;Tavily 的 `content` 与
 * `snippet`)。而搜索服务的响应我们**不控制**,它随时会改 —— 一次改名的症状是
 * 「搜索突然一条结果都没有了」,并且不会报错,因为 HTTP 是 200。
 *
 * 所以:每个适配器给出**首选路径**(文档上写的那个),取不到时落到这里按
 * 一组候选名兜底。首选路径让常见情况精确,兜底让改名不至于变成静默的零结果。
 *
 * ## 这个文件是纯函数,没有 import
 *
 * 于是它能被穷举测(`__tests__/harvest.test.ts`)。适配器里剩下的那部分 ——
 * 拼 URL、拼请求头 —— 才是真正需要联网才能验的,那部分被压到了最薄。
 */

const TITLE_KEYS = ['title', 'name', 'heading']
const URL_KEYS = ['url', 'link', 'href', 'source', 'displayUrl', 'display_url']
const SNIPPET_KEYS = [
  'content',
  'snippet',
  'description',
  'text',
  'summary',
  'abstract',
  'excerpt',
  'body'
]
const DATE_KEYS = ['publishedAt', 'published_date', 'publishedDate', 'date', 'page_age', 'time']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 第一个是非空字符串的键。空串当没有 —— `{title: ''}` 和缺字段是同一回事 */
export function pick(obj: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(obj)) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/**
 * 按路径取数组。`path` 形如 `['web', 'results']`。
 * 取不到、或取到的不是数组,一律返回空数组 —— 调用方据此报「零结果」。
 */
export function arrayAt(root: unknown, path: readonly string[]): unknown[] {
  let cur: unknown = root
  for (const seg of path) {
    if (!isRecord(cur)) return []
    cur = cur[seg]
  }
  return Array.isArray(cur) ? cur : []
}

/**
 * 找出响应里**最像结果列表**的那个数组:元素是对象、且至少有一个能当 url 的字段。
 *
 * 只在首选路径落空时才用。这是给秘塔那种响应结构没有公开文档的家准备的 ——
 * 与其猜一个字段名写死(猜错了就是静默零结果),不如按「长什么样」找。
 *
 * 只往下找两层。再深就开始把「相关搜索」「广告位」这类数组也捞上来了,
 * 而那些东西混进结果里比没有结果更糟 —— 模型会认真引用它们。
 */
export function findResultArray(root: unknown, depth = 0): unknown[] {
  if (Array.isArray(root)) {
    const looksLikeResults = root.some((el) => pick(el, URL_KEYS) !== undefined)
    return looksLikeResults ? root : []
  }
  if (!isRecord(root) || depth >= 2) return []
  for (const v of Object.values(root)) {
    const found = findResultArray(v, depth + 1)
    if (found.length > 0) return found
  }
  return []
}

export interface HarvestedItem {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

/**
 * 一条原始结果 → 我们的形状。**没有 url 就丢掉**。
 *
 * url 是这里唯一不能缺的字段:一条模型无法核实、无法引用的搜索结果,
 * 除了占上下文和增加编造的素材之外没有别的作用。标题和摘要缺了还能凑合。
 */
export function harvestItem(raw: unknown): HarvestedItem | null {
  const url = pick(raw, URL_KEYS)
  if (url === undefined) return null
  return {
    title: pick(raw, TITLE_KEYS) ?? url,
    url,
    snippet: pick(raw, SNIPPET_KEYS) ?? '',
    publishedAt: pick(raw, DATE_KEYS)
  }
}

export function harvestAll(rows: readonly unknown[]): HarvestedItem[] {
  const out: HarvestedItem[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const item = harvestItem(r)
    // 同一个 url 出现两次通常是「网页结果 + 精选摘要」重复,留第一条
    if (item === null || seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item)
  }
  return out
}
