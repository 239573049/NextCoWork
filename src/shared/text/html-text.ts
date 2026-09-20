/**
 * HTML → 纯文本,以及「这个 content-type 能不能当文本解码」。
 *
 * ## 为什么住在 shared 而不是留在 WebFetch 里
 *
 * 需求:免 Key 的内置搜索(`main/search/builtin/**`)要给前两条结果补正文,
 * 而那件事和 `WebFetch` 做的是同一件事 —— 取一个网页、判断它能不能当文本读、
 * 把标签去掉。两份实现迟早分叉:其中一份会拿到另一份没有的实体解码修复,
 * 表现为「同一个页面,WebFetch 读出来是干净的,搜索结果里的摘要却带着 &amp;」。
 *
 * 所以这里是**唯一一份**。原本的实现在
 * `main/kernel/tool/builtin/web.ts`,搬过来时一个字符也没改,
 * 下面那些解释「为什么这么写」的注释全部原样跟过来 —— 它们记的是当初的取舍,
 * 不是对代码的复述。
 *
 * ## 它故意不是什么
 *
 * 不是 markdown 转换器,也不是 HTML 解析器。表格和嵌套列表的结构会丢,
 * 这是 `web.ts` 当初就接受的代价(理由见下面 `htmlToText` 的注释)。
 * 需要结构的人应该去读原文,而不是让这里长出第二套解析器。
 *
 * 纯函数、零 import,于是主进程和渲染层都能引,也能被直接穷举测。
 */

/**
 * 允许解码成文本的 content-type。
 *
 * ★ 白名单而不是黑名单。黑名单漏一个类型的后果是把二进制倒进上下文;
 * 白名单漏一个类型的后果是模型收到一条说得清楚的拒绝。
 */
export function isTextual(contentType: string): boolean {
  const t = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (t.startsWith('text/')) return true
  if (t.endsWith('+json') || t.endsWith('+xml')) return true
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/ld+json',
    'application/rss+xml',
    'application/atom+xml',
    'application/x-yaml',
    'application/yaml'
  ].includes(t)
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

/**
 * HTML → 纯文本。
 *
 * ★ 刻意**不**引 turndown / cheerio,也不假装自己产出 markdown。需要的只是
 * 「把标签去掉、把块级元素之间的换行留住」,而一个完整的 HTML 解析器是这一批
 * 里最大的一笔新依赖,且它的解析结果对模型的帮助远没有想象中大。
 * 代价:表格和嵌套列表的结构会丢。描述里会说清楚返回的是正文文本。
 */
export function htmlToText(html: string): string {
  return html
    // script / style / noscript / svg 的内容对阅读毫无价值,而且能占掉整页的体积
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    // 行内空白压成一个空格,但**保留换行** —— 换行是这里仅剩的结构
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()
}

/**
 * HTML 片段 → 一行纯文本(给标题、摘要这种本来就该是一行的东西)。
 *
 * 需求:SERP 解析出来的 `<b>关键词</b>` 高亮、`&nbsp;` 分隔符必须去掉,
 * 否则它们会原样出现在交给模型的结果列表里。
 * 不满足会怎样:模型引用标题时把标签一起引进答案。
 */
export function htmlFragmentToText(html: string): string {
  return htmlToText(html).replace(/\s*\n\s*/g, ' ').trim()
}
