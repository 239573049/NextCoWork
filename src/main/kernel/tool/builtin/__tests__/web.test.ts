import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { WEB_LIMITS, webFetchTool } from '../web'

/**
 * `WebFetch` 的测试。**一个真请求都不发**:fetch 从 `nodeHost({ fetch })` 注进去,
 * DNS 用 `vi.mock` 顶掉。
 *
 * ★ 顶掉 DNS 不是为了跑得快,是为了让「公网域名解析到内网地址」这一条**能测**。
 * 用真 DNS 的话那条只能靠一个真实存在、且真的解析到 127.0.0.1 的域名 ——
 * 而那种域名什么时候失效我们控制不了。顺带也让整个文件在离线机器上照跑。
 */

/** 域名 → 解析结果。没登记的域名一律解析成一个公网地址。 */
const dnsTable = vi.hoisted(() => new Map<string, string[]>())

vi.mock('node:dns', () => ({
  promises: {
    lookup: (host: string): Promise<Array<{ address: string }>> =>
      Promise.resolve((dnsTable.get(host) ?? ['93.184.216.34']).map((address) => ({ address })))
  }
}))

/** fetch 的假实现:按 URL 字符串查一张表 */
let routes = new Map<string, Response>()
let seen: string[] = []

function res(
  body: string,
  init: { status?: number; type?: string; location?: string } = {}
): Response {
  const headers = new Headers()
  if (init.type !== undefined) headers.set('content-type', init.type)
  if (init.location !== undefined) headers.set('location', init.location)
  return new Response(body, { status: init.status ?? 200, headers })
}

/** 3xx + Location。★ 不用 `new Response(null, {status:302})` —— 统一走 `res()` */
function redirect(to: string, status = 302): Response {
  return res('', { status, location: to, type: 'text/html' })
}

function route(url: string, r: Response): void {
  routes.set(url, r)
}

const fakeFetch = ((input: URL | RequestInfo): Promise<Response> => {
  const key = input instanceof URL ? input.toString() : String(input)
  seen.push(key)
  const hit = routes.get(key)
  if (hit === undefined) return Promise.reject(new Error(`没有为 ${key} 注册假响应`))
  return Promise.resolve(hit)
}) as typeof fetch

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: '/tmp/ws',
    signal: new AbortController().signal,
    permissionMode: 'full',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost({ fetch: fakeFetch }),
    emit: () => {},
    ...over
  }
}

const P = { prompt: '这一页在讲什么' }

beforeEach(() => {
  routes = new Map()
  seen = []
  dnsTable.clear()
})

describe('WebFetch · 标记', () => {
  it('★ needsNetwork —— 它是这道联网开关唯一要拦的工具', () => {
    expect(webFetchTool.needsNetwork).toBe(true)
  })

  it('★ readOnly —— 联网不靠 readOnly 管,靠闸门那张表的第 1 行', () => {
    expect(webFetchTool.readOnly).toBe(true)
    expect(webFetchTool.destructive).toBe(false)
  })
})

describe('WebFetch · 地址闸门', () => {
  it('URL 格式不对时直接拒,不发请求', async () => {
    const r = await webFetchTool.execute({ url: 'not a url', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(seen).toEqual([])
  })

  it('★ 本机地址被拒,而且一个请求都没发出去', async () => {
    const r = await webFetchTool.execute({ url: 'http://127.0.0.1:3000/', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('private-network')
    expect(seen).toEqual([])
  })

  it('★ 云元数据端点被拒', async () => {
    const r = await webFetchTool.execute(
      { url: 'http://169.254.169.254/latest/meta-data/', ...P },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(seen).toEqual([])
  })

  it('file:// 被拒,并指路到 Read', async () => {
    const r = await webFetchTool.execute({ url: 'file:///etc/passwd', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Read')
  })

  it('★ http 自动升级成 https —— 发出去的是 https', async () => {
    route('https://example.com/a', res('hello', { type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'http://example.com/a', ...P }, ctx())
    expect(r.isError).toBeFalsy()
    expect(seen).toEqual(['https://example.com/a'])
  })

  it('★ 公网域名解析到内网地址时被拒 —— DNS 那一层', async () => {
    dnsTable.set('evil.example.com', ['127.0.0.1'])
    route('https://evil.example.com/', res('x', { type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'https://evil.example.com/', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('127.0.0.1')
    expect(seen).toEqual([])
  })

  it('多条 A 记录里只要有一条是内网就拒', async () => {
    dnsTable.set('mixed.example.com', ['93.184.216.34', '10.0.0.5'])
    route('https://mixed.example.com/', res('x', { type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'https://mixed.example.com/', ...P }, ctx())
    expect(r.isError).toBe(true)
  })
})

describe('WebFetch · 重定向', () => {
  it('★ 同主机的重定向跟过去', async () => {
    route('https://example.com/a', redirect('/b'))
    route('https://example.com/b', res('final body', { type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/a', ...P }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('final body')
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('★ 重定向到内网地址被拒 —— 只查第一个 URL 的实现在这里会放行', async () => {
    route('https://example.com/a', redirect('http://169.254.169.254/latest/meta-data/'))
    const r = await webFetchTool.execute({ url: 'https://example.com/a', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('redirect')
    // 第二跳**没有**被请求
    expect(seen).toEqual(['https://example.com/a'])
  })

  it('★ 重定向目标的 DNS 也要查 —— 每一跳的标准和第一跳完全一样', async () => {
    // 先证明同主机重定向本身是通的(否则下面那条红了也说明不了问题)
    route('https://ok.example.com/a', redirect('https://ok.example.com/b'))
    route('https://ok.example.com/b', res('x', { type: 'text/plain' }))
    const good = await webFetchTool.execute({ url: 'https://ok.example.com/a', ...P }, ctx())
    expect(good.isError).toBeFalsy()

    // 同样的形状,只是这个域名解析到内网 —— 第二跳必须被拦
    dnsTable.set('sneaky.example.com', ['192.168.1.1'])
    route('https://sneaky.example.com/a', redirect('https://sneaky.example.com/b'))
    const r = await webFetchTool.execute({ url: 'https://sneaky.example.com/a', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('192.168.1.1')
  })

  it('★ 跨主机重定向停下来问模型,不默默跟过去', async () => {
    route('https://example.com/a', redirect('https://other.example.org/b'))
    const r = await webFetchTool.execute({ url: 'https://example.com/a', ...P }, ctx())
    // 这不是错误 —— 是「换个地址再调一次」的指示
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('https://other.example.org/b')
    expect(r.output.content).toContain('call WebFetch again')
    expect(seen).toEqual(['https://example.com/a'])
  })

  it(`★ 重定向链最多跟 ${String(WEB_LIMITS.MAX_REDIRECTS)} 跳,不会无限转圈`, async () => {
    // 自己指向自己:没有上限的话这里会挂死
    route('https://example.com/loop', redirect('/loop'))
    const r = await webFetchTool.execute({ url: 'https://example.com/loop', ...P }, ctx())
    expect(seen.length).toBe(WEB_LIMITS.MAX_REDIRECTS + 1)
    expect(r.isError).toBe(true)
  })

  it('重定向地址无法解析时报错', async () => {
    route('https://example.com/a', redirect('http://['))
    const r = await webFetchTool.execute({ url: 'https://example.com/a', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('redirect')
  })

  it('3xx 但没有 Location 时不当重定向,按当前响应处理', async () => {
    route('https://example.com/a', res('三百零二但没有去处', { status: 302, type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/a', ...P }, ctx())
    expect(r.isError).toBe(true) // 302 不是 ok
    expect(seen).toEqual(['https://example.com/a'])
  })
})

describe('WebFetch · content-type 白名单', () => {
  const OK: Array<[string, string]> = [
    ['text/html; charset=utf-8', 'html'],
    ['text/plain', 'plain'],
    ['application/json', 'json'],
    ['application/xml', 'xml'],
    ['application/ld+json', 'ld+json'],
    ['application/rss+xml', 'rss'],
    ['text/markdown', 'markdown']
  ]
  for (const [type, label] of OK) {
    it(`接受 ${label}`, async () => {
      route('https://example.com/x', res('可读的正文内容', { type }))
      const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
      expect(r.isError, type).toBeFalsy()
    })
  }

  const BAD = [
    'application/pdf',
    'image/png',
    'application/zip',
    'application/octet-stream',
    'video/mp4'
  ]
  for (const type of BAD) {
    it(`★ 拒绝 ${type},并告诉模型该怎么办`, async () => {
      route('https://example.com/x', res('二进制', { type }))
      const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
      expect(r.isError, type).toBe(true)
      expect(r.output.content).toContain('Read')
    })
  }

  it('★ 没有 content-type 时按未知类型拒绝 —— 白名单不是黑名单', async () => {
    // 空串 = 服务器没给。★ 用 `new Response('x')` 造不出这个场景 ——
    // undici 会替字符串 body 自动补上 text/plain,于是这条会假绿。
    route('https://example.com/x', res('whatever', { type: '' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('an unknown type')
  })
})

describe('WebFetch · 正文', () => {
  it('★ prompt 原样放在正文前面 —— 读完几万字符之后模型还记得自己在找什么', async () => {
    route('https://example.com/x', res('正文在这里', { type: 'text/plain' }))
    const r = await webFetchTool.execute(
      { url: 'https://example.com/x', prompt: '这个库怎么安装' },
      ctx()
    )
    expect(r.output.content.indexOf('这个库怎么安装')).toBeLessThan(
      r.output.content.indexOf('正文在这里')
    )
  })

  it('HTML 被转成正文文本:标签去掉、块级元素之间留换行', async () => {
    route(
      'https://example.com/p',
      res(
        '<html><head><style>.x{color:red}</style><script>var a=1</script></head>' +
          '<body><h1>标题</h1><p>第一段</p><p>第二段</p><ul><li>甲</li><li>乙</li></ul></body></html>',
        { type: 'text/html' }
      )
    )
    const r = await webFetchTool.execute({ url: 'https://example.com/p', ...P }, ctx())
    const c = r.output.content
    expect(c).toContain('标题')
    expect(c).toContain('第一段')
    expect(c).toContain('- 甲')
    // ★ script / style 的内容必须整段丢掉,它们能占掉整页的体积
    expect(c).not.toContain('color:red')
    expect(c).not.toContain('var a=1')
    expect(c).not.toContain('<p>')
  })

  it('HTML 实体被还原', async () => {
    route(
      'https://example.com/e',
      res('<p>a &amp; b &lt;c&gt; &#39;d&#39; &#65;</p>', { type: 'text/html' })
    )
    const r = await webFetchTool.execute({ url: 'https://example.com/e', ...P }, ctx())
    expect(r.output.content).toContain("a & b <c> 'd' A")
  })

  it('JSON 不会被当成 HTML 洗掉尖括号', async () => {
    route('https://example.com/j', res('{"a":"<b>"}', { type: 'application/json' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/j', ...P }, ctx())
    expect(r.output.content).toContain('{"a":"<b>"}')
  })

  it(`★ 正文超过 ${String(WEB_LIMITS.MAX_TEXT_CHARS / 1000)}k 字符时截断,并说明截过`, async () => {
    route(
      'https://example.com/big',
      res('好'.repeat(WEB_LIMITS.MAX_TEXT_CHARS + 5000), { type: 'text/plain' })
    )
    const r = await webFetchTool.execute({ url: 'https://example.com/big', ...P }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('truncated')
    expect(r.output.content.length).toBeLessThan(WEB_LIMITS.MAX_TEXT_CHARS + 2000)
  })

  it('空页面给的是提示而不是一段空白', async () => {
    route(
      'https://example.com/spa',
      res('<html><body><div id="root"></div></body></html>', { type: 'text/html' })
    )
    const r = await webFetchTool.execute({ url: 'https://example.com/spa', ...P }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('JavaScript')
  })

  /**
   * ★ 抓回来的正文是**不可信输入**:它会原样进上下文,而一个 ANSI 转义或 NUL
   * 落在里面之后,谁也说不清下游(日志、终端、转录渲染)会拿它做什么。
   * 这里刻意用 `String.fromCharCode` 造字符,而不是在源码里写字面控制字符 ——
   * 后者在编辑器和 diff 里都是隐形的。
   */
  it('★ 控制字符被洗掉 —— 抓回来的内容是不可信输入', async () => {
    const ESC = String.fromCharCode(27)
    const NUL = String.fromCharCode(0)
    route('https://example.com/ansi', res(`前${ESC}[31m红${NUL} 后`, { type: 'text/plain' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/ansi', ...P }, ctx())
    expect(r.output.content).not.toContain(ESC)
    expect(r.output.content).not.toContain(NUL)
    expect(r.output.content).toContain('红')
  })
})

describe('WebFetch · HTTP 错误', () => {
  for (const status of [401, 403]) {
    it(`${String(status)} 明说重试没用`, async () => {
      route('https://example.com/x', res('nope', { status, type: 'text/html' }))
      const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
      expect(r.isError).toBe(true)
      expect(r.output.content).toContain('Retrying will not help')
    })
  }

  it('404 提示换来源', async () => {
    route('https://example.com/x', res('nope', { status: 404, type: 'text/html' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('does not exist')
  })

  it('500 也是错误,并带上状态码', async () => {
    route('https://example.com/x', res('boom', { status: 500, type: 'text/html' }))
    const r = await webFetchTool.execute({ url: 'https://example.com/x', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('500')
  })

  it('网络层报错时给出人话,并明说反复重试没用', async () => {
    const r = await webFetchTool.execute({ url: 'https://nowhere.example.com/', ...P }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('retrying the same URL')
  })
})

describe('WebFetch · 中断', () => {
  it('★ 用户点停止时**抛出**中断,不包成一个普通失败', async () => {
    const ac = new AbortController()
    const hangingFetch = ((_i: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })) as typeof fetch

    const p = webFetchTool.execute(
      { url: 'https://example.com/slow', ...P },
      ctx({ signal: ac.signal, host: nodeHost({ fetch: hangingFetch }) })
    )
    setTimeout(() => {
      ac.abort()
    }, 10)
    await expect(p).rejects.toThrow()
  })
})
