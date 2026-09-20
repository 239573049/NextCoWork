/**
 * `web_search` —— 本仓库第二个联网工具,也是让 Composer 上那颗「联网搜索」
 * 药丸真正有意义的那一个。
 *
 * ## 名字为什么是小写下划线
 *
 * 内置工具一律照搬 Claude Code 的名字(`Read` / `Write` / `Grep` …,理由在
 * `fs.ts` 文件头),而 CC 那边这个工具就叫 `web_search`。照搬到底,不自作主张
 * 改成 `WebSearch` —— 名字一致带来的收益(模型见过它、知道怎么用)正是照搬的全部理由。
 *
 * ## 它不碰密钥
 *
 * `ctx.host` 是 `ToolHost`,里面**没有 `secrets`**。Key 由 `search/service.ts`
 * 那个装配槽现取(那个文件头解释了为什么是槽而不是闭包)。所以这个工具
 * 只会说「帮我搜一下」,一个 Key 也拿不到 —— 哪怕它被投毒的提示词说服了也拿不到。
 *
 * ## 返回的是**结果列表**,不是答案
 *
 * 和 `WebFetch` 一样的立场,理由也一样:我们没有一个替模型读完再总结的小模型,
 * 假装有会让模型把片段当成结论去引用。描述里第一段就说清楚。
 *
 * ## 一家都没配时会退到免 Key 的内置源
 *
 * `search/service.ts` 在付费链空或全挂时会去走 `search/builtin/**`(公共 SearxNG →
 * 直抓 SERP)。这个文件负责的是**把这件事说给模型听**:结果头部标出处、
 * 末尾补一句可信度提示。不说的话,模型会把免费源的片段当成用户精心配置的
 * 专业搜索结果来引用,而这两者的时效和准确度不是一个量级。
 */
import { z } from 'zod'
import type { SearchResult } from '../../../../shared/domain/search'
import { BUILTIN_SOURCE_ID } from '../../../../shared/domain/search'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { runSearch } from '../../../search/service'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'

/** 默认要几条。十条左右是「够模型挑」和「不吃掉半个上下文」之间的常见折中。 */
const DEFAULT_COUNT = 8
const MAX_COUNT = 20
/** 单条摘要截多长 —— Exa 那类会返回整页正文的家,十条足以撑爆上下文 */
const SNIPPET_CHARS = 500

const WebSearchInput = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('The search query. Write it as search terms, the way you would in a search engine, not as a full question'),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_COUNT)
    .optional()
    .describe(`How many results to return. Defaults to ${String(DEFAULT_COUNT)}`)
})

/** 结果排成模型好读的样子。**每条都带 url** —— 没有 url 的结果在 harvest 时就丢掉了 */
function render(results: readonly SearchResult[]): string {
  return results
    .map((r, i) => {
      const date = r.publishedAt === undefined ? '' : ` · ${r.publishedAt}`
      const snippet = r.snippet === '' ? '' : `\n   ${r.snippet.slice(0, SNIPPET_CHARS)}`
      return `${String(i + 1)}. ${r.title}\n   ${r.url}${date}${snippet}`
    })
    .join('\n\n')
}

export const webSearchTool: ToolRegistration = defineTool({
  internalId: 'web_search',
  description:
    'Searches the web and returns a list of results (title, link, snippet).\n\n' +
    '- IMPORTANT: this returns A LIST OF RESULTS, not an answer summarized for you. To read one, open its ' +
    'link with WebFetch\n' +
    '- Write query as search terms, not as a full sentence — search engines respond better to keywords\n' +
    '- Results come back in the order the search provider gave them. The numbering is not a ranking of ' +
    'trustworthiness; look at where a link comes from before citing it\n' +
    '- Snippets may be truncated. When a snippet is not enough to answer the question, open the page with ' +
    'WebFetch instead of guessing\n' +
    '- The user can configure several search providers in priority order. A failing provider falls through to ' +
    'the next automatically, so you do not need to retry\n' +
    '- It also works with nothing configured: a built-in key-free source takes over, and the result says so. ' +
    'Those results are lower quality and less fresh — open the important ones with WebFetch before relying on them',
  schema: WebSearchInput,
  /*
    ★ readOnly: true —— 它确实什么也不改。联网这件事不靠 readOnly 管,
    靠下面那个 needsNetwork 和 `permission-gate.ts` 那张表的第 1 行。
  */
  readOnly: true,
  destructive: false,
  needsNetwork: true,
  async run(input, ctx) {
    const count = input.count ?? DEFAULT_COUNT
    ctx.emit({ callId: ctx.callId, message: `Searching: ${input.query}` })

    const outcome = await runSearch(input.query, count, {
      fetch: ctx.host.fetch,
      signal: ctx.signal
    })

    if (outcome.results.length === 0) {
      /*
        分三种情况说,因为模型接下来该做的事完全不同:
        1. 有源应答了、但确实没结果 → **换查询词是有意义的**,别让模型以为搜索坏了;
        2. 一家都没配、内置免 Key 源也没成 → 重试一百次也一样,该停下来告诉用户去配置;
        3. 配了但全挂、内置源也没成 → 把每家的原话给模型(Key 过期、额度用完都在里面)。
        把这三种压成一句「搜索失败」,就会看到模型把同一个查询原样重试三遍。
      */
      const notes = outcome.failures.map((f) => `- ${f.message}`).join('\n')

      if (outcome.reachedEmpty === true) {
        return toolFail(
          `The search itself worked, but no source had results for "${input.query}". ` +
            'Rephrasing the query or using different keywords is worth a try.' +
            (notes === '' ? '' : `\n\nDetails:\n${notes}`)
        )
      }

      // 付费源一个都没进过链 = 用户什么都没配(内置源的失败标的是 'builtin')
      const configured = outcome.failures.some((f) => f.id !== BUILTIN_SOURCE_ID)
      if (!configured) {
        return toolFail(
          'No search provider is configured, and the built-in key-free source could not be reached either:\n' +
            `${notes}\n\n` +
            'Ask the user to open Settings > Connections > Search and either enable a provider with its API key, ' +
            'or fill in their own SearxNG instance in the section at the bottom of that page. ' +
            'Changing the query will not help.'
        )
      }
      return toolFail(
        'Every configured search provider failed, and so did the built-in key-free fallback:\n' + notes
      )
    }

    /*
      ★ 内置源的出处要落到**实例/引擎的名字**上,不是「builtin」四个字母。
      「searx.be」告诉模型和用户这条结果来自哪儿,「builtin」什么也没说。
    */
    const from =
      outcome.provider === undefined
        ? ''
        : outcome.provider === BUILTIN_SOURCE_ID
          ? ` (via built-in free source${outcome.sourceLabel === undefined ? '' : `: ${outcome.sourceLabel}`})`
          : ` (via ${outcome.provider})`

    /*
      ★ 成功时也把中途的失败附上。用户那个填错了的 Key 只有在这里才有机会
      被看见 —— 悄悄退到下一家的话,它会一直错下去,而每次搜索都白花一次往返。
    */
    const notes =
      outcome.failures.length === 0
        ? ''
        : `\n\n(These providers could not be used this time: ${outcome.failures.map((f) => f.message).join('; ')})`

    /*
      需求:免费源的结果必须带着「它是免费源」这句话交给模型 —— 这同时也是给用户的告知
      (这条链路刻意不弹窗)。不带的话,模型会用引用专业搜索结果的口气引用它。
    */
    const caveat =
      outcome.provider === BUILTIN_SOURCE_ID
        ? '\n\nNOTE: these came from the built-in key-free source, which is less accurate and less fresh than a ' +
          'configured search provider. Open anything important with WebFetch before relying on it, and tell the ' +
          'user they can configure a provider in Settings > Connections > Search for better results.'
        : ''

    return toolOk(
      `Search results for "${input.query}"${from}:\n\n${render(outcome.results)}${caveat}${notes}`
    )
  }
})
