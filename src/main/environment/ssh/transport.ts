import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import type { EnvironmentProcess } from '../contract'
import { EnvironmentError } from '../errors'
import { sshTargetArgs } from './command'

export interface OpenSshOptions {
  env?: NodeJS.ProcessEnv
  executable?: string
  onDisconnect?: () => void
  /**
   * `ssh -G` 解析出的最终配置。认证 broker 用它判断某条密码提示来自链路上的哪一跳
   * (见 `askpass.ts` 的 `shouldAutoAnswer`)。在任何会认证的 ssh 启动**之前**调用。
   */
  onResolved?: (values: Map<string, string>) => void
}

/**
 * 交给 ssh 子进程的客户端环境。
 *
 * 白名单而不是黑名单:ssh 会把整个环境交给 ProxyCommand / Match exec / KnownHostsCommand
 * 跑的 `/bin/sh -c`,用户 ssh_config 里一条 `SendEnv *` 还能把它送到远端服务器。所以默认
 * 只放行**基础设施**变量,应用自己的密钥(API_KEY 之类)一律不进去。
 *
 * ★ 取舍点:这里放行的是**选择器和路径**(AWS_PROFILE、AWS_CONFIG_FILE、KRB5CCNAME…),
 * 不放行原始凭据(AWS_SECRET_ACCESS_KEY、AWS_SESSION_TOKEN)。前者是 ProxyCommand 找到
 * 凭据所必需的,后者即使缺席,aws/gcloud 也会自己去读凭据文件。放行原始凭据会让它们
 * 同时暴露给 ProxyCommand 和(配了 SendEnv 通配时的)远端服务器,不值得。
 */
const INHERITED_NAMES = [
  // POSIX 基础
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
  // Windows 基础。★ Windows 上 ssh.exe 推断默认登录名靠的是 USERNAME —— USER 在那边根本不存在,
  //   缺了它且 config 没写 User 时会直接登错账号。
  'SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  // 认证代理与硬件密钥。SSH_SK_* 是 FIDO(sk-ecdsa / sk-ssh-ed25519)的自定义 middleware,
  // SSH_PKCS11_HELPER 是智能卡。
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_SK_PROVIDER', 'SSH_SK_HELPER', 'SSH_PKCS11_HELPER',
  // GSSAPI / Kerberos。非默认 ccache(KEYRING: / DIR: / FILE:)全靠 KRB5CCNAME 定位。
  'KRB5CCNAME', 'KRB5_CONFIG', 'KRB5_KTNAME', 'KRB5_CLIENT_KTNAME', 'KRB5RCACHEDIR',
  // 桌面会话:gnome-keyring / systemd 用户代理的 socket 路径,以及 ForwardX11 要 fork 的 xauth
  'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'XAUTHLOCALHOSTNAME', 'WAYLAND_DISPLAY',
  // 终端与区域
  'TERM', 'COLORTERM', 'LANG', 'LANGUAGE',
  // 企业代理:ProxyCommand 走 nc -X connect / corkscrew 时必需
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  // 云厂商 ProxyCommand 的选择器与路径(不含原始凭据,见上)
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_SDK_LOAD_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS'
]

/** 按前缀放行:LC_ 有 14 个,CLOUDSDK_ / TELEPORT_ 数量不定,逐个列会漏。 */
const INHERITED_PREFIXES = ['lc_', 'cloudsdk_', 'teleport_', 'tsh_']

/** 永不透传,即使调用方在 overrides 里塞进来:它们会改变子进程里 Node/Electron 的行为。 */
const DENIED_NAMES = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

export function sshProcessEnvironment(overrides: NodeJS.ProcessEnv = {}, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  /**
   * ★ 按小写比对但**保留系统原始拼写**。Windows 上 `process.env` 查找本就大小写不敏感,
   * 逐个列出 ProgramFiles/PROGRAMFILES 这类拼写变体只会在子进程环境块里造出重复键,
   * 而且永远列不全(SystemRoot/SYSTEMROOT/systemroot…)。
   */
  const allowed = new Set(INHERITED_NAMES.map((name) => name.toLowerCase()))
  const denied = new Set(DENIED_NAMES.map((name) => name.toLowerCase()))
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (denied.has(lower)) continue
    if (allowed.has(lower) || INHERITED_PREFIXES.some((prefix) => lower.startsWith(prefix))) env[name] = value
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || denied.has(name.toLowerCase())) continue
    env[name] = value
  }
  return env
}

export function sshExecutable(): string {
  const candidates = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'OpenSSH', 'ssh.exe')]
    : ['/usr/bin/ssh', '/bin/ssh', '/usr/local/bin/ssh']
  const executable = candidates.find(existsSync)
  if (!executable) throw new EnvironmentError('ssh-unavailable')
  return executable
}

export class OpenSshTransport {
  private directory = ''
  private control = ''
  private closed = false
  private closing?: Promise<void>
  private readonly children = new Set<ChildProcessWithoutNullStreams>()

  constructor(readonly profile: SshConnectionProfile, private readonly options: OpenSshOptions = {}) {}

  private baseArgs(): string[] {
    return ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ConnectTimeout=15',
      ...(this.control ? ['-S', this.control] : []), ...sshTargetArgs(this.profile)]
  }

  private launch(args: string[], closing = false): ChildProcessWithoutNullStreams {
    if (this.closed && !closing) throw new EnvironmentError('disconnected')
    const env = sshProcessEnvironment(this.options.env)
    const child = spawn(this.options.executable ?? sshExecutable(), args, { shell: false, windowsHide: true, env, stdio: 'pipe' })
    this.children.add(child)
    child.once('close', () => this.children.delete(child))
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    return child
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const config = await this.capture(['-G', ...sshTargetArgs(this.profile)], signal, 15_000)
    if (config.code !== 0) throw new EnvironmentError('unsupported-config', config.stderr.slice(-2000))
    const values = new Map(config.stdout.split('\n').map((line) => { const split = line.indexOf(' '); return [line.slice(0, split), line.slice(split + 1)] }))
    // 交给认证 broker —— 必须在下面那个会认证的 ssh 之前,否则密码提示来时它还不知道要连哪儿
    this.options.onResolved?.(values)
    if (values.get('remotecommand') && values.get('remotecommand') !== 'none') {
      throw new EnvironmentError('unsupported-config', 'RemoteCommand conflicts with workspace command and SFTP sessions. Use a dedicated Host alias.')
    }
    if (process.platform !== 'win32') {
      this.directory = await mkdtemp(join(tmpdir(), 'ncw-ssh-'))
      await chmod(this.directory, 0o700)
      this.control = join(this.directory, 'control')
    }
    const result = await this.capture(['-T', ...(this.control ? ['-M', '-o', 'ControlPersist=60'] : []),
      ...this.baseArgs(), 'echo NextCoWork-SSH-Ready'], signal, 5 * 60_000)
    if (result.code !== 0 || !result.stdout.includes('NextCoWork-SSH-Ready')) {
      await this.close()
      throw new EnvironmentError('connection-failed', result.stderr.slice(-2000))
    }
  }

  async capture(args: string[], signal: AbortSignal, timeoutMs: number, closing = false): Promise<{ code: number; stdout: string; stderr: string }> {
    signal.throwIfAborted()
    const child = this.launch(args, closing)
    child.stdin.end()
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let length = 0
      let failure: Error | undefined
      const stop = (error: Error): void => { failure ??= error; child.kill(); reject(error) }
      const abort = (): void => stop(new EnvironmentError('cancelled'))
      const timer = setTimeout(() => stop(new EnvironmentError('timeout')), timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      const collect = (target: Buffer[], bytes: Buffer): void => {
        length += bytes.byteLength
        if (length > 8 * 1024 * 1024) stop(new EnvironmentError('unsupported', 'SSH output limit exceeded'))
        else target.push(bytes)
      }
      child.stdout.on('data', (bytes: Buffer) => collect(stdout, bytes))
      child.stderr.on('data', (bytes: Buffer) => collect(stderr, bytes))
      child.once('error', (error) => { failure = error; reject(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (failure) return
        resolve({ code: code ?? 255, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      })
    })
  }

  async exec(command: string, signal: AbortSignal, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
    signal.throwIfAborted()
    let result: Awaited<ReturnType<OpenSshTransport['capture']>>
    try { result = await this.capture(['-T', ...this.baseArgs(), command], signal, timeoutMs) } catch (error) {
      if (error instanceof EnvironmentError && (error.code === 'cancelled' || error.code === 'timeout')) throw new EnvironmentError('result-unknown')
      throw error
    }
    if (result.code === 255) throw new EnvironmentError('result-unknown', result.stderr.slice(-2000))
    return result
  }

  process(command: string, input?: string): EnvironmentProcess {
    const child = this.launch(['-T', ...this.baseArgs(), command])
    if (input !== undefined) child.stdin.write(input)
    const exited = new Promise<{ code: number | null; signal?: string | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve({ code: null }))
    })
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, kill: () => { child.kill() } }
  }

  subsystem(): ChildProcessWithoutNullStreams {
    const child = this.launch(['-T', '-s', ...this.baseArgs(), 'sftp'])
    child.once('close', () => { if (!this.closed) this.options.onDisconnect?.() })
    return child
  }

  async openTcp(hostname: string, port: number): Promise<Socket> {
    if (!/^[a-zA-Z0-9_.:%-]+$/.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) throw new EnvironmentError('invalid-profile')
    const target = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${String(port)}`
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new EnvironmentError('connection-failed') }
    const client = createConnection({ host: '127.0.0.1', port: address.port })
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); client.destroy(); reject(new EnvironmentError('timeout')) }, 5000)
      client.once('error', (error) => { clearTimeout(timer); server.close(); reject(error) })
      server.on('connection', (socket) => {
        if (socket.remotePort !== client.localPort) { socket.destroy(); return }
        clearTimeout(timer)
        server.close()
        let child: ChildProcessWithoutNullStreams
        try { child = this.launch(['-T', '-W', target, ...this.baseArgs()]) } catch (error) {
          socket.destroy(); client.destroy(); reject(error); return
        }
        child.stderr.resume()
        child.stdout.pipe(socket)
        socket.pipe(child.stdin)
        socket.on('error', () => { child.kill() })
        socket.once('close', () => { child.kill() })
        child.once('error', () => { socket.destroy() })
        child.once('close', () => { socket.destroy() })
        resolve(client)
      })
    })
  }

  terminalArgs(command: string): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (this.closed) throw new EnvironmentError('disconnected')
    return { executable: this.options.executable ?? sshExecutable(), args: ['-tt', ...this.baseArgs(), command], env: sshProcessEnvironment(this.options.env) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const child of this.children) child.kill()
    this.closing = (async () => {
      if (this.control) await this.capture(['-O', 'exit', ...this.baseArgs()], AbortSignal.timeout(2000), 2000, true).catch(() => {})
      if (this.directory) await rm(this.directory, { recursive: true, force: true })
    })()
    return this.closing
  }
}