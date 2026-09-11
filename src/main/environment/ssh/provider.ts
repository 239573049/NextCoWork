import type { EnvironmentFacts, SshConnectionProfile } from '../../../shared/domain/environment'
import { abortable } from '../../kernel/abort'
import type { EnvironmentConnection, TerminalDriver } from '../contract'
import type { ConnectionContext } from '../manager'
import { EnvironmentError } from '../errors'
import { createWorkspacePaths } from '../paths'
import { POSIX_PROBE, remoteCommand, remoteProcessRequest, remoteTerminalCommand, shellQuote, WINDOWS_PROBE } from './command'
import { OpenSshTransport, type OpenSshOptions } from './transport'
import { SftpFileSystem } from './sftp'

export async function connectSshEnvironment(profile: SshConnectionProfile,
  context: ConnectionContext & { generation: number; assertCurrent(): void; onDisconnect(): void },
  authentication: { env: NodeJS.ProcessEnv; close(): Promise<void> }, options: Pick<OpenSshOptions, 'executable'> = {}): Promise<EnvironmentConnection> {
  let closed = false
  let filesystem: SftpFileSystem | undefined
  const terminals = new Set<TerminalDriver>()
  const transport = new OpenSshTransport(profile, { ...options, env: authentication.env,
    onDisconnect: () => { closed = true; context.onDisconnect() } })
  const assertReady = (): void => {
    context.assertCurrent()
    if (closed) throw new EnvironmentError('disconnected')
  }
  const close = async (): Promise<void> => {
    closed = true
    for (const terminal of terminals) terminal.kill()
    terminals.clear()
    filesystem?.close()
    await transport.close()
    await authentication.close()
  }
  try {
    await transport.connect(context.signal)
    let facts: EnvironmentFacts | undefined
    if (profile.platform !== 'win32') {
      const result = await transport.exec(`/bin/sh -c ${shellQuote(POSIX_PROBE)}`, context.signal, 15_000)
      if (result.code === 0) {
        const [system, osVersion, hostname, username, home, shell] = result.stdout.split('\0')
        const os = system === 'Darwin' ? 'darwin' : system === 'Linux' ? 'linux' : undefined
        if (os && osVersion && hostname && username && home && shell) facts = { os, osVersion, hostname, username, home, shell }
      }
    }
    if (!facts && (profile.platform === 'auto' || profile.platform === 'win32')) {
      const result = await transport.exec(WINDOWS_PROBE, context.signal, 15_000)
      if (result.code === 0) {
        try {
          const candidate = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as EnvironmentFacts
          if (candidate.os === 'win32' && ['osVersion', 'hostname', 'username', 'home', 'shell'].every((key) =>
            typeof candidate[key as keyof EnvironmentFacts] === 'string' && candidate[key as keyof EnvironmentFacts] !== '')) facts = candidate
        } catch { throw new EnvironmentError('unsupported-platform') }
      }
    }
    if (!facts || (profile.platform !== 'auto' && facts.os !== profile.platform)) throw new EnvironmentError('unsupported-platform')
    const platform = facts
    const channel = transport.subsystem()
    channel.stderr.resume()
    filesystem = new SftpFileSystem(channel.stdin, channel.stdout, platform.os, assertReady, context.onDisconnect)
    await abortable(() => filesystem!.ready, context.signal)
    platform.home = await filesystem.realpath(platform.home)
    const path = createWorkspacePaths(filesystem, platform.os)
    const environment: EnvironmentConnection = {
      key: JSON.stringify(['ssh', profile.id, profile.revision, context.generation]), generation: context.generation,
      remote: true, description: `${profile.name} (${platform.username}@${platform.hostname})`, facts: platform, platform, fs: filesystem, path, assertReady, close,
      openTcp: async (hostname, port) => { assertReady(); return transport.openTcp(hostname, port) },
      spawn: async (command, request) => {
        assertReady()
        return transport.exec(remoteCommand(platform.os, platform.shell, request.cwd, command), request.signal, request.timeoutMs)
      },
      openProcess: async (command, args, request) => {
        assertReady()
        const prepared = remoteProcessRequest(platform.os, platform.shell, request.cwd, command, args, request.env)
        return transport.process(prepared.command, prepared.input)
      },
      openTerminal: async (request) => {
        assertReady()
        const canonical = await filesystem!.realpath(request.cwd)
        if (!(await filesystem!.stat(canonical)).isDir) throw new EnvironmentError('invalid-path')
        const invocation = transport.terminalArgs(remoteTerminalCommand(platform.os, platform.shell, canonical))
        const pty = await import('node-pty')
        assertReady()
        const terminal = pty.spawn(invocation.executable, invocation.args, { name: 'xterm-256color', cols: request.cols, rows: request.rows,
          env: { ...invocation.env, TERM: 'xterm-256color' } as Record<string, string> })
        terminals.add(terminal)
        terminal.onExit(() => terminals.delete(terminal))
        return terminal
      }
    }
    return environment
  } catch (error) { await close(); throw error }
}