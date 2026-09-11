import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionOptions, TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'
import { environmentFetch } from '../environment-transport'

// 自签证书同时充当 CA。只注入 ca，host / servername / rejectUnauthorized 全部由生产代码决定,
// 这样握手和身份校验都是 Node 真跑的,被测的就是生产代码挑的那个校验名。
let authority: string[] = []
function certificateAuthority(): string[] {
  return authority
}

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>()
  // 生产代码只以 options 对象形式调用 connect，这里按这一种形态转发
  const connectWithAuthority = (options: ConnectionOptions, callback?: () => void): TLSSocket =>
    actual.connect({ ...options, ca: certificateAuthority() }, callback)
  return { ...actual, connect: connectWithAuthority }
})

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let directory = ''

function issue(name: string, subjectAltName: string): { key: string; cert: string } {
  const key = join(directory, `${name}.key`)
  const cert = join(directory, `${name}.crt`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=ncw-test', '-addext', `subjectAltName=${subjectAltName}`], { stdio: 'ignore' })
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

async function servedOn(credentials: { key: string; cert: string }): Promise<{ server: Server; port: number }> {
  const server = createServer(credentials, (_request, response) => response.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected port')
  return { server, port: address.port }
}

describe.skipIf(!hasOpenssl())('remote MCP over TLS verifies the forwarded target, not the loopback hop', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ncw-tls-'))
  })
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  // 转发 socket 连的永远是 127.0.0.1。这两条用例区分「校验转发目标」和「校验本机跳板」——
  // 缺少显式 host 时 Node 会退回 socket._host,两条的结论会正好反过来。
  it('accepts a certificate issued for the forwarded IP', async () => {
    const { server, port } = await servedOn(issue('target', 'IP:10.1.2.3'))
    authority = [readFileSync(join(directory, 'target.crt'), 'utf8')]
    const openTcp = vi.fn(async () => connect({ host: '127.0.0.1', port }))
    const environment = { ...localEnvironment(nodeHost(), '/workspace'), remote: true, openTcp }
    const network = environmentFetch(environment, new URL('https://10.1.2.3:8443/mcp'))
    try {
      const response = await network.fetch('https://10.1.2.3:8443/mcp', { signal: AbortSignal.timeout(5000) })
      expect(await response.text()).toBe('ok')
      expect(openTcp).toHaveBeenCalledWith('10.1.2.3', 8443)
    } finally {
      await network.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects a loopback certificate when the forwarded target is a different IP', async () => {
    const { server, port } = await servedOn(issue('loopback', 'IP:127.0.0.1'))
    authority = [readFileSync(join(directory, 'loopback.crt'), 'utf8')]
    const openTcp = vi.fn(async () => connect({ host: '127.0.0.1', port }))
    const environment = { ...localEnvironment(nodeHost(), '/workspace'), remote: true, openTcp }
    const network = environmentFetch(environment, new URL('https://10.1.2.3:8443/mcp'))
    try {
      // undici 把握手失败包成 'fetch failed',身份校验的原因在 cause 里
      const failure = await network.fetch('https://10.1.2.3:8443/mcp', { signal: AbortSignal.timeout(5000) })
        .then(() => null, (error: Error & { cause?: Error }) => error)
      expect(failure, 'a loopback certificate must not authenticate a different IP').not.toBeNull()
      expect(failure?.cause?.message ?? failure?.message).toMatch(/altnames|IP: 10\.1\.2\.3|Hostname/i)
    } finally {
      await network.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  // 这条盯的是真正的冒充向量:缺少显式 host 时 Node 的兜底校验名是 'localhost',
  // 于是任何一张签给 localhost 的证书都能冒充远端网络里的任意 MCP 服务器。
  it('rejects a localhost certificate when the forwarded target is a remote host', async () => {
    const { server, port } = await servedOn(issue('local-name', 'DNS:localhost'))
    authority = [readFileSync(join(directory, 'local-name.crt'), 'utf8')]
    const openTcp = vi.fn(async () => connect({ host: '127.0.0.1', port }))
    const environment = { ...localEnvironment(nodeHost(), '/workspace'), remote: true, openTcp }
    const network = environmentFetch(environment, new URL('https://10.1.2.3:8443/mcp'))
    try {
      const failure = await network.fetch('https://10.1.2.3:8443/mcp', { signal: AbortSignal.timeout(5000) })
        .then(() => null, (error: Error & { cause?: Error }) => error)
      expect(failure, 'a localhost certificate must not authenticate a remote MCP server').not.toBeNull()
      expect(failure?.cause?.message ?? failure?.message).toMatch(/altnames|IP: 10\.1\.2\.3|Hostname/i)
    } finally {
      await network.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
