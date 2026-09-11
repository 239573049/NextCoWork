import { connect as connectTls } from 'node:tls'
import { isIP } from 'node:net'
import { once } from 'node:events'
import { Agent, fetch as httpFetch, type RequestInit as HttpRequestInit } from 'undici'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '../../shared/domain/mcp'
import type { EnvironmentProcess, WorkspaceEnvironment } from '../environment/contract'
import { EnvironmentError } from '../environment/errors'

/** 关 stdin 之后留给远端 MCP 服务器自行退出的时间。超过就杀本机这一侧。 */
const GRACEFUL_EXIT_MS = 500

export class EnvironmentStdioTransport implements Transport {
  onclose?: Transport['onclose']
  onerror?: Transport['onerror']
  onmessage?: Transport['onmessage']
  private child?: EnvironmentProcess
  private started = false
  private closed = false
  private readonly buffer = new ReadBuffer({ maxBufferSize: 8 * 1024 * 1024 })

  constructor(private readonly environment: WorkspaceEnvironment,
    private readonly config: Extract<McpServerConfig, { transport: 'stdio' }>, private readonly values: Record<string, string>) {}

  async start(): Promise<void> {
    if (this.started || this.closed) throw new EnvironmentError('disconnected')
    this.started = true
    this.environment.assertReady()
    const cwd = (await this.environment.path.resolve(this.environment.rootPath, this.config.cwd || this.environment.rootPath)).abs
    const child = await this.environment.openProcess(this.config.command, this.config.args, { cwd, env: this.values })
    if (this.closed) { child.kill(); return }
    this.child = child
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk)
        for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message)
      } catch {
        this.onerror?.(new Error('Invalid MCP protocol output'))
        void this.close()
      }
    })
    child.stdout.on('error', () => { this.onerror?.(new EnvironmentError('disconnected')); void this.close() })
    child.stdin.on('error', () => { this.onerror?.(new EnvironmentError('disconnected')); void this.close() })
    void child.exited.then(() => this.close())
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.environment.assertReady()
    if (!this.child || this.closed) throw new EnvironmentError('disconnected')
    const stream = this.child.stdin
    await new Promise<void>((resolve, reject) => stream.write(serializeMessage(message), (error) => error ? reject(error) : resolve()))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (child) {
      /**
       * ★ 先关 stdin 给远端一个干净的退出机会,再杀本机这一侧。
       *
       * 实测(隔离 sshd):非 PTY 路径(`ssh -T`)下,只 kill 本机 ssh **不会**让远端进程退出 ——
       * 本机 ssh 消失了,远端那个进程 30 秒后仍在,是真孤儿。终端路径(`-tt`)则会,因为远端有
       * pty,连接断开时 sshd 向会话发 SIGHUP。所以每次断开都会在服务器上留下一个不退出的
       * 远端 MCP 进程,重连再留一个。
       *
       * stdin EOF 是 MCP stdio 服务器的约定收尾信号,守规矩的服务器据此自行退出。这挡不住
       * 完全不读 stdin 的进程(那需要远端侧的看门狗,见 docs/ssh-support-matrix.md),
       * 但把最常见的一类从"必然泄漏"变成"正常退出"。
       */
      try { child.stdin.end() } catch { /* 通道可能已经断了 */ }
      // 已经退出的话不必空等 —— 关闭路径也走在应用退出的关键路径上
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, GRACEFUL_EXIT_MS))])
      child.kill()
    }
    this.buffer.clear()
    this.onclose?.()
  }
}

export function environmentFetch(environment: WorkspaceEnvironment, origin: URL): { fetch: FetchLike; close(): Promise<void> } {
  const dispatcher = new Agent({ connect: (options, callback) => {
    const hostname = options.hostname.replace(/^\[|\]$/g, '')
    const port = Number(options.port || (options.protocol === 'https:' ? 443 : 80))
    let finished = false
    const done: typeof callback = (...args) => { if (!finished) { finished = true; callback(...args) } }
    try { environment.assertReady() } catch (error) { done(error instanceof Error ? error : new Error('Disconnected'), null); return }
    if (!environment.openTcp) { done(new EnvironmentError('unsupported'), null); return }
    void environment.openTcp(hostname, port).then(async (socket) => {
      if (socket.connecting) await once(socket, 'connect')
      if (options.protocol !== 'https:') { done(null, socket); return }
      // host 必须显式传入：转发 socket 按 IP 字面量连本机,Node 缺省会退到 'localhost' 做证书身份校验
      const secure = connectTls({ socket, host: hostname, servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
      const timer = setTimeout(() => secure.destroy(new EnvironmentError('timeout')), 15_000)
      secure.once('secureConnect', () => { clearTimeout(timer); done(null, secure) })
      secure.once('error', (error) => { clearTimeout(timer); socket.destroy(); done(error, null) })
    }).catch((error: unknown) => done(error instanceof Error ? error : new Error('SSH forwarding failed'), null))
  } })
  const fetch: FetchLike = async (input, init) => {
    environment.assertReady()
    const url = new URL(input)
    if (url.origin !== origin.origin) throw new EnvironmentError('permission', 'MCP endpoint changed origin')
    const response = await httpFetch(url, { ...init, redirect: 'error', dispatcher } as HttpRequestInit)
    return response as unknown as Response
  }
  return { fetch, close: () => dispatcher.destroy() }
}

class OwnedTransport implements Transport {
  onclose?: Transport['onclose']
  onerror?: Transport['onerror']
  onmessage?: Transport['onmessage']
  private closed = false
  constructor(private readonly inner: Transport, private readonly network: ReturnType<typeof environmentFetch>,
    private readonly environment: WorkspaceEnvironment) {}
  get sessionId(): string | undefined { return this.inner.sessionId }
  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version) }
  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra)
    this.inner.onclose = () => { void this.close() }
    this.inner.onerror = (error) => { this.onerror?.(error); void this.close() }
    await this.inner.start()
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.environment.assertReady()
    if (this.closed) throw new EnvironmentError('disconnected')
    await this.inner.send(message)
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await this.inner.close() } finally { await this.network.close(); this.onclose?.() }
  }
}

export async function environmentTransport(environment: WorkspaceEnvironment, config: McpServerConfig, values: Record<string, string>): Promise<Transport> {
  environment.assertReady()
  if (config.transport === 'stdio') return new EnvironmentStdioTransport(environment, config, values)
  const url = new URL(config.url)
  const network = environmentFetch(environment, url)
  const options = { fetch: network.fetch, requestInit: { headers: values } }
  const inner = config.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
  return new OwnedTransport(inner, network, environment)
}