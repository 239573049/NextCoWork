/**
 * OAuth 回调的本地回环服务器 —— **一次授权只活几十秒的一台 HTTP 服务器。**
 *
 * ★ 放 `src/main/net/` 而不是 `kernel/`:它是**应用级服务**,不是内核的端口。
 * `net/proxy.ts` 和 `net/attachment-protocol.ts` 已经是这个位置的两个先例。
 * 本文件零 Electron import,可以在纯 Node 里直测。
 */
import { createServer, type Server } from 'node:http'
import { stateMatches } from '../kernel/oauth/pkce'

/**
 * 端口被占用。**单独一个错误类型**,因为它需要一句和别的失败完全不同的话:
 * 见下面 `listenOn` 里那段「绝不换端口重试」。
 */
export class PortBusyError extends Error {
  constructor(readonly port: number) {
    super(`本机 ${port} 端口被占用`)
    this.name = 'PortBusyError'
  }
}

export interface LoopbackResult {
  status: 'ok' | 'denied' | 'timeout' | 'cancelled'
  code?: string
  /** 授权服务器回的 error / error_description,或者我们自己判的原因 */
  reason?: string
}

export interface LoopbackOptions {
  expectedState: string
  signal: AbortSignal
  path: string
  /** 0 = 让系统给一个临时端口(`loopback-ephemeral` 与测试用) */
  port: number
  timeoutMs?: number
  /** bind 成功后回调,把真实端口告诉调用方 —— 临时端口形态要用它拼 redirect_uri */
  onListening?: (port: number) => void
  /**
   * 回调里装授权码的查询参数名。**省略 = `code`(标准)。**
   *
   * ★ 和 `OAuthProviderSpec.callbackCodeParam` 是同一件事,只是那边管粘贴路径、
   * 这边管回环路径。智谱回的是 `authCode`,写死 `code` 的表现是**回调打进来了、
   * 页面也显示成功了,然后判 state 不匹配走 denied** —— 错误信息一个字都不提参数名。
   */
  codeParam?: string
}

/** 五分钟。用户要开浏览器、可能还要先登一次 ChatGPT、可能还要过一次两步验证 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

function page(title: string, detail: string, accent: string): string {
  /*
    ★ **自包含的 HTML,零外部资源。** 不 302 跳到别处,也不引任何 CSS/字体:
    用户唯一能看到这次授权结果的地方就是这个浏览器标签页,而一个空白页或者
    `ERR_EMPTY_RESPONSE` 看上去就是「这应用坏了」。外链资源在断网/被墙时
    会把这一页变成一堆没样式的字,同样是「看着像坏了」。
  */
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#1c1b19;color:#e8e6e3;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:22rem;padding:2rem;text-align:center">
<div style="font-size:2.5rem;line-height:1;margin-bottom:1rem;color:${accent}">${title.slice(0, 2)}</div>
<h1 style="margin:0 0 .5rem;font-size:1.05rem;font-weight:600">${title}</h1>
<p style="margin:0;opacity:.7;font-size:.9rem">${detail}</p>
</div></body></html>`
}

const OK_PAGE = page('已授权', '可以关掉这个标签页，回到 NextCoWork 了。', '#5aa469')
const FAIL_PAGE = page('授权未完成', '请回到 NextCoWork 重试。', '#c9705a')

function listenOn(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('error', onError)
      /*
        ★★ **绝不换一个端口重试。**
        redirect_uri 必须**逐字节**等于该 client 注册的那个值。换端口之后 bind 会
        成功、浏览器会打开、然后用户在授权页上撞见一个 `redirect_uri mismatch` ——
        他会以为是我们的应用坏了,而唯一有用的那条信息(端口冲突)已经被我们
        自己吞掉了。抛一个专门的错,让上层说人话。
      */
      reject(err.code === 'EADDRINUSE' ? new PortBusyError(port) : err)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port)
    })
  })
}

/**
 * 起一台只服务一次回调的服务器,等授权码回来。
 *
 * ★★ **超时和取消都 `resolve` 成一个正常结局,不抛。**
 * 「用户把授权页关掉了」是这条流程**最常见的第二种结局**,不是异常。做成异常的话,
 * 上层就得靠字符串匹配去区分「用户放弃了」和「端口起不来」——而那两件事要说的话
 * 完全不同。真正的异常只留给真正的故障(端口占用、bind 失败)。
 */
export async function awaitOAuthCallback(opts: LoopbackOptions): Promise<LoopbackResult> {
  const { expectedState, signal, path, port } = opts
  const codeParam = opts.codeParam ?? 'code'
  let settle: ((r: LoopbackResult) => void) | null = null
  const done = new Promise<LoopbackResult>((resolve) => {
    settle = resolve
  })
  const finish = (r: LoopbackResult): void => {
    const s = settle
    settle = null
    s?.(r)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    /*
      ★ 只认这一条路径,别的一律 404 空体。多一条路由就多一个面,
      而这台服务器在本机上是**任何进程**都连得到的。
    */
    if (req.method !== 'GET' || url.pathname !== path) {
      res.writeHead(404).end()
      return
    }

    const params = url.searchParams
    const error = params.get('error')
    const code = params.get(codeParam)
    const state = params.get('state')

    /*
      ★★ **state 不对就当没收到 code。**
      这一步防的是 CSRF:攻击者诱导用户的浏览器带着**攻击者自己的** code 打到
      这个本地端点,我们就会把攻击者的账号绑到用户的应用上。state 是我们发起
      时生成的随机串,只有真正由我们发起的那一次授权才带得回来。
      比对用 timingSafeEqual(见 `pkce.ts`)。
    */
    const ok = error === null && code !== null && stateMatches(expectedState, state)

    /*
      ★ 先 `res.end()` 再 `server.close()`。顺序反了浏览器拿不到页面,
      用户看到的是一个连接被重置的错误页 —— 而授权其实已经成功了。
    */
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ok ? OK_PAGE : FAIL_PAGE)

    if (ok && code !== null) {
      finish({ status: 'ok', code })
    } else {
      finish({
        status: 'denied',
        reason:
          error ??
          (params.get('error_description') ??
            (code === null ? '回调里没有授权码' : 'state 不匹配'))
      })
    }
  })

  const timer = setTimeout(() => {
    finish({ status: 'timeout' })
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onAbort = (): void => {
    finish({ status: 'cancelled' })
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    /*
      ★★ **只监听回环地址,绝不 0.0.0.0。**
      这是一个接受授权码的端点 —— 暴露到局域网,等于同网段任何人都能往里灌
      一个自己的 code(state 挡得住绝大部分,但没有理由把面开出去)。

      ★ 先 127.0.0.1;`localhost` 在部分系统上解析到 `::1`,而 Codex 注册的
      redirect_uri 里写的就是 `localhost`(不能改成 127.0.0.1 —— 改了授权服务器
      直接拒)。所以再补一台监听 `::1` 的,两边共用同一个 handler。
      IPv6 起不来不算失败:大量环境里根本没有 ::1,而 IPv4 那台已经能收了。
    */
    const bound = await listenOn(server, port, '127.0.0.1')
    let v6: Server | null = createServer()
    v6.on('request', (req, res) => server.emit('request', req, res))
    try {
      await listenOn(v6, bound, '::1')
    } catch {
      v6.close()
      v6 = null
    }
    opts.onListening?.(bound)
    try {
      return await done
    } finally {
      v6?.close()
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.close()
  }
}
