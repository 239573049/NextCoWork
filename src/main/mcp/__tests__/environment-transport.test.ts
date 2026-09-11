import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { describe, expect, it, vi } from 'vitest'
import { nodeHost } from '../../kernel/host'
import { localEnvironment } from '../../environment/local'
import { EnvironmentStdioTransport, environmentFetch } from '../environment-transport'

describe('workspace MCP transport', () => {
  it('uses a non-PTY environment process with separate stderr and explicit secret values', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const server = new McpServer({ name: 'workspace-test', version: '1' })
    server.registerTool('where', {}, () => ({ content: [{ type: 'text', text: 'server' }] }))
    await server.connect(new StdioServerTransport(stdin, stdout))
    const kill = vi.fn()
    const environment = { ...localEnvironment(nodeHost(), '/workspace'), remote: true,
      openProcess: vi.fn(async () => ({ stdin, stdout, stderr, kill, exited: new Promise<{ code: number }>(() => {}) })) }
    environment.path.resolve = async () => ({ abs: '/workspace', outside: false })
    const transport = new EnvironmentStdioTransport(environment, { id: 'server', name: 'server', transport: 'stdio',
      command: 'remote-tool', args: ['--stdio'], envNames: ['TOKEN'], enabled: true }, { TOKEN: 'test-value' })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    stderr.write('not protocol and never exposed as tool content')
    expect((await client.listTools()).tools[0]?.name).toBe('where')
    expect(environment.openProcess).toHaveBeenCalledWith('remote-tool', ['--stdio'], { cwd: '/workspace', env: { TOKEN: 'test-value' } })
    await client.close()
    expect(kill).toHaveBeenCalledTimes(1)
    await server.close()
  })
  it('routes HTTP through the environment socket without changing Host or allowing cross-origin requests', async () => {
    const server = createServer((request, response) => { response.end(request.headers.host) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected port')
    const openTcp = vi.fn(async () => connect({ host: '127.0.0.1', port: address.port }))
    const environment = { ...localEnvironment(nodeHost(), '/workspace'), remote: true, openTcp }
    const network = environmentFetch(environment, new URL('http://remote.internal:8123/mcp'))
    try {
      const response = await network.fetch('http://remote.internal:8123/mcp', { signal: AbortSignal.timeout(2000) })
      expect(await response.text()).toBe('remote.internal:8123')
      expect(openTcp).toHaveBeenCalledWith('remote.internal', 8123)
      await expect(network.fetch('http://other.internal/mcp')).rejects.toThrow('permission')
    } finally { await network.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})