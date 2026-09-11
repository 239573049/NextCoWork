/**
 * 远端 MCP 的 HTTP 通道走**真实 SSH TCP 转发**。
 *
 * `environment-transport.test.ts` 用一条本机 socket 冒充 `openTcp`,证明不了 `ssh -W` 这条
 * 链路本身。这里用隔离 sshd 真的转发一次,并且**数进程**:`openTcp` 每条转发都会 spawn 一个
 * `ssh -W <target>` 子进程,所以泄漏是可数的。
 *
 * ★ 计数器只匹配转发到**本次测试那个端口**的进程。早先用宽松的 `" -W "` 过滤时,它把测量
 * 脚本自己的命令行也数了进去,基线不是 0 —— 那种噪声会让"关闭后回到基线"这种结论毫无意义。
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import { EnvironmentError } from '../../environment/errors'
import { localEnvironment } from '../../environment/local'
import { nodeHost } from '../../kernel/host'
import { OpenSshTransport } from '../../environment/ssh/transport'
import { integration, isolatedSshd, readyConfig, until } from '../../environment/__tests__/sshd-fixture'
import { environmentFetch } from '../environment-transport'

const execute = promisify(execFile)
const profile: SshConnectionProfile = { id: 'native-test', name: 'native-test', kind: 'ssh', enabled: true,
  platform: 'auto', revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'native-test' } }

it.skipIf(!integration || process.platform === 'win32')('forwards MCP HTTP over a real ssh -W channel and leaves nothing behind', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })
  const server = createServer((request, response) => response.end(request.headers.host))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const marker = `-W 127.0.0.1:${port}`
  const forwarders = async (): Promise<number> => {
    const { stdout } = await execute('/bin/ps', ['-Ao', 'command='])
    return stdout.split('\n').filter((line) => line.includes(marker) && !line.includes('ps -Ao')).length
  }
  try {
    await transport.connect(AbortSignal.timeout(20_000))
    expect(await forwarders(), '计数器必须从 0 起,否则后面的断言都是噪声').toBe(0)

    let ready = true
    const environment = { ...localEnvironment(nodeHost(), sshd.directory), remote: true,
      assertReady: () => { if (!ready) throw new EnvironmentError('disconnected') },
      openTcp: (host: string, target: number) => transport.openTcp(host, target) }
    const network = environmentFetch(environment, new URL(`http://127.0.0.1:${port}/mcp`))

    // 1. 真的穿过 ssh -W，且 Host 头仍是 URL 里的那个（转发不改写它）
    const response = await network.fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(15_000) })
    expect(await response.text()).toBe(`127.0.0.1:${port}`)
    expect(await forwarders(), '请求期间应当有一条真实转发').toBe(1)

    // 2. 断线后立即失败，且**不重试** —— 不得再起一条转发
    ready = false
    await expect(network.fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow()
    expect(await forwarders(), '断线后不得为重试新起转发').toBeLessThanOrEqual(1)

    // 3. close() 之后转发进程必须回收干净
    await network.close()
    await until(async () => (await forwarders()) === 0, 15_000, 'close() 回收全部转发进程')
  } finally {
    await transport.close()
    await sshd.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 120_000)

/**
 * ★ 迟到 socket:`close()` 发生在 `openTcp` 还没 resolve 的时候。
 *
 * 审计怀疑这条会泄漏(socket 与常驻 ssh 子进程都没人回收)。实测**不复现** —— 慢速
 * `openTcp` 确实被调用到底、真的起了转发,而 `close()` 之后残留为 0。这条用例把该结论钉住:
 * 它一旦变红,说明回收行为退化了。
 */
it.skipIf(!integration || process.platform === 'win32')('cleans up a forward that resolves after close', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const marker = `-W 127.0.0.1:${port}`
  const forwarders = async (): Promise<number> => {
    const { stdout } = await execute('/bin/ps', ['-Ao', 'command='])
    return stdout.split('\n').filter((line) => line.includes(marker) && !line.includes('ps -Ao')).length
  }
  try {
    await transport.connect(AbortSignal.timeout(20_000))
    let opened = 0
    const environment = { ...localEnvironment(nodeHost(), sshd.directory), remote: true,
      openTcp: async (host: string, target: number) => {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        opened++
        return transport.openTcp(host, target)
      } }
    const network = environmentFetch(environment, new URL(`http://127.0.0.1:${port}/mcp`))
    void network.fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await network.close()
    // ★ 先等迟到路径**真的**发生，再谈回收。顺序反过来的话 until 会立刻满足
    //   (那时转发还没起)，opened 永远是 0，这条用例就什么都没测 —— 第一版正是这样。
    await until(() => opened === 1, 15_000, '慢速 openTcp 在 close() 之后仍然 resolve')
    await until(async () => (await forwarders()) === 0, 20_000, '迟到的转发被回收')
  } finally {
    await transport.close()
    await sshd.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 120_000)
