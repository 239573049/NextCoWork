/**
 * SSH 走代理这条路上「只在真网络里才暴露」的那几件事。
 *
 * 需求:SSH 连接默认跟随系统代理(实现见 `ssh/proxy.ts`)。这块的失败模式和
 * 代理设置那边一样隐蔽 —— **握手错了不会报错,只会让 SSH 在更晚的地方莫名其妙地断**。
 * 所以这里起真的 TCP 服务端当代理和目标主机,逐条钉握手报文与转发的字节。
 *
 * 用例里的分片发送(`writeInChunks`)不是凑数:三种握手都要按长度收包,而
 * `data` 事件不保证消息边界。一次性写出去的版本在本机永远碰巧是对的。
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import { connectThroughProxy, openSshProxyTunnel } from '../ssh/proxy'
import { knownHostsName, POSIX_PROBE, proxyTunnelArgs } from '../ssh/command'
import { OpenSshTransport } from '../ssh/transport'
import { integration, isolatedSshd, readyConfig } from './sshd-fixture'

const PROFILE: SshConnectionProfile = { id: 'proxy-test', name: 'proxy-test', kind: 'ssh', enabled: true,
  platform: 'auto', revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'native-test' } }

const servers: Server[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function listen(handler: (socket: Socket) => void): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/** 按字节分片写出,逼出「按消息边界收包」的假设 */
function writeInChunks(socket: Socket, payload: Buffer): void {
  for (const byte of payload) socket.write(Buffer.from([byte]))
}

/**
 * 服务端侧的顺序读取。
 *
 * ★ 不能用「一次 `once('data')` 读一段,再摘掉监听读下一段」的写法:移除 'data'
 * 监听**不会**让流退回暂停模式,期间到达的字节被直接丢掉 —— 表现就是用例挂到超时。
 */
function recorder(socket: Socket): { read(bytes: number): Promise<Buffer> } {
  let buffer = Buffer.alloc(0)
  let wake: (() => void) | null = null
  socket.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); wake?.() })
  return {
    async read(bytes: number): Promise<Buffer> {
      while (buffer.length < bytes) await new Promise<void>((resolve) => { wake = resolve })
      const head = buffer.subarray(0, bytes)
      buffer = buffer.subarray(bytes)
      return head
    }
  }
}

function collect(socket: Socket, bytes: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= bytes) resolve(buffer)
    })
    // 握手交还的 socket 是暂停的(见 ByteReader.release);挂 'data' 监听不会自动恢复
    socket.resume()
  })
}

describe('ssh proxy tunnel', () => {
  it('opens an HTTP CONNECT tunnel and forwards bytes in both directions', async () => {
    let request = ''
    const port = await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        request = chunk.toString()
        // 应答和首包合并成一个 TCP 段 —— 丢掉 banner 的那个 bug 就藏在这里
        socket.write('HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-Server\r\n')
        socket.on('data', (echo: Buffer) => socket.write(echo))
      })
    })
    const tunnel = await openSshProxyTunnel({ scheme: 'http', host: '127.0.0.1', port }, 'remote.internal', 2222)
    closers.push(tunnel.close)

    const client = createConnection({ host: '127.0.0.1', port: tunnel.port })
    const banner = await collect(client, 'SSH-2.0-Server\r\n'.length)
    expect(banner.toString()).toBe('SSH-2.0-Server\r\n')
    client.write('ping')
    expect((await collect(client, 4)).subarray(-4).toString()).toBe('ping')
    client.destroy()

    expect(request).toContain('CONNECT remote.internal:2222 HTTP/1.1')
    expect(request).toContain('Host: remote.internal:2222')
    expect(request).not.toContain('Proxy-Authorization')
  })

  it('sends Basic credentials only when the proxy target carries them', async () => {
    let request = ''
    const port = await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        request = chunk.toString()
        socket.write('HTTP/1.1 200 OK\r\n\r\n')
      })
    })
    const socket = await connectThroughProxy({ scheme: 'http', host: '127.0.0.1', port, username: 'me', password: 'pw' }, 'host', 22)
    socket.destroy()
    expect(request).toContain(`Proxy-Authorization: Basic ${Buffer.from('me:pw').toString('base64')}`)
  })

  /** 407 要能一眼看出是「代理要认证」,否则用户只会看到 ssh 那句连接被关闭 */
  it('reports the proxy status code when the tunnel is refused', async () => {
    const port = await listen((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'))
    })
    await expect(connectThroughProxy({ scheme: 'http', host: '127.0.0.1', port }, 'host', 22))
      .rejects.toThrow('HTTP 407')
  })

  /**
   * ★ SOCKS5 的回复里绑定地址是变长的。少读一段的话,多出来的字节会被当成
   * SSH banner 的开头,表现为随机的 "Bad protocol version identification"。
   */
  it('consumes the variable-length SOCKS5 reply and leaves the stream clean', async () => {
    let greeting: Buffer = Buffer.alloc(0)
    let request: Buffer = Buffer.alloc(0)
    const port = await listen((socket) => {
      const read = recorder(socket)
      void (async () => {
        greeting = await read.read(3)
        socket.write(Buffer.from([0x05, 0x00]))
        request = await read.read(22)
        // ATYP=0x03(域名)的回复:1 字节长度 + 名字 + 2 字节端口,后面紧跟着 banner
        const bound = Buffer.from('proxy.local')
        writeInChunks(socket, Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, bound.length]), bound,
          Buffer.from([0x08, 0x00]), Buffer.from('SSH-2.0-X')]))
      })()
    })
    const socket = await connectThroughProxy({ scheme: 'socks5', host: '127.0.0.1', port }, 'remote.internal', 2222)
    expect((await collect(socket, 9)).toString()).toBe('SSH-2.0-X')
    socket.destroy()

    expect([...greeting]).toEqual([0x05, 0x01, 0x00])
    // 主机名原样交给代理解析(ATYP=0x03),不在本机先解析
    expect(request[3]).toBe(0x03)
    expect(request.subarray(5, 5 + 15).toString()).toBe('remote.internal')
    expect(request.readUInt16BE(request.length - 2)).toBe(2222)
  })

  it('negotiates SOCKS5 username/password when the proxy asks for it', async () => {
    let credentials: Buffer = Buffer.alloc(0)
    const port = await listen((socket) => {
      const read = recorder(socket)
      void (async () => {
        await read.read(4)
        socket.write(Buffer.from([0x05, 0x02]))
        credentials = await read.read(6)
        socket.write(Buffer.from([0x01, 0x00]))
        await read.read(8)
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      })()
    })
    const socket = await connectThroughProxy({ scheme: 'socks5', host: '127.0.0.1', port, username: 'u', password: 'pw' }, 'h', 22)
    socket.destroy()
    expect([...credentials]).toEqual([0x01, 1, 0x75, 2, 0x70, 0x77])
  })

  /** 代理把连接掐了:失败原因必须留下,否则用户只会看到 ssh 那句「连接被远端关闭」 */
  it('fails with a reason when the proxy hangs up mid-handshake', async () => {
    const port = await listen((socket) => socket.destroy())
    await expect(connectThroughProxy({ scheme: 'http', host: '127.0.0.1', port }, 'host', 22))
      .rejects.toThrow(/closed|ECONNRESET/)
  })
})

describe('proxy tunnel ssh arguments', () => {
  /**
   * known_hosts 的名字必须和 OpenSSH 自己拼的一致:按 **HostName**(不是命令行上的别名)
   * 拼,非默认端口带 `[host]:port` 修饰。错一个字就是 `StrictHostKeyChecking yes` 下的连接被拒。
   */
  it('keeps the known_hosts name of the resolved target, port decoration included', () => {
    expect(knownHostsName('example.com', 22)).toBe('example.com')
    expect(knownHostsName('example.com', 2222)).toBe('[example.com]:2222')
    expect(proxyTunnelArgs('example.com', 2222, 54321, false))
      .toEqual(['-o', 'HostName=127.0.0.1', '-o', 'Port=54321', '-o', 'HostKeyAlias=[example.com]:2222'])
  })

  /** 用户自己写了 HostKeyAlias 就是他的选择 —— 覆盖掉会把他的 known_hosts 条目判成陌生主机 */
  it('never overrides a HostKeyAlias the user configured', () => {
    expect(proxyTunnelArgs('my-alias', 22, 54321, true)).toEqual(['-o', 'HostName=127.0.0.1', '-o', 'Port=54321'])
  })

  /**
   * ★ 真实 OpenSSH 才验得了的两件事,mock 一件也碰不到:
   * 1. `-o Port=` 排在 `-p` 前面才赢(命令行上先到先得);
   * 2. `HostKeyAlias` 还原出来的名字能对上 known_hosts 里那条 —— 对不上就会
   *    `StrictHostKeyChecking yes` 直接拒绝,而不是悄悄多问一句。
   * 所以这条用例跟着 `NCW_SSH_INTEGRATION=1` 走真实 sshd + 真实 CONNECT 代理。
   */
  it.skipIf(!integration || process.platform === 'win32')('reaches a real sshd through a real CONNECT proxy', async () => {
    const sshd = await isolatedSshd()
    const seen: string[] = []
    let transport: OpenSshTransport | undefined
    try {
      const configFile = await readyConfig(sshd)
      const proxyPort = await listen((client) => {
        let head = Buffer.alloc(0)
        const onData = (chunk: Buffer): void => {
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) return
          client.pause()
          client.off('data', onData)
          const target = /^CONNECT (\S+)/.exec(head.toString())?.[1] ?? ''
          seen.push(target)
          const upstream = createConnection({ host: '127.0.0.1', port: Number(target.split(':')[1]) }, () => {
            client.write('HTTP/1.1 200 Connection established\r\n\r\n')
            client.pipe(upstream)
            upstream.pipe(client)
          })
          upstream.on('error', () => client.destroy())
        }
        client.on('data', onData)
        client.on('error', () => client.destroy())
      })
      transport = new OpenSshTransport({ ...PROFILE, target: { kind: 'config', host: 'native-test', configFile } }, {
        openProxyTunnel: async (hostname, port) =>
          openSshProxyTunnel({ scheme: 'http', host: '127.0.0.1', port: proxyPort }, hostname, port)
      })
      await transport.connect(AbortSignal.timeout(20_000))
      const result = await transport.exec(POSIX_PROBE, AbortSignal.timeout(5000))
      expect(result.code).toBe(0)
      expect(result.stdout.split('\0')[3]).toBe(sshd.username)
      // 代理真的被用上了,而且拿到的是**真实目标**,不是隧道自己的回环地址
      expect(seen).toEqual([`127.0.0.1:${String(sshd.port)}`])
    } finally { await transport?.close(); await sshd.close() }
  }, 40_000)
})
