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
  opts: { state: string; signal?: AbortSignal; timeoutMs?: number },
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
