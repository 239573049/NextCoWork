import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshAuthRequest, SshAuthResponse, SshConnectionProfile } from '../../../shared/domain/environment'
import type { KernelHost } from '../../kernel/host'
import { EnvironmentError } from '../errors'
import { shellQuote } from './command'

interface AuthPending {
  senderId: number
  request: SshAuthRequest
  ref: string
  answer(response: { value?: string; cancelled?: boolean }): void
}

const AUTH_TIMEOUT_MS = 5 * 60_000
const MAX_AUTH_BYTES = 32 * 1024

export class SshAuthBroker {
  private readonly pending = new Map<string, AuthPending>()

  constructor(private readonly secrets: KernelHost['secrets'], private readonly notify: (senderId: number, request: SshAuthRequest) => void) {}

  async respond(senderId: number, response: SshAuthResponse): Promise<void> {
    const pending = this.pending.get(response.id)
    if (!pending || pending.senderId !== senderId) throw new EnvironmentError('approval-expired')
    if (response.value !== undefined && (typeof response.value !== 'string' || response.value.length > 8192 || response.value.includes('\0'))) {
      throw new EnvironmentError('invalid-profile')
    }
    this.pending.delete(response.id)
    try {
      if (response.cancelled) { pending.answer({ cancelled: true }); return }
      const value = response.useSaved && pending.request.hasSaved ? await this.secrets.get(pending.ref) : response.value
      if (value == null || (pending.request.kind === 'host-key' && value !== 'yes' && value !== 'no')) {
        pending.answer({ cancelled: true }); return
      }
      if (response.remember && pending.request.canRemember) await this.secrets.set(pending.ref, value)
      pending.answer({ value })
    } catch (error) { pending.answer({ cancelled: true }); throw error }
  }

  cancelWindow(senderId: number): void {
    for (const pending of this.pending.values()) {
      if (pending.senderId === senderId) pending.answer({ cancelled: true })
    }
  }

  async open(profile: SshConnectionProfile, senderId: number, invocation: { executable: string; appPath?: string }): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), 'ncw-auth-'))
    await chmod(directory, 0o700)
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ncw-auth-${randomUUID()}` : join(directory, 'socket')
    const token = randomBytes(32).toString('hex')
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy())
      let buffer = ''
      let received = false
      let requestId: string | undefined
      socket.on('error', () => {})
      socket.once('close', () => { sockets.delete(socket); if (requestId) this.pending.delete(requestId) })
      socket.on('data', (bytes: Buffer) => {
        if (received) return
        buffer += bytes.toString('utf8')
        if (Buffer.byteLength(buffer) > MAX_AUTH_BYTES) { socket.destroy(); return }
        if (!buffer.includes('\n')) return
        received = true
        let payload: { token?: unknown; prompt?: unknown; hint?: unknown }
        try { payload = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as typeof payload } catch { socket.destroy(); return }
        if (typeof payload.token !== 'string' || payload.token.length !== token.length
          || !timingSafeEqual(Buffer.from(payload.token), Buffer.from(token))
          || typeof payload.prompt !== 'string' || payload.prompt.length > 8192) { socket.destroy(); return }
        const prompt = payload.prompt
        /**
         * ★ 不能只认 `SSH_ASKPASS_PROMPT=confirm`。
         *
         * 实测 OpenSSH 10.3:host key 确认走 askpass 时**并不设**这个变量,于是提示掉进
         * `challenge` 分支。后果不是报错而是两层降级:UI 把指纹确认显示成普通输入框;
         * `respond()` 里那条 yes/no 强校验失效,于是用户输入的任意串被回给 ssh,ssh 再问、
         * 再回 —— 隔离 sshd 上实测重问 80+ 次直到超时。所以按**提示内容**识别。
         * OpenSSH 不本地化这些字符串,匹配英文原文是安全的。
         */
        const confirmsHostKey = payload.hint === 'confirm'
          || /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i.test(prompt)
          || /^please type ['"]?yes['"]?, ['"]?no['"]?/i.test(prompt)
          || /^the authenticity of host /i.test(prompt)
        const kind: SshAuthRequest['kind'] = confirmsHostKey ? 'host-key'
          : /^Enter passphrase for key /i.test(prompt) ? 'passphrase' : /\bpassword:\s*$/i.test(prompt) ? 'password' : 'challenge'
        const canRemember = (kind === 'password' || kind === 'passphrase') && this.secrets.available()
        const ref = `connection:${profile.id}:prompt:${createHash('sha256').update(prompt).digest('hex')}`
        requestId = randomUUID()
        const id = requestId
        void (async () => {
          const request: SshAuthRequest = { id, connectionId: profile.id, connectionName: profile.name, prompt, kind,
            canRemember, hasSaved: canRemember && (await this.secrets.get(ref)) !== null }
          if (socket.destroyed) return
          this.pending.set(id, { senderId, request, ref, answer: (answer) => {
            this.pending.delete(id)
            socket.end(`${JSON.stringify(answer)}\n`)
          } })
          this.notify(senderId, request)
        })().catch(() => socket.destroy())
      })
    })
    server.maxConnections = 8
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => resolve()) })
      if (process.platform !== 'win32') await chmod(endpoint, 0o600)
      let executable = invocation.executable
      if (process.platform === 'win32') {
        if (invocation.appPath) throw new EnvironmentError('unsupported-client', 'Use the packaged application for native Windows askpass.')
      } else {
        // ★ OpenSSH 以 execlp(askpass, askpass, msg) 调用,msg 在 keyboard-interactive 下**由远端 sshd
        //   完全控制**;而打包形态的 executable 就是 Electron 本体,Chromium 会抢在我们的 JS 之前把它
        //   当开关解析(`--remote-debugging-port=` 之类)。始终包一层 sh 并用 `--` 终止开关解析。
        executable = join(directory, 'askpass')
        const target = invocation.appPath
          ? `${shellQuote(invocation.executable)} ${shellQuote(invocation.appPath)}`
          : shellQuote(invocation.executable)
        await writeFile(executable, `#!/bin/sh\nexec ${target} -- "$@"\n`, { mode: 0o700 })
      }
      /**
       * ★ token 走 0600 文件而**不进环境变量**。
       *
       * ssh 把整个环境交给 ProxyCommand / Match exec / KnownHostsCommand / LocalCommand
       * 跑的 `/bin/sh -c`,而用户 ssh_config 里一条 `SendEnv *` 会把它直接送到远端服务器。
       * 实测 `-o 'SendEnv=-*'` **清不掉**配置里的 `SendEnv *`(SendEnv 是累加列表,`-` 只
       * 从当前已累积的列表里移除,而命令行先于配置文件解析),OpenSSH 也没有 `SendEnv none`。
       * 所以只能换通道:env 里留的是路径,远端就算拿到这两个路径也读不到本机文件;
       * helper 与我们同机同用户,读文件零成本。
       */
      const secret = join(directory, 'token')
      await writeFile(secret, token, { mode: 0o600 })
      return {
        env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0',
          NCW_SSH_ASKPASS: '1', NCW_SSH_AUTH_ENDPOINT: endpoint, NCW_SSH_AUTH_SECRET: secret },
        close: async () => {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await rm(directory, { recursive: true, force: true })
        }
      }
    } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error }
  }
}

export function requestAskpass(env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
  const endpoint = env.NCW_SSH_AUTH_ENDPOINT
  const secret = env.NCW_SSH_AUTH_SECRET
  if (!endpoint || !secret || prompt.length > 8192) return Promise.reject(new EnvironmentError('authentication'))
  let token: string
  try { token = readFileSync(secret, 'utf8') } catch { return Promise.reject(new EnvironmentError('authentication')) }
  if (!token) return Promise.reject(new EnvironmentError('authentication'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    let completed = false
    socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy(new EnvironmentError('timeout')))
    socket.once('connect', () => socket.write(`${JSON.stringify({ token, prompt, hint: env.SSH_ASKPASS_PROMPT })}\n`))
    socket.once('error', reject)
    socket.once('close', () => { if (!completed) reject(new EnvironmentError('authentication')) })
    socket.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_AUTH_BYTES) { socket.destroy(); return }
      if (!buffer.includes('\n')) return
      try {
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { value?: unknown; cancelled?: boolean }
        if (reply.cancelled || typeof reply.value !== 'string') throw new EnvironmentError('cancelled')
        completed = true
        resolve(reply.value)
      } catch (error) { reject(error) } finally { socket.destroy() }
    })
  })
}