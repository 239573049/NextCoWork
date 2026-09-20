/**
 * 免 Key 的内置搜索 —— 「什么都没配也能搜到东西」这条需求的落点。
 *
 * ## 为什么存在
 *
 * 在这之前,一个搜索服务都没配的用户调 `web_search`,拿回的是一句
 * 「去 设置 › 连接 › 搜索 配 Key」。对「刚装上就想问一个需要联网的问题」的人来说,
 * 那等于这个功能不存在。这条链路不需要任何 Key,用户配了专业服务就永远轮不到它。
 *
 * ## 为什么是两层
 *
 * 1. **SearxNG**(`searxng.ts`):免 Key 且返回 JSON,字段不会因为页面改版静默失效。
 *    但公共实例普遍限流、并且**多数默认关掉了 `format=json`**。
 * 2. **直抓 SERP**(`serp.ts`):第一层全挂时的出路,顺序固定 Bing → DuckDuckGo → 百度。
 *
 * 只做第一层的话,在很多网络环境下这条兜底等于没有;只做第二层的话,一次页面改版
 * 就把它整个打没。两层同时挂掉的概率,比任何一层单独挂掉都低得多 —— 这是它们
 * 都要留着的全部理由。
 *
 * ## 不变式
 *
 * - **不重试**:任何一步失败就换下一个候选。同一次搜索里对同一个限流的实例重试,
 *   只会把延迟翻倍,而用户看到的只是「搜索好慢」。
 * - **不缓存**:一次会话里重复同一个查询的概率,低于维护一份缓存(和它的失效规则)的成本。
 * - **失败不抛,收集成 failures 往上交**。翻译成人话只发生在 `web-search.ts` 一处
 *   (AGENTS §11 第 3 问:错误在哪一层被翻译)。
 * - **中断立刻停手**:外层 signal 一 abort 就把异常抛出去,不把剩下的候选跑完。
 */
import { BUILTIN_SOURCE_ID, type SearchResult } from '../../../shared/domain/search'
import { withUserAgent } from '../adapters/http'
import type { HarvestedItem } from '../harvest'
import { withTimeout } from '../timeout'
import { enrichSnippets } from './enrich'
import { searxngCandidates } from './instances'
import { searchSearxng, SearxngEmptyError } from './searxng'
import { ENGINES, looksBlocked, parseSerp } from './serp'

/** 一个 SearxNG 实例最多等多久 */
const SEARXNG_TIMEOUT_MS = 4_000
/** 最多试几个实例。候选名单比这个长,但再多试一个就是再多等一个超时 */
const MAX_SEARXNG_TRIES = 3
/** 一家搜索引擎的结果页最多等多久。比 SearxNG 宽一点:这一层是最后的出路 */
const ENGINE_TIMEOUT_MS = 5_000
/** 给前几条补正文 */
const ENRICH_COUNT = 2
/** 正文阶段的总预算 */
const ENRICH_BUDGET_MS = 6_000

export interface BuiltinSearchDeps {
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  /**
   * 用户在「设置 › 连接 › 搜索」底部填的自建 SearxNG 地址,空串 = 没填。
   * ★ 只有这个值会带着「跳过 SSRF 筛查」的许可进 `searchSearxng`,理由见那边的文件头。
   */
  selfHostedSearxng: string
  /**
   * 补正文吗。默认补。
   *
   * 需求:设置页那个「测试」按钮只想知道「这条链路通不通」,而补正文要再花最多 6 秒 ——
   * 按钮多转 6 秒圈,测的还不是它要测的东西。
   */
  enrich?: boolean
}

export interface BuiltinSearchOutcome {
  results: SearchResult[]
  /** 结果来自哪个源(实例域名或引擎名),用于在结果里注明出处。没结果时 undefined */
  sourceLabel?: string
  /**
   * 至少有一个源**正常应答了、但它说没有结果**。
   *
   * 需求:「搜索链路坏了」和「这个词确实搜不到」对模型是两件事 ——
   * 前者换查询词毫无意义,后者正该换。不带这个标记的话,两者都长成
   * 「搜索失败」,于是模型会把同一个查询原样再试一遍。
   */
  reachedEmpty: boolean
  /** 一路上的失败,顺序即尝试顺序。**成功时也带着** —— 理由同 `service.ts` 的 failures */
  failures: string[]
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 实例的域名。给用户看的出处标注里不带路径和查询串 */
function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

export async function runBuiltinSearch(
  query: string,
  count: number,
  deps: BuiltinSearchDeps
): Promise<BuiltinSearchOutcome> {
  const failures: string[] = []
  const selfHosted = deps.selfHostedSearxng.trim()
  const fetchWithUa = withUserAgent(deps.fetch)
  // 见 `BuiltinSearchOutcome.reachedEmpty`:有源正常应答但说没结果时置位
  let reachedEmpty = false

  // ── 第一层:SearxNG ──
  for (const base of searxngCandidates(selfHosted).slice(0, MAX_SEARXNG_TRIES)) {
    try {
      const items = await withTimeout(deps.signal, SEARXNG_TIMEOUT_MS, (signal) =>
        searchSearxng(base, query, {
          fetch: fetchWithUa,
          signal,
          // ★ 只有用户手填的那一个才放宽。相等判断用的是原始字符串,不做归一化 ——
          //   归一化过的地址不再是「用户输入的那个值」,放宽的理由也就不成立了。
          allowPrivate: base === selfHosted && selfHosted !== ''
        })
      )
      return await finish(items, hostOf(base), failures, count, deps)
    } catch (err) {
      // ★ 整个 run 被中断时立刻停手,不接着试下一个候选(同 service.ts 的那条)
      if (deps.signal.aborted) throw err
      if (err instanceof SearxngEmptyError) reachedEmpty = true
      failures.push(`SearxNG ${hostOf(base)}:${messageOf(err)}`)
    }
  }

  // ── 第二层:直抓结果页 ──
  for (const engine of ENGINES) {
    try {
      const html = await withTimeout(deps.signal, ENGINE_TIMEOUT_MS, async (signal) => {
        const res = await fetchWithUa(engine.buildUrl(query, count), {
          signal,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            // 不给这个头的话 Bing / 百度更容易把请求当成爬虫
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
          }
        })
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        return res.text()
      })

      const items = parseSerp(engine.id, html)
      if (items.length > 0) return await finish(items, engine.label, failures, count, deps)

      /*
        需求:零结果要能区分「被挡住」和「解析不出来」。前者换个网络/时间就好,
        后者是这个仓库要修的 bug(引擎改版)。只写「没有结果」的话,
        半年后看到日志的人无从判断该去改哪儿。
      */
      failures.push(
        looksBlocked(html)
          ? `${engine.label}:被拦截(返回的是验证码或异常流量页)。`
          : `${engine.label}:结果页里没解析出条目,可能是它改版了。`
      )
    } catch (err) {
      if (deps.signal.aborted) throw err
      failures.push(`${engine.label}:${messageOf(err)}`)
    }
  }

  return { results: [], reachedEmpty, failures }
}

/** 命中之后的共同收尾:截断 → 补正文 → 打上 `builtin` 出处 */
async function finish(
  items: readonly HarvestedItem[],
  sourceLabel: string,
  failures: string[],
  count: number,
  deps: BuiltinSearchDeps
): Promise<BuiltinSearchOutcome> {
  const top = items.slice(0, count)
  const enriched =
    deps.enrich === false
      ? [...top]
      : await enrichSnippets(
          top,
          { count: ENRICH_COUNT, budgetMs: ENRICH_BUDGET_MS },
          { fetch: deps.fetch, signal: deps.signal }
        )
  return {
    results: enriched.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      provider: BUILTIN_SOURCE_ID,
      ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt })
    })),
    sourceLabel,
    // 拿到结果就不存在「通了但是空」这个问题了
    reachedEmpty: false,
    failures
  }
}
