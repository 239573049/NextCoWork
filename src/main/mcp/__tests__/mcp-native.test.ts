/**
 * 远端 MCP 走**完整的真实链路**:真实 MCP 服务器 ← 真实 `ssh -W` 转发 ← 真实 MCP 客户端。
 *
 * `forwarding-native.test.ts` 验的是转发通道本身(HTTP 请求、Host 头、进程回收),这里再往上
 * 一层,让 MCP 协议真的跑完一轮握手和一次工具调用 —— 覆盖的是 `environmentTransport()` 把
 * `environmentFetch` 装进 SDK 客户端的那条装配路径。
 *
 * 顺带钉住交接单里那条要求:**断线不重放**。SDK 唯一的重连是 SSE GET 流的续传,而 `fetch`
 * 与 Agent 的 connect 回调两处都有 `assertReady()` 栅栏;断线之后不得有任何一次请求溜出去。
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

it.skipIf(!integration || process.platform === 'win32')('speaks MCP to a real server through a real ssh forward and never replays after a disconnect', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })

  const mcp = new McpServer({ name: 'forwarded', version: '1' })
  mcp.registerTool('where', {}, () => ({ content: [{ type: 'text' as const, text: 'remote-mcp-ok' }] }))
  const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcp.connect(serverTransport)
  // 数进来的请求。断线之后这个数字必须**一个都不涨**
  let requests = 0
  const http = createServer((request, response) => {
    requests++
    void serverTransport.handleRequest(request, response)
  })
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

    // 1. 协议真的跑通:握手 + 列工具 + 调一次
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
    await mcp.close().catch(() => undefined)
    await transport.close()
    await sshd.close().catch(() => undefined)
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 120_000)
