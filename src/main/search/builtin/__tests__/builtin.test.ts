/**
 * 免 Key 兜底链路的编排用例 —— **假 fetch,不联网**(理由同 `search/__tests__/service.test.ts`:
 * 真联网的测试会因为别人的服务抖动而红,而那种红和真 bug 长得一模一样)。
 *
 * 这里钉的是四件「坏了也不会报错」的事:
 * 1. SearxNG 通就不去直抓引擎(省掉三次请求)
 * 2. SearxNG 全挂要真的退到直抓,且按 Bing → DuckDuckGo → 百度 的固定顺序
 * 3. 补正文失败**不能**把整次搜索变成零结果
 * 4. 用户按停止时立刻停手,不把剩下的候选跑完
 */
import { describe, expect, it } from 'vitest'
import { runBuiltinSearch } from '../index'
import { searxngCandidates } from '../instances'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const SEARX_OK = {
  results: [
    { title: 'S1', url: 'https://example.com/1', content: '摘要一' },
    { title: 'S2', url: 'https://example.com/2', content: '摘要二' }
  ]
}

const BING_OK = `<li class="b_algo"><h2><a href="https://example.com/bing">B</a></h2><p>Bing 摘要</p></li>`

/** 按 URL 片段派发的假 fetch。没命中任何一条就抛 —— 等价于「这个域名连不上」 */
function routedFetch(routes: Record<string, (url: string) => Response | Promise<Response>>): {
  fn: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (key === undefined) throw new Error('连不上')
    return routes[key]!(url)
  }) as typeof fetch
  return { fn, calls }
}

const deps = (fn: typeof fetch, selfHostedSearxng = ''): Parameters<typeof runBuiltinSearch>[2] => ({
  fetch: fn,
  signal: new AbortController().signal,
  selfHostedSearxng
})

describe('searxngCandidates', () => {
  it('自建实例排第一', () => {
    expect(searxngCandidates('https://my.searx.test')[0]).toBe('https://my.searx.test')
  })

  it('没填自建实例时就是内置名单', () => {
    expect(searxngCandidates('').length).toBeGreaterThan(0)
    expect(searxngCandidates('   ')).toEqual(searxngCandidates(''))
  })

  /** 自建地址正好等于内置名单里的一个时,不该白试两遍 */
  it('按 origin 去重', () => {
    const builtin = searxngCandidates('')
    const first = builtin[0]!
    // 末尾多一个斜杠是同一个 origin
    expect(searxngCandidates(`${first}/`)).toHaveLength(builtin.length)
  })
})

describe('runBuiltinSearch · 第一层命中', () => {
  it('SearxNG 通了就不去抓引擎结果页', async () => {
    const { fn, calls } = routedFetch({
      searx: () => jsonResponse(SEARX_OK),
      'example.com': () => htmlResponse('<html><body><p>正文内容</p></body></html>')
    })

    const out = await runBuiltinSearch('q', 5, deps(fn))

    expect(out.results).toHaveLength(2)
    expect(out.results[0]?.provider).toBe('builtin')
    expect(out.sourceLabel).toBe('searx.be')
    expect(calls.some((c) => c.includes('bing.com'))).toBe(false)
  })

  /** ★ 自建实例优先,而且它是唯一允许指向本机的地址(见 searxng.ts 文件头) */
  it('填了自建实例就先打它,本机地址也放行', async () => {
    const { fn, calls } = routedFetch({
      'localhost:8080': () => jsonResponse(SEARX_OK),
      'example.com': () => htmlResponse('<p>正文</p>')
    })

    const out = await runBuiltinSearch('q', 2, deps(fn, 'http://localhost:8080'))

    expect(out.sourceLabel).toBe('localhost:8080')
    expect(calls[0]).toContain('localhost:8080')
  })

  /** 查询词必须经 URLSearchParams 编码,手拼的话中文会送错 */
  it('中文查询词被正确编码', async () => {
    const { fn, calls } = routedFetch({
      searx: () => jsonResponse(SEARX_OK),
      'example.com': () => htmlResponse('<p>正文</p>')
    })

    await runBuiltinSearch('中文 查询', 1, deps(fn))
    expect(new URL(calls[0]!).searchParams.get('q')).toBe('中文 查询')
  })
})

describe('runBuiltinSearch · 退到直抓', () => {
  it('SearxNG 全挂时按 Bing → DDG → 百度 的顺序去抓结果页', async () => {
    const { fn, calls } = routedFetch({
      searx: () => jsonResponse({ results: [] }),
      'bing.com': () => htmlResponse(BING_OK),
      'example.com': () => htmlResponse('<p>正文</p>')
    })

    const out = await runBuiltinSearch('q', 3, deps(fn))

    expect(out.sourceLabel).toBe('Bing')
    expect(out.results[0]?.url).toBe('https://example.com/bing')
    // 第一家就成了,后两家不该再试
    expect(calls.some((c) => c.includes('duckduckgo.com'))).toBe(false)
    expect(calls.some((c) => c.includes('baidu.com'))).toBe(false)
  })

  it('两层全挂时返回空结果 + 每一步的原因', async () => {
    const { fn } = routedFetch({})
    const out = await runBuiltinSearch('q', 3, deps(fn))

    expect(out.results).toEqual([])
    expect(out.sourceLabel).toBeUndefined()
    // SearxNG 三个候选 + 三家引擎,每一条都要说清是谁、为什么
    expect(out.failures.length).toBeGreaterThanOrEqual(4)
    expect(out.failures.some((f) => f.includes('Bing'))).toBe(true)
  })

  /** ★ 「被挡住」和「解析不出来」要能分辨,否则半年后没人知道该去改哪儿 */
  it('被验证码挡住时说的是被拦截,不是没结果', async () => {
    const { fn } = routedFetch({
      searx: () => jsonResponse({ results: [] }),
      'bing.com': () => htmlResponse('<html><body>请完成安全验证</body></html>'),
      'duckduckgo.com': () => htmlResponse('<html><body>空</body></html>')
    })

    const out = await runBuiltinSearch('q', 3, deps(fn))
    expect(out.failures.some((f) => f.includes('Bing') && f.includes('拦截'))).toBe(true)
    expect(out.failures.some((f) => f.includes('DuckDuckGo') && f.includes('改版'))).toBe(true)
  })

  /** 实例好好的、只是这个词没结果 —— 模型据此知道「换个词是有意义的」 */
  it('实例正常应答但零结果时置 reachedEmpty', async () => {
    const { fn } = routedFetch({ searx: () => jsonResponse({ results: [] }) })
    const out = await runBuiltinSearch('q', 3, deps(fn))
    expect(out.reachedEmpty).toBe(true)
  })

  it('实例返回 HTML(关了 format=json)时不算「真的没结果」', async () => {
    const { fn } = routedFetch({ searx: () => htmlResponse('<html>搜索页</html>') })
    const out = await runBuiltinSearch('q', 3, deps(fn))
    expect(out.reachedEmpty).toBe(false)
    expect(out.failures.some((f) => f.includes('JSON'))).toBe(true)
  })
})

describe('runBuiltinSearch · 补正文', () => {
  it('抓到正文时替换掉 SERP 摘要', async () => {
    const { fn } = routedFetch({
      searx: () => jsonResponse(SEARX_OK),
      'example.com/1': () => htmlResponse('<html><body><p>第一条的正文段落</p></body></html>'),
      'example.com/2': () => htmlResponse('<html><body><p>第二条的正文段落</p></body></html>')
    })

    const out = await runBuiltinSearch('q', 5, deps(fn))
    expect(out.results[0]?.snippet).toContain('第一条的正文段落')
  })

  /** ★ 这条是那条不变式:正文抓不到只是少一点上下文,绝不能把整次搜索变成零结果 */
  it('正文全部抓失败时,结果列表照常返回并保留原摘要', async () => {
    const { fn } = routedFetch({
      searx: () => jsonResponse(SEARX_OK),
      'example.com': () => {
        throw new Error('打不开')
      }
    })

    const out = await runBuiltinSearch('q', 5, deps(fn))
    expect(out.results).toHaveLength(2)
    expect(out.results[0]?.snippet).toBe('摘要一')
  })

  it('正文是二进制时跳过,不把乱码塞进摘要', async () => {
    const { fn } = routedFetch({
      searx: () => jsonResponse(SEARX_OK),
      'example.com': () => new Response('\u0000\u0001', { headers: { 'content-type': 'image/png' } })
    })

    const out = await runBuiltinSearch('q', 5, deps(fn))
    expect(out.results[0]?.snippet).toBe('摘要一')
  })

  /** 测试按钮用的那条路径:只问通不通,不该为它多花最多 6 秒去抓正文 */
  it('enrich: false 时一次正文都不抓', async () => {
    const { fn, calls } = routedFetch({ searx: () => jsonResponse(SEARX_OK) })

    const out = await runBuiltinSearch('q', 5, { ...deps(fn), enrich: false })
    expect(out.results).toHaveLength(2)
    expect(calls.some((c) => c.includes('example.com'))).toBe(false)
  })
})

describe('runBuiltinSearch · 中断', () => {
  /** ★ 用户按了停止,不能把剩下的候选和三家引擎挨个跑完 */
  it('中断时立刻抛,不试下一个候选', async () => {
    const ctl = new AbortController()
    const calls: string[] = []
    const fn = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      ctl.abort()
      throw new Error('aborted')
    }) as typeof fetch

    await expect(
      runBuiltinSearch('q', 3, { fetch: fn, signal: ctl.signal, selfHostedSearxng: '' })
    ).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})
