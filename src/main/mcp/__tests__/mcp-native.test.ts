/**
 * 远端 MCP 走**真实链路**:MCP 客户端 → `environmentTransport()` → `environmentFetch` →
 * 真实 `ssh -W` 转发 → HTTP 服务器。
 *
 * `forwarding-native.test.ts` 验的是转发通道本身(HTTP 请求、Host 头、进程回收),这里再往上
 * 一层，让 MCP 协议真的跑完握手 + 列工具 + 调用，覆盖 `environmentTransport()` 把
 * `environmentFetch` 装进 SDK 客户端的那条装配路径。顺带钉住交接单那条要求:**断线不重放**。
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, it } from 'vitest'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import type { McpServerConfig } from '../../../shared/domain/mcp'
import { EnvironmentError } from '../../environment/errors'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'
import { OpenSshTransport } from '../../environment/ssh/transport'
import { integration, isolatedSshd, readyConfig, until } from '../../environment/__tests__/sshd-fixture'
import { environmentTransport } from '../environment-transport'

const execute = promisify(execFile)
const profile: SshConnectionProfile = { id: 'native-test', name: 'native-test', kind: 'ssh', enabled: true,
  platform: 'auto', revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'native-test' } }

/**
 * 手写的最小 MCP 服务端(streamable-http 的 JSON 响应形态)。
 *
 * ★ 为什么不用 SDK 的 `StreamableHTTPServerTransport`:这个版本的服务端是 `@hono/node-server`
 * 的包装层,`notifications/initialized` 在无会话和有会话两种模式下都回 500 —— 而且**在纯本机、
 * 完全不涉及 ssh 的情况下同样复现**。那是服务端夹具的问题,不是被测对象的问题。本用例要测的
 * 是我们这一侧的装配与转发,所以服务端用一个如实遵守协议的替身就够了。
 */
function minimalMcpServer(onRequest: () => void): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    onRequest()
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as
        { id?: unknown; method?: string; params?: { protocolVersion?: string } }
      // 通知没有 id，按协议回 202 且不带 body
      if (message.id === undefined) { response.writeHead(202).end(); return }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
            serverInfo: { name: 'forwarded', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'where', description: 'probe', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'remote-mcp-ok' }] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
}

it.skipIf(!integration || process.platform === 'win32')('speaks MCP through a real ssh forward and never replays after a disconnect', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })

  // 数进来的请求。断线之后这个数字必须**一个都不涨**
  let requests = 0
  const http = minimalMcpServer(() => { requests++ })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const marker = `-W 127.0.0.1:${port}`
  const forwarders = async (): Promise<number> => {
    const { stdout } = await execute('/bin/ps', ['-Ao', 'command='])
    return stdout.split('\n').filter((line) => line.includes(marker) && !line.includes('ps -Ao')).length
  }

  let ready = true
  let client: Client | undefined
  try {
    await transport.connect(AbortSignal.timeout(20_000))
    const environment = { ...localEnvironment(nodeHost(), sshd.directory), remote: true,
      assertReady: () => { if (!ready) throw new EnvironmentError('disconnected') },
      openTcp: (host: string, target: number) => transport.openTcp(host, target) }
    const config: McpServerConfig = { id: 'remote', name: 'remote', enabled: true,
      transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`, headerNames: [] }

    // 1. 协议真的跑通:握手 + 列工具 + 调一次，全程经由真实 ssh 转发
    client = new Client({ name: 'test', version: '1' })
    await client.connect(await environmentTransport(environment, config, {}))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where'])
    const called = await client.callTool({ name: 'where', arguments: {} })
    expect(JSON.stringify(called.content)).toContain('remote-mcp-ok')
    expect(requests, 'MCP 握手与调用必须真的经由转发到达服务器').toBeGreaterThan(0)

    // 2. 断线之后：请求立即失败，且服务器一个字节都不该再收到
    ready = false
    const before = requests
    await expect(client.callTool({ name: 'where', arguments: {} })).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(requests, '断线后不得重放或重连').toBe(before)

    // 3. 关闭之后转发进程回收干净
    await client.close()
    client = undefined
    await until(async () => (await forwarders()) === 0, 20_000, 'close() 回收全部转发进程')
  } finally {
    await client?.close().catch(() => undefined)
    await transport.close()
    await sshd.close().catch(() => undefined)
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 120_000)

/**
 * 最小 SSE 服务端:GET 开一条长连流并先发 `endpoint` 事件,POST 回 202 再把响应从流上推回去。
 * 这是 MCP 的 legacy SSE 形态,与 streamable-http 的区别在于**它有一条常驻的 GET 流**。
 */
function minimalSseServer(onRequest: () => void): { server: ReturnType<typeof createServer>; streams: () => number; dropStream: () => void } {
  let open = 0
  let stream: import('node:http').ServerResponse | undefined
  const server = createServer((request, response) => {
    onRequest()
    if (request.method === 'GET') {
      open++
      stream = response
      response.on('close', () => { open--; if (stream === response) stream = undefined })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.write('event: endpoint\ndata: /messages\n\n')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as
        { id?: unknown; method?: string; params?: { protocolVersion?: string } }
      response.writeHead(202).end()
      if (message.id === undefined) return
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
            serverInfo: { name: 'forwarded-sse', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'where', description: 'probe', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'remote-sse-ok' }] }
      stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    })
  })
  return { server, streams: () => open, dropStream: () => { stream?.destroy() } }
}

/**
 * ★ SSE 分支。它是唯一带重连语义的一条 —— SDK 会在 GET 流断掉时尝试续传,所以"断线不重放"
 * 在这里最容易出问题。另外这条流是**常驻**的,它会一直占着一个 `ssh -W` 子进程,关闭时必须回收。
 */
it.skipIf(!integration || process.platform === 'win32')('speaks MCP over SSE through a real ssh forward and does not reconnect after a disconnect', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })

  let requests = 0
  const { server: http, streams, dropStream } = minimalSseServer(() => { requests++ })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const marker = `-W 127.0.0.1:${port}`
  const forwarders = async (): Promise<number> => {
    const { stdout } = await execute('/bin/ps', ['-Ao', 'command='])
    return stdout.split('\n').filter((line) => line.includes(marker) && !line.includes('ps -Ao')).length
  }

  let ready = true
  let client: Client | undefined
  try {
    await transport.connect(AbortSignal.timeout(20_000))
    const environment = { ...localEnvironment(nodeHost(), sshd.directory), remote: true,
      assertReady: () => { if (!ready) throw new EnvironmentError('disconnected') },
      openTcp: (host: string, target: number) => transport.openTcp(host, target) }
    const config: McpServerConfig = { id: 'remote-sse', name: 'remote-sse', enabled: true,
      transport: 'sse', url: `http://127.0.0.1:${port}/sse`, headerNames: [] }

    client = new Client({ name: 'test', version: '1' })
    await client.connect(await environmentTransport(environment, config, {}))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['where'])
    const called = await client.callTool({ name: 'where', arguments: {} })
    expect(JSON.stringify(called.content)).toContain('remote-sse-ok')
    expect(streams(), '常驻 GET 流必须真的建立起来，否则这条用例测的不是 SSE').toBe(1)

    // 断线：不得重连、不得重放。
    // ★ 两条都要做才不是空话：光翻 ready 时 GET 流还开着，SDK 没有理由重连；所以必须
    //   **真的把流打断**，逼 EventSource 走续传路径。
    // ★ 实测结论(做过对照实验)：把 assertReady 栅栏摘掉之后，这里的请求数**照样不涨** ——
    //   这个版本的 SSEClientTransport 在流断掉后压根不会自动重连。所以本条断言守的是
    //   「SDK 或我们的 transport 哪天开始重连了要能发现」，而**不是**「栅栏挡住了重连」。
    //   别把它当成栅栏有效的证据。
    ready = false
    const before = requests
    dropStream()
    await until(() => streams() === 0, 10_000, 'SSE 流确实被打断')
    await expect(client.callTool({ name: 'where', arguments: {} })).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 5000))
    expect(requests, '流被打断且环境已断线时，SSE 不得重连或重放').toBe(before)

    // 常驻流占着的转发进程必须随 close 回收
    await client.close()
    client = undefined
    await until(async () => (await forwarders()) === 0, 20_000, 'close() 回收 SSE 常驻流的转发进程')
  } finally {
    await client?.close().catch(() => undefined)
    await transport.close()
    await sshd.close().catch(() => undefined)
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 120_000)
