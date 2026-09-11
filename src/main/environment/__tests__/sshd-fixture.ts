import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * 真实 SSH 用例的共享夹具。
 *
 * ★ 默认 skip。不设 `NCW_SSH_INTEGRATION=1` 时,全量套件里**不含任何一次真实 SSH 验证** ——
 * 「全绿」不等于连得上。开启后第一次运行就抓到过一个 mock 原理上抓不到的 bug(真实 OpenSSH
 * 在 host key 确认走 askpass 时并不设 `SSH_ASKPASS_PROMPT`)。详见 docs/ssh-support-matrix.md。
 */
export const integration = process.env.NCW_SSH_INTEGRATION === '1'
export const execute = promisify(execFile)

export interface Sshd {
  directory: string
  port: number
  hostKeyPublic: string
  clientKey: string
  username: string
  /** 写一份客户端 config 并返回它的路径。每个用例按自己要测的东西拼 */
  config(body: string): Promise<string>
  close(): Promise<void>
}

/** 起一个隔离的 sshd:随机 loopback 端口、临时 host key 与 client key、不碰任何系统配置。 */
export async function isolatedSshd(): Promise<Sshd> {
  const directory = await mkdtemp(join(tmpdir(), 'ncw-sshd-'))
  await chmod(directory, 0o700)
  const hostKey = join(directory, 'host-key')
  const clientKey = join(directory, 'client-key')
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  const port = address.port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync)
  if (!sftpServer) throw new Error('Native SFTP subsystem missing')
  await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
  await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
  await writeFile(join(directory, 'authorized_keys'), await readFile(`${clientKey}.pub`), { mode: 0o600 })
  const username = userInfo().username
  const daemonConfig = join(directory, 'sshd_config')
  await writeFile(daemonConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${join(directory, 'pid')}\n`
    + `AuthorizedKeysFile ${join(directory, 'authorized_keys')}\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n`
    + `UsePAM no\nPermitRootLogin no\nAllowUsers ${username}\nSubsystem sftp ${sftpServer}\nLogLevel VERBOSE\n`, { mode: 0o600 })
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sshd startup timed out: ${diagnostic}`)), 5000)
    daemon.once('error', (error) => { clearTimeout(timer); reject(error) })
    daemon.once('exit', (code) => { clearTimeout(timer); reject(new Error(`sshd exited ${String(code)}: ${diagnostic}`)) })
    daemon.stderr.on('data', (bytes: Buffer) => {
      diagnostic += bytes.toString('utf8')
      if (diagnostic.includes('Server listening on')) { clearTimeout(timer); resolve() }
    })
  })
  let counter = 0
  return {
    directory, port, clientKey, username,
    hostKeyPublic: (await readFile(`${hostKey}.pub`, 'utf8')).trim(),
    async config(body) {
      const path = join(directory, `ssh_config-${++counter}`)
      await writeFile(path, body, { mode: 0o600 })
      return path
    },
    async close() {
      daemon.kill()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** 一份能连通的标准客户端 config。 */
export async function readyConfig(sshd: Sshd): Promise<string> {
  const knownHosts = join(sshd.directory, 'known_hosts_ready')
  await writeFile(knownHosts, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyPublic}\n`, { mode: 0o600 })
  return sshd.config(`Host native-test\n HostName 127.0.0.1\n Port ${sshd.port}\n User ${sshd.username}\n`
    + ` IdentityFile ${sshd.clientKey}\n IdentitiesOnly yes\n IdentityAgent none\n`
    + ` UserKnownHostsFile ${knownHosts}\n StrictHostKeyChecking yes\n`)
}

export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** sshd 就在本机,所以"远端"进程本机 ps 可见 —— 孤儿判定靠的就是这一点。 */
export async function remoteProcessAlive(marker: string): Promise<boolean> {
  const { stdout } = await execute('/bin/ps', ['-Ao', 'command='])
  return stdout.split('\n').some((line) => line.includes(marker) && !line.includes('ps -Ao'))
}
