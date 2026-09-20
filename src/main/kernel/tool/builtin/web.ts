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
 * ## 地址筛查按工作区所有者的要求关闭了
 *
 * 原先这里还有两道专防「拿模型当跳板去打本机和内网」的防线:`ssrf.ts` 的字面量
 * 地址筛查,以及「每一跳重定向都重新筛查一次」。工作区所有者在 2026-09-20 明确
 * 要求让这个工具能够触达本机和内网服务,并在确认过风险后仍要求继续——于是这里
 * 现在传 `ssrfRisk(url, { allowPrivateAddresses: true })`,风险和动机记在
 * `ssrf.ts` 的 `SsrfRiskOptions` 上,这里不重复。协议白名单(只认 http/https)
 * 和 URL 内嵌凭证的拦截**没有**被关掉,继续走同一个 `ssrfRisk`。
 *
 * 仍然保留的一道防线:**content-type 白名单 + 字节上限** —— 防「把一个 500MB
 * 的 zip 解码成一堆替换字符再塞进上下文」。
 *
 * ## `isTextual` / `htmlToText` 搬家了
 *
 * 这两个函数原先就写在本文件里。免 Key 的内置搜索(`main/search/builtin/enrich.ts`)
 * 要给结果补正文,做的是同一件事,于是实现**原样**搬到了 `shared/text/html-text.ts`,
 * 当初那两段解释取舍的注释一并跟了过去。这里改成引用,行为与之前一致 ——
 * 留两份的话迟早分叉,其中一份会拿到另一份没有的修复。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { htmlToText, isTextual } from '../../../../shared/text/html-text'
import { clampWithEllipsis, stripControlChars } from '../../text'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'
import { ssrfRisk } from './ssrf'

/** 单次请求的墙钟预算 */
const FETCH_TIMEOUT_MS = 30_000
/** 最多跟几跳重定向。和浏览器的常规上限一致。 */
const MAX_REDIRECTS = 5
/** 下载字节上限 —— 超过就截断,不是报错(半页内容通常也够用) */
const MAX_BYTES = 4 * 1024 * 1024
/** 交给模型的正文字符上限 */
const MAX_TEXT_CHARS = 100_000

const WebFetchInput = z.object({
  url: z.string().url().describe('The URL to fetch. Must be a complete http/https address'),
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'What you are looking for on this page. It is echoed verbatim at the top of the result so you stay on ' +
        'target after reading a long page'
    )
})

export const webFetchTool: ToolRegistration = defineTool({
  internalId: 'WebFetch',
  description:
    'Fetches the content at a URL and converts it to text for you.\n\n' +
    '- IMPORTANT: this returns THE PAGE ITSELF, not an answer summarized for you. Extracting, judging, and ' +
    'quoting are your job\n' +
    '- Say in prompt what you are looking for; it is placed above the text so you can check yourself against it\n' +
    '- Only http and https are supported. http is upgraded to https automatically\n' +
    '- Only textual content is accepted (HTML, plain text, JSON, XML, …). PDFs, images, and archives are refused\n' +
    `- Text longer than ${String(MAX_TEXT_CHARS / 1000)}k characters is truncated\n` +
    '- HTML is stripped to readable text; table and nested-list structure may be lost\n' +
    '- user:pass@ credentials in the URL are refused\n' +
    '- Pages behind a login cannot be fetched. If you get a login page, do NOT retry — tell the user\n' +
    '- A redirect to a different host is refused and the new address is handed back to you; call again with ' +
    'that address if you want it',
  schema: WebFetchInput,
  /*
    ★ readOnly: true —— 它确实不改变任何东西。联网这件事**不靠 readOnly 管**,
    靠 `permission-gate.ts` 那张表的第 1 行(`needsNetwork && !webSearch` → 拒绝),
    而那一行**排在只读放行之前**,正是为了这个工具。
  */
  readOnly: true,
  destructive: false,
  /*
    ★ 这是本仓库第一个 `needsNetwork: true`。它和上面那条 `readOnly: true` 的注释
    是一体两面:只读放行排在联网拒绝**后面**,所以这个字段真的能拦住它。
  */
  needsNetwork: true,
  async run(input, ctx) {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return toolFail(
        `Malformed URL: "${input.url}". Give a complete address, e.g. https://example.com/page.`
      )
    }

    // 和 CC 一致:http 升级成 https。降级传输里的内容会被中间人改写。
    if (url.protocol === 'http:') url.protocol = 'https:'

    const firstRisk = ssrfRisk(url, { allowPrivateAddresses: true })
    if (firstRisk !== null) return toolFail(firstRisk)

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
          协议/凭证这两条(见 `ssrf.ts`)就会在重定向面前形同虚设。地址本身现在
          允许指向内网,但协议白名单和凭证拦截仍然要对每一跳都成立。
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
          return toolFail(`The server returned a redirect address that could not be parsed: "${loc}".`)
        }

        // 每一跳都重新过一遍闸,和第一次一模一样的标准(协议白名单 + 凭证拦截)
        const risk = ssrfRisk(next, { allowPrivateAddresses: true })
        if (risk !== null) return toolFail(`The redirect target is not allowed. ${risk}`)

        /*
          ★ 跨主机重定向**停下来问模型**,而不是默默跟过去。CC 也是这个行为。
          理由是它会改变「我读到的内容来自哪个域名」这件事 —— 而模型多半会
          按最初那个域名的可信度去对待读回来的内容。
        */
        if (next.hostname !== current.hostname) {
          return toolOk(
            `This address redirects to a different host: ${next.toString()}\n` +
              `Nothing was fetched. If that new address is what you want, call WebFetch again with it.`
          )
        }
        current = next
      }

      if (res === null) return toolFail('The request produced no response at all.')

      if (!res.ok) {
        return toolFail(
          `HTTP ${String(res.status)} ${res.statusText} (${current.toString()}). ` +
            (res.status === 401 || res.status === 403
              ? 'This page needs a login or you do not have access. Retrying will not help — tell the user.'
              : res.status === 404
                ? 'The address does not exist. Check the URL, or find another source.'
                : '')
        )
      }

      const ctype = res.headers.get('content-type') ?? ''
      if (!isTextual(ctype)) {
        return toolFail(
          `This address returned "${ctype || 'an unknown type'}", which is not textual content, so it was refused. ` +
            `This tool only reads HTML, plain text, JSON, XML and the like. For a PDF, an image, or an archive, ` +
            `ask the user to download it into the workspace and open it with Read.`
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
          `${current.toString()} was fetched successfully but has no readable text. ` +
            `It is most likely rendered entirely by JavaScript, which this tool cannot execute. Find another source.`
        )
      }

      const body = clampWithEllipsis(text, MAX_TEXT_CHARS)
      const notes: string[] = []
      if (body.length < text.length) notes.push('text was too long and has been truncated')
      if (truncatedBytes)
        notes.push(`the response exceeded ${String(MAX_BYTES / 1024 / 1024)}MB, so only the start was read`)

      return toolOk(
        `You are looking for: ${input.prompt}\n\n` +
          `Content of ${current.toString()}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}:\n\n` +
          body
      )
    } catch (err) {
      // 中断由 defineTool 处理;走到这里的是超时或真正的网络错误
      if (ctx.signal.aborted) throw err
      if (timer.signal.aborted) {
        return toolFail(
          `The request to ${url.toString()} timed out after ${String(FETCH_TIMEOUT_MS / 1000)} seconds.`
        )
      }
      return toolFail(
        `The request to ${url.toString()} failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Check the address or find another source — retrying the same URL will not help.`
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
