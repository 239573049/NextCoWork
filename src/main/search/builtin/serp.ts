/**
 * 内置免 Key 源的第二层:直接解析搜索引擎的结果页 HTML。
 *
 * 需求:公共 SearxNG 实例**普遍关掉了 `format=json`**,也普遍限流。第一层全挂时
 * 如果就此放弃,「零配置也能搜」这件事在多数机器上根本落不了地 —— 所以有这一层。
 *
 * ## 为什么是解析 HTML,而不是开浏览器
 *
 * 仓库里确实有 headless Chromium(`main/browser/headless.ts`),但它**首次使用要下载
 * 一整个 Chromium**,单次查询也慢一个数量级。而这条链路存在的全部理由是
 * 「用户什么都没配也能用」—— 用一次几百毫秒的 HTTP 换成一次几百兆的下载,
 * 与这个理由正相反。代价照实记:被反爬挡住时这一层就是拿不到结果,
 * 那时会如实告诉模型和用户(见 `index.ts` 的 failures)。
 *
 * ## 为什么是一张表
 *
 * `ENGINES` 是数据,不是 if-else 链:加一家 = 往表里加一行(AGENTS §11)。
 * 三家的差别全部压在 `buildUrl` / `blockMarker` / `pickLink` / `snippet` 四个字段里。
 *
 * ## 这个文件是纯函数,没有 IO
 *
 * 于是三家的解析能被样本 HTML 穷举测(`__tests__/serp.test.ts`)——
 * 和 `harvest.ts` 同一个理由:真正需要联网才能验的部分被压到了最薄。
 *
 * ## 故意不做
 *
 * - **不解百度的跳转链接**(`baidu.com/link?url=…`):解它要多一次 HTTP 往返,
 *   而模型拿到跳转地址后用 `WebFetch` 打开是等价的。
 * - **不判结果排名、不过滤「广告」以外的任何东西**:我们不比引擎更懂哪条更好。
 */
import type { HarvestedItem } from '../harvest'
import { htmlFragmentToText } from '../../../shared/text/html-text'

export type BuiltinEngineId = 'bing' | 'duckduckgo' | 'baidu'

/** 摘要截多长。SERP 上的摘要本来就短,这个上限只防「整块 HTML 掉进来」 */
const SNIPPET_CHARS = 400

interface Anchor {
  href: string
  inner: string
  /** 开标签里除 href 之外的属性原文。DuckDuckGo 靠 `class="result__a"` 认标题链接 */
  attrs: string
}

interface SerpEngine {
  id: BuiltinEngineId
  /** 给用户/模型看的出处名。**不翻译**(AGENTS §6.5:领域值不翻) */
  label: string
  buildUrl(query: string, count: number): URL
  /** 一条结果的起始标记。块 = 从一个标记到下一个标记之间的那段 HTML */
  blockMarker: RegExp
  /** 从块里挑出「标题 + 链接」那个 a。挑不出来 = 这块不是结果(广告、相关搜索) */
  pickLink(anchors: readonly Anchor[], block: string): Anchor | null
  /** 摘要的首选路径。取不到时落到 `fallbackSnippet` */
  snippet(block: string): string | null
}

/**
 * 把一页 HTML 切成「一条结果一块」。
 *
 * ★ 按**起始标记的位置**切,而不是去匹配配对的结束标签:结果页里的
 * `<div>` 嵌套得很深,正则配不准闭合标签,配错的表现是「只解析出第一条」。
 * 切到下一个标记为止会多带上一些尾巴,而多余的尾巴只影响摘要,不影响链接。
 */
export function splitBlocks(html: string, marker: RegExp): string[] {
  const re = new RegExp(marker.source, 'gi')
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    starts.push(m.index)
    // 零宽匹配会死循环 —— 正则改坏时的表现是界面卡死,不是报错
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length))
}

/** 块里全部的 `<a href=…>…</a>`。href 里的实体(`&amp;`)在这里就解掉 */
export function anchorsIn(block: string): Anchor[] {
  const re = /<a\b([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi
  const out: Anchor[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    out.push({
      href: (m[2] ?? '').replace(/&amp;/gi, '&'),
      inner: m[4] ?? '',
      attrs: `${m[1] ?? ''} ${m[3] ?? ''}`
    })
  }
  return out
}

/**
 * 各家都会把真实地址藏在自己的跳转链接里,这里尽力还原。
 *
 * 还原不了就**原样返回**,不丢弃 —— 一条跳转链接仍然能被 `WebFetch` 打开,
 * 而丢掉它等于凭空少一条结果。
 */
export function normalizeHref(raw: string): string | null {
  const href = raw.trim()
  if (href === '' || href.startsWith('#') || href.startsWith('javascript:')) return null

  // 协议相对地址(DuckDuckGo 的跳转链接就是这种)
  const absolute = href.startsWith('//') ? `https:${href}` : href
  if (!/^https?:\/\//i.test(absolute)) return null

  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return null
  }

  // DuckDuckGo:`//duckduckgo.com/l/?uddg=<编码后的真实地址>`
  const uddg = url.searchParams.get('uddg')
  if (uddg !== null && uddg !== '') return uddg

  // Bing:`/ck/a?…&u=a1<base64url 的真实地址>`。解不开就原样用跳转链接
  const u = url.searchParams.get('u')
  if (u !== null && u.startsWith('a1') && url.hostname.endsWith('bing.com')) {
    const decoded = decodeBase64Url(u.slice(2))
    if (decoded !== null && /^https?:\/\//i.test(decoded)) return decoded
  }

  return url.toString()
}

function decodeBase64Url(text: string): string | null {
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** 没有首选路径时的摘要:整块去标签,去掉开头重复的标题 */
function fallbackSnippet(block: string, title: string): string {
  const text = htmlFragmentToText(block)
  const withoutTitle = text.startsWith(title) ? text.slice(title.length) : text
  return withoutTitle.trim().slice(0, SNIPPET_CHARS)
}

function matched(block: string, re: RegExp): string | null {
  const m = re.exec(block)
  const inner = m?.[1]
  if (inner === undefined) return null
  const text = htmlFragmentToText(inner)
  return text === '' ? null : text.slice(0, SNIPPET_CHARS)
}

/** 标题里全是空白 / 链接指向引擎自己(「更多结果」之类)的块不算结果 */
function usableAnchor(a: Anchor, hostSuffix: string): boolean {
  if (htmlFragmentToText(a.inner) === '') return false
  const href = normalizeHref(a.href)
  if (href === null) return false
  try {
    return !new URL(href).hostname.endsWith(hostSuffix)
  } catch {
    return false
  }
}

/**
 * 标题锚点只在 `<h2>` / `<h3>` 里找。
 *
 * ★ 这一条是拿真实结果页验出来的,不是设计出来的:Bing 的一个 `b_algo` 块里,
 * **排在标题前面**还有一个 href 相同、但内容是面包屑(`example.org › a › b`)
 * 的链接。取「块里第一个能用的 a」会得到
 * 「smapply.org https://openai.smapply.org」这种标题 —— 地址是对的,
 * 所以不会报错、也不会零结果,只是每条标题都多一截面包屑,一路带进模型的引用里。
 */
function headingAnchors(block: string, heading: RegExp): Anchor[] {
  const inner = heading.exec(block)?.[1]
  return inner === undefined ? [] : anchorsIn(inner)
}

export const ENGINES: readonly SerpEngine[] = [
  {
    id: 'bing',
    label: 'Bing',
    buildUrl: (query, count) =>
      new URL(
        `https://www.bing.com/search?${new URLSearchParams({
          q: query,
          count: String(count),
          // 结果页给桌面版,移动版的类名完全是另一套
          form: 'QBLH'
        }).toString()}`
      ),
    blockMarker: /<li[^>]+class="[^"]*\bb_algo\b[^"]*"/,
    pickLink: (anchors, block) => {
      // 先在 `<h2>` 里找标题;认不出标题结构时才退到「块里第一个能用的链接」
      const inHeading = headingAnchors(block, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i).find((a) =>
        usableAnchor(a, 'bing.com')
      )
      return inHeading ?? anchors.find((a) => usableAnchor(a, 'bing.com')) ?? null
    },
    snippet: (block) => matched(block, /<p\b[^>]*>([\s\S]*?)<\/p>/i)
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    buildUrl: (query) =>
      new URL(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`),
    blockMarker: /<div[^>]+class="[^"]*\bresult\b[^"]*"/,
    pickLink: (anchors, block) => {
      // `result--ad` 是广告位。它和正常结果长得一模一样,不过滤的话模型会认真引用它
      if (/\bresult--ad\b/i.test(block)) return null
      const usable = anchors.filter((a) => usableAnchor(a, 'duckduckgo.com'))
      // 标题链接带 `class="result__a"`;认不出来时退到块里第一个能用的链接
      return usable.find((a) => /result__a/i.test(a.attrs)) ?? usable[0] ?? null
    },
    snippet: (block) =>
      matched(block, /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
  },
  {
    id: 'baidu',
    label: '百度',
    buildUrl: (query, count) =>
      new URL(
        `https://www.baidu.com/s?${new URLSearchParams({ wd: query, rn: String(count) }).toString()}`
      ),
    blockMarker: /<div[^>]+class="[^"]*\bresult\b[^"]*"/,
    // ★ 标题在 `<h3>` 里;用不到已经解析好的 anchors(`_` 前缀 = 有意不用)
    pickLink: (_anchors, block) => {
      /*
        ★ 跳转链接 `baidu.com/link?url=…` **原样保留** —— 解它要多一次请求,
        而模型拿去 WebFetch 打开是等价的。所以这里不能用 `usableAnchor` 把
        baidu.com 过滤掉,否则百度这一家会永远零结果。
      */
      const usable = (a: Anchor): boolean =>
        normalizeHref(a.href) !== null && htmlFragmentToText(a.inner) !== ''
      const heading = headingAnchors(block, /<h3\b[^>]*>([\s\S]*?)<\/h3>/i).find(usable)
      return heading ?? anchorsIn(block).find(usable) ?? null
    },
    snippet: (block) =>
      matched(block, /<(?:div|span)\b[^>]*class="[^"]*c[-_]abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i)
  }
]

/**
 * 一页 HTML → 条目列表。取不到就是空数组,**不抛** ——
 * 「解析不出来」和「被挡住」由调用方按 `looksBlocked` 区分,两者的处置不同。
 */
export function parseSerp(engineId: BuiltinEngineId, html: string): HarvestedItem[] {
  const engine = ENGINES.find((e) => e.id === engineId)
  if (engine === undefined) return []

  const out: HarvestedItem[] = []
  const seen = new Set<string>()

  for (const block of splitBlocks(html, engine.blockMarker)) {
    const anchor = engine.pickLink(anchorsIn(block), block)
    if (anchor === null) continue
    const url = normalizeHref(anchor.href)
    if (url === null || seen.has(url)) continue
    const title = htmlFragmentToText(anchor.inner)
    if (title === '') continue
    seen.add(url)
    out.push({ title, url, snippet: engine.snippet(block) ?? fallbackSnippet(block, title) })
  }
  return out
}

/**
 * 这页是不是「验证码 / 异常流量」拦截页。
 *
 * 需求:三家都零结果时,用户需要知道是**被挡了**还是**页面改版解析不出来了** ——
 * 前者换个时间/网络就好,后者是这个仓库要修的 bug。只写「没有结果」的话,
 * 半年后没人知道该去看哪儿。
 */
export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase()
  return (
    head.includes('captcha') ||
    head.includes('unusual traffic') ||
    head.includes('wappass.baidu.com') ||
    head.includes('验证码') ||
    head.includes('安全验证')
  )
}
