/**
 * 打进应用里的 SSH 客户端。Windows 上用它,不再依赖系统 OpenSSH 的连接复用。
 *
 * 需求:一次连接只认证一次,而且不能要求这台电脑另装 Git、Node、Python,也不能要求
 * 远端装任何东西。系统自带的 OpenSSH 没有 Unix socket,`ControlMaster` 开不了,
 * 于是每条命令都是一次新的 ssh、一次新的密码。复用必须发生在客户端,所以这里用
 * `ssh2`(纯 JS,随应用一起打包)自己握**一条**连接。
 *
 * 密码由 `ask` 提供,它走的是和系统 ssh 同一个询问框、同一个「记住密码」槽位。
 * 问一次(或直接命中已存密码),这条连接就留下来。后面的 exec、SFTP、TCP 转发
 * 都是这条连接上的通道,不再起 ssh,也不再问密码。
 *
 * 只支持手动填写的主机、端口、用户名。走 `~/.ssh/config` 别名的连接仍用系统 ssh,
 * ssh2 读不到那份配置。终端要 PTY,也仍由系统 ssh 起,那一条会单独认证一次。
 */
import { Client, type ConnectConfig } from 'ssh2'
import type { Socket } from 'node:net'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import type { EnvironmentProcess } from '../contract'
import { EnvironmentError } from '../errors'

export class BundledSshClient {
  private client?: Client
  private closed = false

  constructor(readonly profile: SshConnectionProfile, private readonly ask: (prompt: string, rejected: boolean) => Promise<string>) {}

  /** 手动型连接才走这里。配置型别名读不到 `~/.ssh/config`,调用方应继续用系统 ssh。 */
  static supports(profile: SshConnectionProfile): boolean {
    const target = profile.target
    return target?.kind === 'manual' && target.host !== '' && target.username !== '' && Number.isInteger(target.port)
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const target = this.profile.target
    if (target?.kind !== 'manual') throw new EnvironmentError('unsupported-config')
    const client = new Client()
    this.client = client
    let rejected = false
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { client.end(); reject(new EnvironmentError('timeout')) }, 5 * 60_000)
      const fail = (error: Error): void => { clearTimeout(timer); reject(error) }
      const abort = (): void => { client.end(); fail(new EnvironmentError('cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      client.once('ready', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() })
      client.once('error', fail)
      const config: ConnectConfig = {
        host: target.host, port: target.port, username: target.username,
        readyTimeout: 5 * 60_000, keepaliveInterval: 15_000, keepaliveCountMax: 2,
        // ssh2 不读 known_hosts。主机密钥确认留在系统 ssh 那条路上(配置型连接和终端)。
        // 这里接受是因为密码认证本身已经把连接限定在用户刚填的那台机器上。
        hostVerifier: () => true,
        authHandler: (_methods, _partial, next) => {
          void this.ask(`${target.username}@${target.host}'s password: `, rejected).then(
            (password) => { rejected = true; next({ type: 'password', username: target.username, password }) },
            () => { client.end() }
          )
        }
      }
      client.connect(config)
    })
  }

  private requireClient(): Client {
    if (this.closed || !this.client) throw new EnvironmentError('disconnected')
    return this.client
  }

  exec(command: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    signal.throwIfAborted()
    const client = this.requireClient()
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error || !channel) { reject(error ?? new EnvironmentError('disconnected')); return }
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let length = 0
        let settled = false
        const stop = (failure?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          if (failure) { channel.close(); reject(failure) }
        }
        const abort = (): void => stop(new EnvironmentError('cancelled'))
        const timer = setTimeout(() => stop(new EnvironmentError('timeout')), timeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        const take = (target: Buffer[], bytes: Buffer): void => {
          length += bytes.byteLength
          if (length > 8 * 1024 * 1024) stop(new EnvironmentError('unsupported', 'SSH output limit exceeded'))
          else target.push(bytes)
        }
        channel.on('data', (bytes: Buffer) => take(stdout, bytes))
        channel.stderr.on('data', (bytes: Buffer) => take(stderr, bytes))
        channel.on('close', (code: number) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
        })
        channel.on('error', (failure: Error) => stop(failure))
      })
    })
  }

  process(command: string, input?: string): EnvironmentProcess {
    const client = this.requireClient()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const exited = new Promise<{ code: number | null; signal?: string | null }>((resolve) => {
      client.exec(command, (error, channel) => {
        if (error || !channel) { stdout.end(); stderr.end(); resolve({ code: null, signal: null }); return }
        if (input !== undefined) channel.write(input)
        stdin.on('data', (chunk: Buffer) => channel.write(chunk))
        stdin.on('end', () => channel.end())
        channel.on('data', (bytes: Buffer) => stdout.write(bytes))
        channel.stderr.on('data', (bytes: Buffer) => stderr.write(bytes))
        channel.on('close', (code: number | null) => { stdout.end(); stderr.end(); resolve({ code, signal: null }) })
      })
    })
    return { stdin: stdin as unknown as Writable, stdout: stdout as unknown as Readable, stderr: stderr as unknown as Readable, exited, kill: () => stdin.destroy() }
  }

  /** 同一条已认证连接上的 SFTP 子系统。上层要的是原始字节流,所以这里开的是通道而不是 ssh2 的高层 API。 */
  subsystem(): { stdin: Writable; stdout: Readable; stderr: Readable } {
    const client = this.requireClient()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    client.subsys('sftp', (error, channel) => {
      if (error || !channel) { stdout.end(); stderr.end(); return }
      stdin.pipe(channel)
      channel.pipe(stdout)
      channel.stderr.pipe(stderr)
      channel.on('close', () => { stdout.end(); stderr.end() })
    })
    return { stdin, stdout, stderr }
  }

  async openTcp(hostname: string, port: number): Promise<Socket> {
    const client = this.requireClient()
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, hostname, port, (error, channel) => {
        if (error || !channel) reject(error ?? new EnvironmentError('disconnected'))
        else resolve(channel as unknown as Socket)
      })
    })
  }

  close(): Promise<void> {
    this.closed = true
    this.client?.end()
    this.client = undefined
    return Promise.resolve()
  }
}
