/**
 * 让 **ssh 子进程**也走应用/系统的代理。
 *
 * ## 需求与它为什么不能用别的办法做
 *
 * 需求是「SSH 连接默认跟随系统代理」。OpenSSH 自己**没有任何代理概念** ——
 * 它不读系统代理设置,也不认 `HTTPS_PROXY`(白名单里那几个变量是给用户自己写的
 * `ProxyCommand` 用的,见 `transport.ts` 的 `INHERITED_NAMES`)。想让它过代理,
 * 传统答案是配一条 `ProxyCommand nc -X connect -x host:port %h %p`,但 `nc`
 * **在 Windows 上根本不存在**,在 Linux 上还分 GNU / OpenBSD 两种互不兼容的实现。
 * 「默认」二字不允许我们依赖一个可能不在的外部程序。
 *
 * 所以这里自己当那条 ProxyCommand:在 `127.0.0.1` 上开一个只服务这条连接的
 * TCP 监听,ssh 连它,它替 ssh 向代理发起 CONNECT / SOCKS 握手,握完手就纯转发字节。
 * 对 ssh 来说这仍然是一条普通 TCP 连接,SSH 协议本身(密钥交换、主机密钥、多路复用)
 * 一个字节都不受影响。
 *
 * ## 不变式
 *
 * - **只在握手成功后才开始转发。** 握手失败就断开,ssh 侧表现为连接被关闭;
 *   失败原因通过 `onFailure` 交给日志,否则用户只会看到一句没有来由的
 *   "kex_exchange_identification: Connection closed by remote host"。
 * - **只监听 127.0.0.1**,且随连接一起销毁(`transport.close()`)。
 * - 端口由内核分配(`listen(0)`)。写死端口会在开两个连接时撞车。
 *
 * ## 故意不做
 *
 * - 不做代理故障转移(理由在 `shared/domain/proxy.ts` 的 `parseResolvedProxy`)。
 * - 不缓存、不复用隧道:一条 SSH 连接一条隧道,生命周期完全跟着 transport 走,
 *   省掉一套引用计数。ControlMaster 在开着的时候本来也只拨一次。
 */
import { createConnection, createServer, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { ProxyDialTarget } from '../../../shared/domain/proxy'
import { EnvironmentError } from '../errors'

/** 握手要在这个时间内做完 —— 代理接受了连接却不回应答是常见故障,不设上限会挂死在连接阶段。 */
const HANDSHAKE_TIMEOUT_MS = 15_000

export interface SshProxyTunnel {
  /** 127.0.0.1 上的监听端口,交给 ssh 的 `-o Port=` */
  port: number
  close(): Promise<void>
}

/**
 * 按需读取的定长/定界读取器。
 *
 * 单独抽出来是因为三种握手都要「先读 N 字节,再根据其中一个字段决定还读多少」,
 * 而 socket 的 `data` 事件**不保证按消息边界到达** —— 直接在 `data` 里判长度的写法
 * 在本机代理上几乎总是碰巧正确,换成有延迟的网络就随机失败。
 */
class ByteReader {
  private buffer = Buffer.alloc(0)
  private failure: Error | null = null
  private pending: { resolve(): void; reject(error: Error): void } | null = null

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pending?.resolve() })
    socket.once('error', (error) => this.fail(error))
    socket.once('close', () => this.fail(new Error('proxy closed the connection during the handshake')))
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.pending?.reject(error)
  }

  /** 等到缓冲区至少有 size 字节,取走它们。 */
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve, reject) => { this.pending = { resolve, reject } })
      this.pending = null
    }
    const head = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return head
  }

  /** 读到 marker 为止(含)。用于 HTTP 应答头那种不定长的部分。 */
  async readUntil(marker: string, limit: number): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf(marker)
      if (index >= 0) {
        const head = this.buffer.subarray(0, index + marker.length).toString('latin1')
        this.buffer = this.buffer.subarray(index + marker.length)
        return head
      }
      if (this.buffer.length > limit) throw new Error('proxy response header is too large')
      if (this.failure) throw this.failure
      await new Promise<void>((resolve, reject) => { this.pending = { resolve, reject } })
      this.pending = null
    }
  }

  /**
   * 交还控制权:摘掉监听,把**握手之后多读进来的字节**塞回流里。
   *
   * ★ 这一步看着多余(CONNECT 之后代理通常不会抢先发东西),但漏掉它的后果是
   * 丢掉服务端 banner 的头几个字节,表现为偶发的
   * "Bad protocol version identification" —— 只在代理把应答和首包合并成一个 TCP 段时出现。
   *
   * ★★ **交还时 socket 是暂停的**,接手的人必须 `pipe()`(它自带 resume)或者自己
   * `resume()`。这里必须先 pause 再摘监听:移除 'data' 监听**不会**让流退回暂停模式,
   * 顺序反了的话,在接手之前到达的字节会被 emit 给一个没有监听者的流,直接丢掉。
   * 而 Node 里「显式 pause 过的流,再挂 'data' 监听不会自动恢复」—— 这是上面那句
   * 「必须 pipe 或 resume」的由来,不是可以随手删掉的啰嗦。
   */
  release(): void {
    this.socket.pause()
    this.socket.removeAllListeners('data')
    if (this.buffer.length > 0) this.socket.unshift(this.buffer)
    this.buffer = Buffer.alloc(0)
  }
}

function dial(target: ProxyDialTarget): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    // https 代理 = 到代理这一跳本身是 TLS,之后的 CONNECT 报文和 http 代理完全一样。
    // 类型显式写成 Socket:回调里引用了 socket 自己,不标注的话 TS 判成循环推断。
    const socket: Socket = target.scheme === 'https'
      ? connectTls({ host: target.host, port: target.port, servername: target.host }, () => resolve(socket))
      : createConnection({ host: target.host, port: target.port }, () => resolve(socket))
    socket.once('error', reject)
  })
}

async function httpConnect(socket: Socket, target: ProxyDialTarget, host: string, port: number): Promise<void> {
  const reader = new ByteReader(socket)
  const authority = `${host.includes(':') ? `[${host}]` : host}:${String(port)}`
  const credentials = target.username === undefined || target.username === ''
    ? ''
    : `Proxy-Authorization: Basic ${Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')}\r\n`
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}Proxy-Connection: Keep-Alive\r\n\r\n`)
  const head = await reader.readUntil('\r\n\r\n', 64 * 1024)
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? '0')
  // 407 单独报:它几乎总是「代理要认证而设置页没填账号密码」,和「代理拒绝目标主机」是两件事
  if (status === 407) throw new Error('proxy requires authentication (HTTP 407)')
  if (status !== 200) throw new Error(`proxy refused the CONNECT tunnel (HTTP ${String(status)})`)
  reader.release()
}

async function socks5Connect(socket: Socket, target: ProxyDialTarget, host: string, port: number): Promise<void> {
  const reader = new ByteReader(socket)
  const useCredentials = target.username !== undefined && target.username !== ''
  socket.write(Buffer.from(useCredentials ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
  const greeting = await reader.read(2)
  if (greeting[0] !== 0x05) throw new Error('proxy is not a SOCKS5 server')
  if (greeting[1] === 0x02) {
    if (!useCredentials) throw new Error('proxy requires authentication but no proxy credentials are configured')
    const user = Buffer.from(target.username ?? '')
    const password = Buffer.from(target.password ?? '')
    if (user.length > 255 || password.length > 255) throw new Error('proxy credentials are too long for SOCKS5')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]))
    const reply = await reader.read(2)
    if (reply[1] !== 0x00) throw new Error('proxy rejected the proxy credentials')
  } else if (greeting[1] !== 0x00) {
    throw new Error('proxy asked for an unsupported SOCKS5 authentication method')
  }

  /*
    按**域名**(ATYP 0x03)发出去,不在本地先解析。远端主机名该由谁解析是个语义问题:
    代理那侧解析才是用户的本意(内网域名在本机常常解不出来),本地解析会把
    「连不上」变成「查不到这个域名」,而两者的修复办法完全不同。
  */
  const name = Buffer.from(host)
  if (name.length > 255) throw new Error('hostname is too long for SOCKS5')
  const request = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.alloc(2)])
  request.writeUInt16BE(port, request.length - 2)
  socket.write(request)

  const reply = await reader.read(4)
  if (reply[1] !== 0x00) throw new Error(`proxy refused the SOCKS5 connection (code ${String(reply[1])})`)
  // 绑定地址长度随 ATYP 变,必须读掉,否则它会被当成 SSH banner 的一部分
  const address = reply[3]
  const length = address === 0x01 ? 4 : address === 0x04 ? 16 : address === 0x03 ? (await reader.read(1))[0] ?? 0 : -1
  if (length < 0) throw new Error('proxy returned an unknown SOCKS5 address type')
  await reader.read(length + 2)
  reader.release()
}

async function socks4Connect(socket: Socket, target: ProxyDialTarget, host: string, port: number): Promise<void> {
  const reader = new ByteReader(socket)
  const user = Buffer.from(target.username ?? '')
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  // SOCKS4 只收 IPv4 字面量;非字面量走 SOCKS4a 的约定:IP 写 0.0.0.x,主机名跟在用户名后面
  const address = literal ? Buffer.from(host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1])
  const head = Buffer.concat([Buffer.from([0x04, 0x01, 0, 0]), address, user, Buffer.from([0x00])])
  head.writeUInt16BE(port, 2)
  socket.write(literal ? head : Buffer.concat([head, Buffer.from(host), Buffer.from([0x00])]))
  const reply = await reader.read(8)
  if (reply[1] !== 0x5a) throw new Error(`proxy refused the SOCKS4 connection (code ${String(reply[1])})`)
  reader.release()
}

/**
 * 拨到代理并把隧道打到 `host:port`。返回的 socket 已经是「干净的字节管道」,
 * 但**处于暂停状态**(理由见 `ByteReader.release`):接手的人要么 `pipe()`,要么 `resume()`。
 *
 * 超时同时盖住**拨号**和**握手**:代理接受 TCP 连接却不回应答时,只有拨号超时
 * 是不够的 —— 那种情况下 socket 已经连上了,永远不会自己失败。
 */
export async function connectThroughProxy(target: ProxyDialTarget, host: string, port: number): Promise<Socket> {
  let socket: Socket | undefined
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out while talking to the proxy')), HANDSHAKE_TIMEOUT_MS).unref())
  try {
    return await Promise.race([timeout, (async () => {
      socket = await dial(target)
      socket.setNoDelay(true)
      if (target.scheme === 'socks5') await socks5Connect(socket, target, host, port)
      else if (target.scheme === 'socks4') await socks4Connect(socket, target, host, port)
      else await httpConnect(socket, target, host, port)
      // 握手期间挂的那个 error 监听会在 race 之后变成「无人处理的 error 事件」,交给调用方重挂
      socket.removeAllListeners('error')
      return socket
    })()])
  } catch (error) {
    socket?.destroy()
    throw error
  }
}

/**
 * 起一条只服务这次 SSH 连接的本地隧道。
 *
 * `onFailure` 收每一次握手失败。ssh 侧只会看到连接被关闭,不把原因喂给日志的话,
 * 「代理密码错了」和「代理连不上」在用户眼里是同一句无法解释的 SSH 错误。
 */
export async function openSshProxyTunnel(target: ProxyDialTarget, host: string, port: number,
  onFailure?: (error: Error) => void): Promise<SshProxyTunnel> {
  const open = new Set<Socket>()
  const server = createServer((client) => {
    open.add(client)
    client.on('error', () => client.destroy())
    client.once('close', () => open.delete(client))
    void connectThroughProxy(target, host, port).then((upstream) => {
      if (client.destroyed) { upstream.destroy(); return }
      open.add(upstream)
      upstream.on('error', () => upstream.destroy())
      upstream.once('close', () => { open.delete(upstream); client.destroy() })
      client.once('close', () => upstream.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    }).catch((error: unknown) => {
      onFailure?.(error instanceof Error ? error : new Error(String(error)))
      client.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new EnvironmentError('connection-failed', 'could not open a local proxy tunnel for SSH')
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of open) socket.destroy()
      open.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
