/**
 * 回环服务器的测试。全部用 `port: 0`(临时端口),于是不碰真的 1455 ——
 * 生产用固定端口的理由见 `oauth-loopback.ts`,但测试没有理由去抢它。
 */
import { describe, expect, it } from 'vitest'
import { awaitOAuthCallback, PortBusyError } from '../oauth-loopback'

const PATH = '/auth/callback'

/**
 * 起服务器 + 拿到端口 + 发一个请求,是每条用例都要做的三件事。
 *
 * ★ 必须**同时等** `done` 和那个 `hit`:`done` 在 handler 里就 resolve 了,
 * 而 `hit` 里读 body 的那一步还没跑完 —— 只等前者的话,断言会读到空字符串,
 * 而且是**偶发**的(取决于两个微任务谁先跑完)。
 */
async function withServer(
  opts: { state: string; signal?: AbortSignal; timeoutMs?: number; codeParam?: string },
  hit: (port: number) => Promise<unknown>
): Promise<Awaited<ReturnType<typeof awaitOAuthCallback>>> {
  const ctrl = new AbortController()
  let hitDone: Promise<unknown> = Promise.resolve()
  const done = awaitOAuthCallback({
    expectedState: opts.state,
    signal: opts.signal ?? ctrl.signal,
    path: PATH,
    port: 0,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.codeParam === undefined ? {} : { codeParam: opts.codeParam }),
    onListening: (port) => {
      hitDone = hit(port)
    }
  })
  const result = await done
  await hitDone
  return result
}

describe('awaitOAuthCallback · 正常回调', () => {
  it('state 对得上时把 code 交出来', async () => {
    const r = await withServer({ state: 's-1' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?code=the-code&state=s-1`)
    })
    expect(r).toEqual({ status: 'ok', code: 'the-code' })
  })

  it('★★ codeParam 可以换名字 —— 智谱回的是 authCode 而不是 code', async () => {
    const r = await withServer({ state: 's-1', codeParam: 'authCode' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?authCode=the-code&state=s-1`)
    })
    expect(r).toEqual({ status: 'ok', code: 'the-code' })
  })

  it('★ 换了名字之后，标准的 code 参数就**不再**被接受（不是「两个都认」）', async () => {
    /*
      两个都认看着更宽容，实际是把一个安全判断变成了猜：同一次回调里若两个参数
      都在，取哪个？这里的选择是「说好读哪个就只读哪个」，读不到就按 denied 走。
    */
    const r = await withServer({ state: 's-1', codeParam: 'authCode' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?code=the-code&state=s-1`)
    })
    expect(r.status).toBe('denied')
    expect(r.code).toBeUndefined()
  })

  it('回的是一张自包含的 HTML 页 —— 用户唯一能看到结果的地方就是那个标签页', async () => {
    let body = ''
    await withServer({ state: 's-1' }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}${PATH}?code=c&state=s-1`)
      body = await res.text()
      expect(res.headers.get('content-type')).toContain('text/html')
    })
    expect(body).toContain('<!doctype html>')
    // 零外部资源:断网/被墙时这一页也不能变成一堆没样式的字
    expect(body).not.toMatch(/<(?:link|script)\b/u)
  })
})

describe('awaitOAuthCallback · 安全边界', () => {
  it('★★ state 不匹配 —— 绝不交出 code（这条防的是 CSRF：攻击者的 code 绑到用户账号上）', async () => {
    const r = await withServer({ state: 's-1' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?code=attacker-code&state=s-evil`)
    })
    expect(r.status).toBe('denied')
    expect(r.code).toBeUndefined()
  })

  it('state 缺失同样拒绝', async () => {
    const r = await withServer({ state: 's-1' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?code=c`)
    })
    expect(r.status).toBe('denied')
    expect(r.code).toBeUndefined()
  })

  it('★ 别的路径一律 404 空体 —— 多一条路由就多一个面', async () => {
    const r = await withServer({ state: 's-1', timeoutMs: 400 }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/anything-else`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
      // 打完别的路径之后,真正的回调仍然收得到
      await fetch(`http://127.0.0.1:${port}${PATH}?code=c&state=s-1`)
    })
    expect(r).toEqual({ status: 'ok', code: 'c' })
  })

  it('授权服务器回 error 时带出原因', async () => {
    const r = await withServer({ state: 's-1' }, async (port) => {
      await fetch(`http://127.0.0.1:${port}${PATH}?error=access_denied&state=s-1`)
    })
    expect(r.status).toBe('denied')
    expect(r.reason).toBe('access_denied')
  })
})

describe('awaitOAuthCallback · 用户放弃', () => {
  it('★ 超时 resolve 成 timeout，不抛 —— 「把授权页关掉了」是正常结局不是异常', async () => {
    const ctrl = new AbortController()
    const r = await awaitOAuthCallback({
      expectedState: 's',
      signal: ctrl.signal,
      path: PATH,
      port: 0,
      timeoutMs: 60
    })
    expect(r).toEqual({ status: 'timeout' })
  })

  it('★ abort resolve 成 cancelled，不抛', async () => {
    const ctrl = new AbortController()
    const p = awaitOAuthCallback({
      expectedState: 's',
      signal: ctrl.signal,
      path: PATH,
      port: 0,
      timeoutMs: 5_000
    })
    ctrl.abort()
    expect(await p).toEqual({ status: 'cancelled' })
  })
})

describe('awaitOAuthCallback · 端口被占', () => {
  it('★★ 抛 PortBusyError，而不是换一个端口 —— 换了会在授权页得到 redirect_uri mismatch', async () => {
    const ctrl = new AbortController()
    let busyPort = 0
    // 先占住一个端口
    const holder = awaitOAuthCallback({
      expectedState: 'a',
      signal: ctrl.signal,
      path: PATH,
      port: 0,
      timeoutMs: 3_000,
      onListening: (p) => {
        busyPort = p
      }
    })
    // 等它 listen 完
    await new Promise((r) => setTimeout(r, 50))
    expect(busyPort).toBeGreaterThan(0)

    await expect(
      awaitOAuthCallback({
        expectedState: 'b',
        signal: new AbortController().signal,
        path: PATH,
        port: busyPort,
        timeoutMs: 500
      })
    ).rejects.toBeInstanceOf(PortBusyError)

    ctrl.abort()
    await holder
  })
})

describe('awaitOAuthCallback · linger', () => {
  it('★ linger 期内的迟到请求吃到的仍是校验过的页面', async () => {
    /*
      ★ 这是给 cli-poll 双通道用的:B 通道(轮询)先赢时,浏览器可能正走在跳转
      途中 —— 立刻关服务器它会撞上 ECONNREFUSED,看到一个像「登录失败」的
      错误页。linger 期内迟到请求要能拿到正常的页面,且不改写已落定的结局。
    */
    const ctrl = new AbortController()
    let port = 0
    const done = awaitOAuthCallback({
      expectedState: 's-2',
      signal: ctrl.signal,
      path: PATH,
      port: 0,
      timeoutMs: 3_000,
      lingerMs: 600,
      // ★ 主回调放在 onListening 里发 —— 外面发的话 port 还没被赋值(=0)
      onListening: async (p) => {
        port = p
        await fetch(`http://127.0.0.1:${p}${PATH}?code=c2&state=s-2`)
      }
    })
    // 主回调(state 对)先到,结局落定 —— 而且落定**不等** linger(后台关机)
    const startedAt = Date.now()
    expect(await done).toEqual({ status: 'ok', code: 'c2' })
    expect(Date.now() - startedAt).toBeLessThan(300)

    // 迟到的请求:state 错 → 400 页面(不是连接拒绝);state 对 → 200
    const stragglerBad = await fetch(`http://127.0.0.1:${port}${PATH}?code=x&state=wrong`)
    expect(stragglerBad.status).toBe(400)
    const stragglerOk = await fetch(`http://127.0.0.1:${port}${PATH}?code=y&state=s-2`)
    expect(stragglerOk.status).toBe(200)

    // linger 到点之后,服务器真的关了
    await new Promise((r) => setTimeout(r, 700))
    await expect(fetch(`http://127.0.0.1:${port}${PATH}?code=z&state=s-2`)).rejects.toThrow()
  })
})
