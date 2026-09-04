/**
 * `WebFetch` —— 取一个网页回来给模型读。
 *
 * 名字和 `url` / `prompt` 两个参数对齐 Claude Code。★ 但有一处**必须照实说**的
 * 语义差异,写在描述的第一段:
 *
 * CC 的 WebFetch 背后有一个小模型,它按你给的 `prompt` 读完整页再把答案交回来 ——
 * 所以 CC 里这个工具的返回是**一段答案**。我们没有那个小模型,返回的是**页面正文本身**。
 * 不说清楚的话,模型会写一个精心构造的 prompt,然后收到一大段正文,
 * 并把它当成「小模型给出的答案」来引用 —— 引出来的东西是错位的。
 *
 * `prompt` 仍然保留且**确实有用**:它会被原样放在结果的开头。一页几万字符倒进
 * 上下文之后,模型很容易忘了自己本来要找什么;把问题重新摆在正文前面,
 * 比删掉这个参数有用得多。
 *
 * ## 三道防线,分别防三件不同的事
 *
 * 1. `ssrf.ts` 的**地址筛查** —— 防「拿模型当跳板去打本机和内网」。
 * 2. **每一跳重定向都重新筛查一次** —— 防「公网域名 302 到 169.254.169.254」。
 *    这是最容易漏的一处:只查第一个 URL 的实现,在重定向面前等于没查。
 * 3. **content-type 白名单 + 字节上限** —— 防「把一个 500MB 的 zip 解码成
 *    一堆替换字符再塞进上下文」。
 */
import { promises as dns } from 'node:dns'
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { clampWithEllipsis, stripControlChars } from '../../text'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'
import { isPrivateAddress, ssrfRisk } from './ssrf'

/** 单次请求的墙钟预算 */
const FETCH_TIMEOUT_MS = 30_000
/** 最多跟几跳重定向。和浏览器的常规上限一致。 */
const MAX_REDIRECTS = 5
/** 下载字节上限 —— 超过就截断,不是报错(半页内容通常也够用) */
const MAX_BYTES = 4 * 1024 * 1024
/** 交给模型的正文字符上限 */
const MAX_TEXT_CHARS = 100_000
/** DNS 反查的等待上限。查不出来就跳过这一层,不因为 DNS 慢而卡住整个工具。 */
const DNS_TIMEOUT_MS = 800

/**
 * 允许解码成文本的 content-type。
 *
 * ★ 白名单而不是黑名单。黑名单漏一个类型的后果是把二进制倒进上下文;
 * 白名单漏一个类型的后果是模型收到一条说得清楚的拒绝。
 */
function isTextual(contentType: string): boolean {
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
function htmlToText(html: string): string {
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
 * 尽力而为的 DNS 层筛查:域名解析出来的地址也得是公网的。
 *
 * ★ 查不出来时**放行**,不是拒绝。DNS 不可用(离线、被墙、解析器抽风)时
 * 把所有联网请求都拒掉,是拿一个可用性问题去换一点点安全边际 ——
 * 而字面量那道筛查才是真正承重的那一道。
 */
async function resolvedAddressRisk(hostname: string): Promise<string | null> {
  let addrs: Array<{ address: string }>
  try {
    addrs = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), DNS_TIMEOUT_MS))
    ])
  } catch {
    return null
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address))
  if (bad === undefined) return null
  return (
    `拒绝访问 "${hostname}":它解析到的是本机或内网地址(${bad.address})。` +
    `一个公网域名指向内网,通常意味着这是一次刻意的绕过尝试。`
  )
}

const WebFetchInput = z.object({
  url: z.string().url().describe('要抓取的 URL,必须是完整的 http/https 地址'),
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe('你想从这个页面里得到什么。它会被原样放在返回内容的开头,帮你在读完长正文后不跑题')
})

export const webFetchTool: ToolRegistration = defineTool({
  internalId: 'WebFetch',
  description:
    '抓取一个 URL 的内容,转成文本交给你。\n\n' +
    '- ★ **返回的是页面正文本身,不是替你总结好的答案。**提取、判断、引用都由你自己来做\n' +
    '- prompt 写清楚你要找什么;它会放在正文前面,方便你读完之后对照\n' +
    '- 只支持 http / https。http 会自动升级成 https\n' +
    '- 只接受文本类内容(HTML、纯文本、JSON、XML 等)。PDF、图片、压缩包一律拒绝\n' +
    `- 正文超过 ${String(MAX_TEXT_CHARS / 1000)}k 字符会被截断\n` +
    '- HTML 会被去掉标签转成正文文本,表格和嵌套列表的结构可能会丢\n' +
    '- **不能访问本机和内网地址**(localhost、127.0.0.1、192.168.x.x、云元数据端点等),' +
    '也不能带 user:pass@ 形式的凭证\n' +
    '- 需要登录才能看的页面抓不到 —— 拿到登录页时不要反复重试,直接告诉用户\n' +
    '- 跨主机的重定向会被拒绝并把新地址告诉你,需要的话你再用新地址调一次',
  schema: WebFetchInput,
  /*
    ★ readOnly: true —— 它确实不改变任何东西。联网这件事**不靠 readOnly 管**,
    靠 `permission-gate.ts` 那张表的第 1 行(`needsNetwork && !webSearch` → 拒绝),
    而那一行**排在只读放行之前**,正是为了这个工具。
  */
  readOnly: true,
  destructive: false,
  async run(input, ctx) {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return toolFail(`URL 格式不对:"${input.url}"。请给一个完整地址,例如 https://example.com/page。`)
    }

    // 和 CC 一致:http 升级成 https。降级传输里的内容会被中间人改写。
    if (url.protocol === 'http:') url.protocol = 'https:'

    const firstRisk = ssrfRisk(url)
    if (firstRisk !== null) return toolFail(firstRisk)
    const dnsRisk = await resolvedAddressRisk(url.hostname)
    if (dnsRisk !== null) return toolFail(dnsRisk)

    ctx.emit({ callId: ctx.callId, message: `正在抓取 ${url.hostname}` })

    const timer = new AbortController()
    const onAbort = (): void => {
      timer.abort()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const t = setTimeout(() => {
      timer.abort()
    }, FETCH_TIMEOUT_MS)

    try {
      let current = url
      let res: Response | null = null

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        /*
          ★ `redirect: 'manual'` 是这一段的全部意义。用默认的 'follow' 的话,
          浏览器/undici 会替我们跟过去,而**跟过去的那个地址没有经过任何筛查** ——
          一个公网域名 302 到 169.254.169.254 就直通了。
        */
        res = await ctx.host.fetch(current, {
          redirect: 'manual',
          signal: timer.signal,
          headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9' }
        })

        if (res.status < 300 || res.status >= 400) break

        const loc = res.headers.get('location')
        if (loc === null) break

        let next: URL
        try {
          next = new URL(loc, current)
        } catch {
          return toolFail(`服务器返回了一个无法解析的重定向地址:"${loc}"。`)
        }

        // 每一跳都重新过一遍闸,和第一次一模一样的标准
        const risk = ssrfRisk(next)
        if (risk !== null) return toolFail(`重定向到了不允许的地址。${risk}`)
        const nextDns = await resolvedAddressRisk(next.hostname)
        if (nextDns !== null) return toolFail(`重定向到了不允许的地址。${nextDns}`)

        /*
          ★ 跨主机重定向**停下来问模型**,而不是默默跟过去。CC 也是这个行为。
          理由是它会改变「我读到的内容来自哪个域名」这件事 —— 而模型多半会
          按最初那个域名的可信度去对待读回来的内容。
        */
        if (next.hostname !== current.hostname) {
          return toolOk(
            `这个地址重定向到了另一个主机:${next.toString()}\n` +
              `内容没有被抓取。如果这个新地址确实是你要的,请用它再调一次 WebFetch。`
          )
        }
        current = next
      }

      if (res === null) return toolFail('请求没有得到任何响应。')

      if (!res.ok) {
        return toolFail(
          `HTTP ${String(res.status)} ${res.statusText}(${current.toString()})。` +
            (res.status === 401 || res.status === 403
              ? '这个页面需要登录或没有访问权限,重试不会有帮助,请把这个情况告诉用户。'
              : res.status === 404
                ? '地址不存在。请检查 URL,或者换一个来源。'
                : '')
        )
      }

      const ctype = res.headers.get('content-type') ?? ''
      if (!isTextual(ctype)) {
        return toolFail(
          `这个地址返回的是 "${ctype || '未知类型'}",不是文本内容,已拒绝。` +
            `这个工具只能读 HTML、纯文本、JSON、XML 一类的内容 —— ` +
            `PDF、图片、压缩包请让用户下载后放进工作区,再用 Read 打开。`
        )
      }

      const buf = await res.arrayBuffer()
      const truncatedBytes = buf.byteLength > MAX_BYTES
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(
        truncatedBytes ? buf.slice(0, MAX_BYTES) : buf
      )

      const looksHtml = ctype.toLowerCase().includes('html') || /^\s*<(!doctype|html)\b/i.test(raw)
      const text = stripControlChars(looksHtml ? htmlToText(raw) : raw).trim()

      if (text === '') {
        return toolOk(
          `${current.toString()} 抓取成功,但页面没有可读的文本内容。` +
            `多半是个完全靠 JavaScript 渲染的页面 —— 这个工具拿不到那类内容,请换一个来源。`
        )
      }

      const body = clampWithEllipsis(text, MAX_TEXT_CHARS)
      const notes: string[] = []
      if (body.length < text.length) notes.push('正文过长,已截断')
      if (truncatedBytes) notes.push(`响应超过 ${String(MAX_BYTES / 1024 / 1024)}MB,只读了前面一部分`)

      return toolOk(
        `你要找的是:${input.prompt}\n\n` +
          `以下是 ${current.toString()} 的正文${notes.length > 0 ? `(${notes.join(';')})` : ''}:\n\n` +
          body
      )
    } catch (err) {
      // 中断由 defineTool 处理;走到这里的是超时或真正的网络错误
      if (ctx.signal.aborted) throw err
      if (timer.signal.aborted) {
        return toolFail(`请求 ${url.toString()} 超时(超过 ${String(FETCH_TIMEOUT_MS / 1000)} 秒)。`)
      }
      return toolFail(
        `请求 ${url.toString()} 失败:${err instanceof Error ? err.message : String(err)}。` +
          `请检查地址是否正确,或者换一个来源 —— 反复重试同一个地址不会有帮助。`
      )
    } finally {
      clearTimeout(t)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
})

export const WEB_LIMITS = {
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_BYTES,
  MAX_TEXT_CHARS
} as const
