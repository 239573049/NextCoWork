/**
 * 逐页授权走**真实 PTY**。
 *
 * `terminal-host.test.ts` 已经用假 driver 覆盖了状态机的分支,但那证明不了"批准之后真的
 * 连上了一个远端 shell",也证明不了"批准之前确实没有任何东西被 spawn"。这里把 TerminalHost
 * 接到隔离 sshd 上 —— `acquire` 返回的环境的 `openTerminal` 就是 provider.ts 里那几行:
 * `transport.terminalArgs(remoteTerminalCommand(...))` 交给 node-pty。
 */
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import type { TerminalDriver, WorkspaceEnvironment } from '../contract'
import { localEnvironment } from '../local'
import { nodeHost } from '../../kernel/host'
import { remoteTerminalCommand } from '../ssh/command'
import { OpenSshTransport } from '../ssh/transport'
import { integration, isolatedSshd, readyConfig, remoteProcessAlive, until } from './sshd-fixture'

vi.mock('../../window/registry', () => ({
  terminalTopic: (id: string) => id,
  windows: { subscribe: vi.fn(), emitToTopic: vi.fn() }
}))
vi.mock('../../runtime', () => ({ getEnvironments: () => { throw new Error('Unexpected production environment') } }))

const { TerminalHost } = await import('../../terminal-host')

const profile: SshConnectionProfile = { id: 'native-test', name: 'native-test', kind: 'ssh', enabled: true,
  platform: 'auto', revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'native-test' } }

const owner = (id: number): WebContents =>
  Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents

/** 与 provider.ts:73-85 同一条装配路径,只是不经过整个连接上下文。 */
function remoteEnvironment(transport: OpenSshTransport, root: string, opened?: { count: number }): WorkspaceEnvironment {
  const base = localEnvironment(nodeHost(), root)
  return {
    ...base,
    remote: true,
    key: 'native-test:1',
    description: 'native-test',
    openTerminal: async (request: { cols: number; rows: number; cwd: string }): Promise<TerminalDriver> => {
      if (opened) opened.count++
      const invocation = transport.terminalArgs(remoteTerminalCommand('linux', base.platform.shell, request.cwd))
      const pty = await import('node-pty')
      return pty.spawn(invocation.executable, invocation.args, { name: 'xterm-256color',
        cols: request.cols, rows: request.rows, env: { ...invocation.env, TERM: 'xterm-256color' } as Record<string, string> })
    }
  } as WorkspaceEnvironment
}

it.skipIf(!integration || process.platform === 'win32')('gates a real remote shell behind per-page approval', async () => {
  const sshd = await isolatedSshd()
  const clientConfig = await readyConfig(sshd)
  const transport = new OpenSshTransport({ ...profile, target: { kind: 'config', host: 'native-test', configFile: clientConfig } })
  const marker = 'NCW-TERM-APPROVED'
  let host: InstanceType<typeof TerminalHost> | undefined
  try {
    await transport.connect(AbortSignal.timeout(20_000))
    const environment = remoteEnvironment(transport, sshd.directory)
    host = new TerminalHost(() => ({ environment, release: () => {} }))
    const sender = owner(1)
    const other = owner(2)
    const request = { id: 'tab-1', workspaceId: 'workspace', cols: 80, rows: 24 }

    // 1. 未批准前不得 spawn —— 断言的是真实进程表，不是 spy 调用次数
    await expect(host.create(request, sender)).rejects.toThrow('approval-required')
    const prepared = await host.prepare(request, sender)
    if (prepared.kind !== 'approval') throw new Error('Expected approval')
    expect(await remoteProcessAlive(`ssh -tt`), '批准之前不该有任何 ssh 终端进程').toBe(false)

    // 2. 别的窗口批不了别人的意图
    expect(() => host!.approve(prepared.intent.id, true, other)).toThrow('approval-expired')

    // 3. 批准之后才真的起一个远端 shell
    const grant = host.approve(prepared.intent.id, true, sender)
    expect(grant).toBeTruthy()
    const terminal = await host.create({ ...request, approval: grant! }, sender)
    expect(terminal.alive).toBe(true)
    // ★ 让上面那条"批准前没有"的断言非空泛:批准后必须**真的**出现一个 ssh -tt 进程。
    //   少了这一条，`ssh -tt` 只要拼错就永远匹配不到，前面那个 toBe(false) 会一直假通过。
    await until(() => remoteProcessAlive('ssh -tt'), 20_000, '批准后出现真实的 ssh -tt 终端进程')
    host.write(terminal.id, `echo ${marker}\n`, sender)
    await until(() => host!.attach(terminal.id, sender).data.includes(marker), 20_000, '远端 shell 回显')

    // 4. resize 要真的传到远端 pty
    host.resize(terminal.id, 100, 40, sender)
    host.write(terminal.id, 'stty size\n', sender)
    await until(() => /\b40 100\b/.test(host!.attach(terminal.id, sender).data), 20_000, '远端窗口大小变成 40x100')

    // 5. 活页切回免授权
    const again = await host.prepare(request, sender)
    expect(again.kind, '同一个活着的页切回来不该再要一次授权').toBe('ready')

    // 6. 关掉再开必须重新授权
    host.kill(terminal.id, sender)
    const reopened = await host.prepare(request, sender)
    expect(reopened.kind, '关闭重开必须重新授权').toBe('approval')
  } finally {
    host?.kill('tab-1')
    await transport.close()
    await sshd.close()
  }
}, 150_000)
