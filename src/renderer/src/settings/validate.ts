/**
 * 代理地址的规整规则。抽成纯函数是为了让它**能被评审** ——
 * 「失焦提交」那套交互的全部判断都落在这一个函数里。
 */

/** 参考实现的代理表单是「协议 + 地址 + 端口」三段拆开的,我们只有一个 url 字段 */
const SCHEMES = ['http', 'https', 'socks5', 'socks4'] as const

/**
 * 返回规整后的地址;`''` 表示「清空」(合法);`null` 表示不合法、不该写回去。
 *
 * ★ **缺协议时补 `http://` 而不是拒绝。** 用户十有八九只会打 `127.0.0.1:7890` ——
 * 那正是各家代理软件在界面上显示的样子。直接判它不合法,用户会以为是自己打错了。
 */
export function normalizeProxyUrl(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return ''

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  if (!(SCHEMES as readonly string[]).includes(scheme)) return null
  if (url.hostname === '') return null

  // 端口给了就必须是合法端口 —— `127.0.0.1:99999` 会被 URL 解析成路径,不是端口
  if (url.port !== '' && (Number(url.port) < 1 || Number(url.port) > 65535)) return null

  // 去掉尾巴上那条空路径:`http://127.0.0.1:7890/` 和不带斜杠的是同一个地址,
  // 但存成两种写法之后「有没有变」的比较就会失效(每次失焦都写一次)
  return url.pathname === '/' && url.search === '' && url.hash === ''
    ? `${url.protocol}//${url.host}`
    : url.toString()
}
