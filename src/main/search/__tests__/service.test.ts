/**
 * 切换链的用例。**假 fetch,不联网** —— 联网测试会因为别人的服务抖动而红,
 * 而那种红看起来和真 bug 一模一样。
 *
 * 真正要钉住的是三条判断,它们各自对应一种「搜索坏了但看起来不像坏了」:
 * 1. 一家挂了要**换下一家**,而不是把失败原样交给模型
 * 2. 全败要给**聚合错误**,而不是一句「搜索失败」
 * 3. 成功时也要把中途的失败带出来 —— 否则那个填错的 Key 永远不会被发现
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchProviderId, SearchProviderStatus } from '../../../shared/domain/search'
import { SEARCH_CATALOG } from '../../../shared/domain/search'
import { installSearchConfig, resetSearchConfigForTest, runSearch } from '../service'

/** 目录顺序即默认 priority,和 `defaultProviderConfigs()` 一致 */
const PRIORITY = new Map(SEARCH_CATALOG.map((m, i) => [m.id, i]))

function status(id: SearchProviderId, hasKey = true): SearchProviderStatus {
  return { config: { id, enabled: true, priority: PRIORITY.get(id) ?? 99 }, hasKey }
}

/** Tavily 的成功响应形状 */
const tavilyOk = {
  results: [{ title: '标题', url: 'https://example.com/a', content: '一段摘要' }]
}
/** Brave 的成功响应形状 —— 结果在 `web.results` 下,和 Tavily 不同层 */
const braveOk = {
  web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'B 的摘要' }] }
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** 按 URL 里的域名派发 —— 适配器打到哪家,这里就答哪家 */
function routedFetch(
  routes: Record<string, () => Response | Promise<Response>>
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (key === undefined) throw new Error(`测试没有为 ${url} 准备响应`)
    return routes[key]!()
  }) as typeof fetch

  return { fn, calls }
}

function install(statuses: SearchProviderStatus[], keys: Partial<Record<string, string>> = {}): void {
  installSearchConfig({
    statuses: () => Promise.resolve(statuses),
    apiKey: (id) => Promise.resolve(keys[id] ?? 'k-test-key-1234')
  })
}

const signal = (): AbortSignal => new AbortController().signal

beforeEach(() => {
  resetSearchConfigForTest()
})
afterEach(() => {
  resetSearchConfigForTest()
})

describe('runSearch · 故障切换', () => {
  it('第一家 500 就换第二家,并把结果交出来', async () => {
    install([status('tavily'), status('brave')])
    const { fn, calls } = routedFetch({
      'api.tavily.com': () => jsonResponse({ error: '炸了' }, { status: 500 }),
      'api.search.brave.com': () => jsonResponse(braveOk)
    })

    const out = await runSearch('查点东西', 5, { fetch: fn, signal: signal() })

    expect(out.provider).toBe('brave')
    expect(out.results).toHaveLength(1)
    expect(out.results[0]?.url).toBe('https://example.com/b')
    expect(calls).toHaveLength(2)
  })

  /** ★ 零结果**也切**。理由在 `service.ts` 的注释:静默零结果通常是字段改了名 */
  it('第一家返回空数组时也切下一家', async () => {
    install([status('tavily'), status('brave')])
    const { fn } = routedFetch({
      'api.tavily.com': () => jsonResponse({ results: [] }),
      'api.search.brave.com': () => jsonResponse(braveOk)
    })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.provider).toBe('brave')
    expect(out.failures.map((f) => f.id)).toEqual(['tavily'])
  })

  /**
   * ★ 成功了也要把中途的失败带出来 —— 用户那个 401 的 Key
   * 只有在这里才有机会被看见。吞掉的话它会一直错下去。
   */
  it('成功时仍然带着一路上的失败', async () => {
    install([status('tavily'), status('brave')])
    const { fn } = routedFetch({
      'api.tavily.com': () => jsonResponse({ detail: 'invalid api key' }, { status: 401 }),
      'api.search.brave.com': () => jsonResponse(braveOk)
    })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.provider).toBe('brave')
    expect(out.failures).toHaveLength(1)
    // 状态码和服务器的原话都要在,用户据此知道该去改哪个 Key
    expect(out.failures[0]?.message).toContain('401')
    expect(out.failures[0]?.message).toContain('invalid api key')
  })

  it('全败时返回空结果 + 每一家的原因', async () => {
    install([status('tavily'), status('brave')])
    const { fn } = routedFetch({
      'api.tavily.com': () => jsonResponse({}, { status: 500 }),
      'api.search.brave.com': () => {
        throw new Error('ECONNREFUSED')
      }
    })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.results).toEqual([])
    expect(out.provider).toBeUndefined()
    expect(out.failures.map((f) => f.id)).toEqual(['tavily', 'brave'])
    expect(out.failures[1]?.message).toContain('ECONNREFUSED')
  })

  it('按 priority 升序试,不是按传进来的数组顺序', async () => {
    // 故意把 brave 放在数组前面,但它的 priority 比 tavily 大
    install([status('brave'), status('tavily')])
    const { fn, calls } = routedFetch({
      'api.tavily.com': () => jsonResponse(tavilyOk),
      'api.search.brave.com': () => jsonResponse(braveOk)
    })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.provider).toBe('tavily')
    expect(calls).toHaveLength(1)
  })
})

describe('runSearch · 根本不该进链的', () => {
  /** ★ 没 Key 的家**一次 HTTP 都不发**。发了的话症状是「搜索变慢了」而不是「我忘了填 Key」 */
  it('没配 Key 的家不发请求', async () => {
    install([status('tavily', false), status('brave')])
    const { fn, calls } = routedFetch({ 'api.search.brave.com': () => jsonResponse(braveOk) })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.provider).toBe('brave')
    expect(calls.some((c) => c.includes('tavily'))).toBe(false)
  })

  it('关掉的家不进链', async () => {
    const off = status('tavily')
    off.config.enabled = false
    install([off, status('brave')])
    const { fn, calls } = routedFetch({ 'api.search.brave.com': () => jsonResponse(braveOk) })

    await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(calls.some((c) => c.includes('tavily'))).toBe(false)
  })

  /** 标了 `unavailable` 的家没有适配器,连尝试都不该有 */
  it('用不了的家(bing / doubao)被跳过', async () => {
    install([status('bing'), status('doubao'), status('brave')])
    const { fn, calls } = routedFetch({ 'api.search.brave.com': () => jsonResponse(braveOk) })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.provider).toBe('brave')
    expect(calls).toHaveLength(1)
  })

  it('一家都没配时返回空,且 failures 也是空', async () => {
    install([])
    const { fn, calls } = routedFetch({})

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    // ★ 这两个空的组合,就是 web_search 用来说「你还没配搜索服务」的依据
    expect(out.results).toEqual([])
    expect(out.failures).toEqual([])
    expect(calls).toEqual([])
  })

  it('没装配过就调用是接线错误,直接抛', async () => {
    const { fn } = routedFetch({})
    await expect(runSearch('q', 5, { fetch: fn, signal: signal() })).rejects.toThrow('装配')
  })
})

describe('runSearch · 中断', () => {
  /** ★ 用户按了停止,不能接着把剩下几家挨个跑一遍 */
  it('整个 run 被中断时立刻抛,不试下一家', async () => {
    install([status('tavily'), status('brave')])
    const ctl = new AbortController()
    const { fn, calls } = routedFetch({
      'api.tavily.com': () => {
        ctl.abort()
        throw new Error('aborted')
      },
      'api.search.brave.com': () => jsonResponse(braveOk)
    })

    await expect(runSearch('q', 5, { fetch: fn, signal: ctl.signal })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})

describe('runSearch · 结果条数', () => {
  it('多给的结果按 count 截断', async () => {
    const many = {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `t${String(i)}`,
        url: `https://example.com/${String(i)}`,
        content: 'c'
      }))
    }
    install([status('tavily')])
    const { fn } = routedFetch({ 'api.tavily.com': () => jsonResponse(many) })

    const out = await runSearch('q', 3, { fetch: fn, signal: signal() })
    expect(out.results).toHaveLength(3)
  })

  /** provider 字段必须是发出请求的那家 —— 结果里要标出来源,模型据此判断可信度 */
  it('每条结果都标着来源', async () => {
    install([status('tavily')])
    const { fn } = routedFetch({ 'api.tavily.com': () => jsonResponse(tavilyOk) })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.results.every((r) => r.provider === 'tavily')).toBe(true)
  })
})

describe('适配器 · 请求形状', () => {
  /** 各家的鉴权头完全不同,写错了只会得到 401 —— 这里把核对到的那一版钉住 */
  it('鉴权头按各家文档发', async () => {
    const seen: Array<[string, Headers]> = []
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push([url, new Headers(init?.headers)])
      return jsonResponse({ results: [], web: { results: [] }, organic: [] })
    }) as typeof fetch

    for (const id of ['tavily', 'exa', 'brave', 'serper', 'serpapi'] as const) {
      resetSearchConfigForTest()
      install([status(id)], { [id]: 'secret-key-abcd' })
      await runSearch('q', 3, { fetch: fn, signal: signal() })
    }

    const headerOf = (frag: string, name: string): string | null =>
      seen.find(([u]) => u.includes(frag))?.[1].get(name) ?? null

    expect(headerOf('api.tavily.com', 'authorization')).toBe('Bearer secret-key-abcd')
    expect(headerOf('api.exa.ai', 'x-api-key')).toBe('secret-key-abcd')
    expect(headerOf('api.search.brave.com', 'x-subscription-token')).toBe('secret-key-abcd')
    expect(headerOf('google.serper.dev', 'x-api-key')).toBe('secret-key-abcd')
    // ★ SerpApi 没有请求头方案,Key 只能进查询串 —— 见那个适配器的文件头
    expect(seen.find(([u]) => u.includes('serpapi.com'))?.[0]).toContain('api_key=secret-key-abcd')
  })

  /**
   * ★ SerpApi 出错时,**URL 一个字都不能进错误信息** —— Key 在里面。
   * 这条断言的失败症状很具体:用户把界面上那句报错贴进群里求助,顺手泄了 Key。
   */
  it('SerpApi 的错误信息里没有 Key', async () => {
    install([status('serpapi')], { serpapi: 'sk-should-never-leak' })
    const { fn } = routedFetch({
      'serpapi.com': () => jsonResponse({ error: 'Invalid API key' }, { status: 401 })
    })

    const out = await runSearch('q', 5, { fetch: fn, signal: signal() })
    expect(out.failures[0]?.message).not.toContain('sk-should-never-leak')
    expect(out.failures[0]?.message).toContain('401')
  })

  it('查询词真的进了请求体 / 查询串', async () => {
    const bodies: string[] = []
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      bodies.push(typeof init?.body === 'string' ? init.body : url)
      return jsonResponse({ results: [] })
    }) as typeof fetch

    install([status('tavily')])
    await runSearch('中文查询词', 7, { fetch: fn, signal: signal() })

    const body = JSON.parse(bodies[0]!) as { query: string; max_results: number }
    expect(body.query).toBe('中文查询词')
    expect(body.max_results).toBe(7)
  })
})
