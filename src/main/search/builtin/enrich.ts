/**
 * 内置免 Key 源的收尾:给前几条结果补正文摘要。
 *
 * 需求:SERP 上的摘要往往只有一行半句,免 Key 源又拿不到 Tavily 那种「已经摘好的
 * 正文片段」。不补的话,模型要么凭一句话下结论,要么对每条结果各调一次 `WebFetch`——
 * 前者是编造,后者是三四次往返。所以在这里**一次性**把最靠前的几条读出来。
 *
 * ## 不变式:正文阶段永远不会让搜索失败
 *
 * 抓正文的每一步失败(超时、非文本、SSRF 拒绝、解码失败)都**静默跳过**,
 * 保留那条结果原来的 SERP 摘要。不满足会怎样:一个打不开的页面会把整次搜索
 * 变成「什么都没搜到」,而结果列表其实早就拿到了。
 *
 * ## 预算是硬上限,不是每条的超时
 *
 * 一个总的 `AbortController` 罩住全部并发请求。按「每条 N 秒」算的话,
 * 慢站点会把一次搜索拖到十几秒,而用户看到的只是「搜索很慢」,无从归因。
 *
 * ## 故意不做
 *
 * - 不跟重定向到别的站点再判一次(那是 `WebFetch` 的职责,这里拿的是摘要)。
 * - 不缓存:同一个查询在一次会话里重复出现的概率低于维护一份缓存的成本。
 */
import type { HarvestedItem } from '../harvest'
import { htmlToText, isTextual } from '../../../shared/text/html-text'
import { ssrfRisk } from '../../kernel/tool/builtin/ssrf'

/** 补进摘要的正文截多长。再长就开始挤占模型上下文,而它本来只是「够不够判断要不要打开」 */
const BODY_CHARS = 800
/** 单个页面最多解码多少字节。整页下下来无法避免,但不必全部解码 */
const MAX_BYTES = 1024 * 1024

export interface EnrichDeps {
  fetch: typeof globalThis.fetch
  /** 整个 run 的中断信号。用户点停止时这里要立刻停手 */
  signal: AbortSignal
}

export interface EnrichOptions {
  /** 补前几条 */
  count: number
  /** 正文阶段的总预算(毫秒),到点就把还没回来的全部放弃 */
  budgetMs: number
}

/**
 * 返回一份新列表:前 `count` 条尽力换成正文摘要,其余原样。
 *
 * ★ 外层 signal 已经 abort 时**抛出去**,不是静默返回 —— 用户点了停止,
 * 这一层继续「尽力而为」等于停止按钮没生效。
 */
export async function enrichSnippets(
  items: readonly HarvestedItem[],
  options: EnrichOptions,
  deps: EnrichDeps
): Promise<HarvestedItem[]> {
  if (deps.signal.aborted) throw deps.signal.reason instanceof Error ? deps.signal.reason : new Error('已中断')
  const targets = items.slice(0, Math.max(0, options.count))
  if (targets.length === 0) return [...items]

  const ctl = new AbortController()
  const onOuter = (): void => {
    ctl.abort(deps.signal.reason)
  }
  deps.signal.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => {
    ctl.abort(new Error('正文抓取超出预算'))
  }, options.budgetMs)
  // 定时器不该拖住进程退出(照 search/service.ts 的同一条理由)
  timer.unref?.()

  try {
    const bodies = await Promise.all(
      targets.map((item) => fetchBody(item.url, { fetch: deps.fetch, signal: ctl.signal }))
    )
    return items.map((item, i) => {
      const body = bodies[i]
      return body === undefined || body === null ? item : { ...item, snippet: body }
    })
  } finally {
    clearTimeout(timer)
    deps.signal.removeEventListener('abort', onOuter)
  }
}

/** 取一页正文。**任何失败都返回 null** —— 见文件头那条不变式 */
async function fetchBody(
  rawUrl: string,
  deps: { fetch: typeof globalThis.fetch; signal: AbortSignal }
): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  /*
    ★ 这里的地址来自搜索结果 —— 也就是**别人的服务器说了算**的内容。
    一个被投毒的结果页可以给出 `http://127.0.0.1:…`,所以这道闸不能省。
    (自建 SearxNG 实例那处放宽只作用于用户手填的地址,见 searxng.ts 文件头。)
  */
  if (ssrfRisk(url) !== null) return null

  try {
    const res = await deps.fetch(url, {
      signal: deps.signal,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }
    })
    if (!res.ok) return null
    const ctype = res.headers.get('content-type') ?? ''
    if (!isTextual(ctype)) return null

    const buf = await res.arrayBuffer()
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(
      buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf
    )
    const looksHtml = ctype.toLowerCase().includes('html') || /^\s*<(!doctype|html)\b/i.test(raw)
    const text = (looksHtml ? htmlToText(raw) : raw).trim()
    return text === '' ? null : text.slice(0, BODY_CHARS)
  } catch {
    // 超时、断网、证书错 —— 全部等价于「这条没补上」,保留原摘要
    return null
  }
}
