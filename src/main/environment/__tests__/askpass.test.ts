import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SshAuthRequest, SshConnectionProfile } from '../../../shared/domain/environment'
import { nodeHost } from '../../kernel/host'
import { requestAskpass, SshAuthBroker } from '../ssh/askpass'

const profile: SshConnectionProfile = { id: 'auth-test', kind: 'ssh', name: 'test', enabled: true, platform: 'auto',
  revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'test' } }

it('routes a challenge to its owner and rejects cross-window replies', async () => {
  let notify!: (request: SshAuthRequest) => void
  const received = new Promise<SshAuthRequest>((resolve) => { notify = resolve })
  const broker = new SshAuthBroker(nodeHost().secrets, (sender, request) => { expect(sender).toBe(42); notify(request) })
  const session = await broker.open(profile, 42, { executable: process.execPath })
  try {
    const answer = requestAskpass(session.env, 'Verification code:')
    const request = await received
    expect(request.canRemember).toBe(false)
    await expect(broker.respond(43, { id: request.id, value: 'wrong' })).rejects.toThrow('approval-expired')
    await broker.respond(42, { id: request.id, value: 'test-answer', remember: true })
    expect(await answer).toBe('test-answer')
    await expect(broker.respond(42, { id: request.id, value: 'replay' })).rejects.toThrow('approval-expired')
  } finally { await session.close() }
})

it('does not trust an unauthenticated helper connection', async () => {
  const broker = new SshAuthBroker(nodeHost().secrets, () => { throw new Error('Untrusted request reached UI') })
  const session = await broker.open(profile, 1, { executable: process.execPath })
  const directory = mkdtempSync(join(tmpdir(), 'ncw-wrong-'))
  const wrong = join(directory, 'token')
  writeFileSync(wrong, '0'.repeat(64), { mode: 0o600 })
  try { await expect(requestAskpass({ ...session.env, NCW_SSH_AUTH_SECRET: wrong }, 'Password:')).rejects.toThrow() }
  finally { rmSync(directory, { recursive: true, force: true }); await session.close() }
})

/**
 * ★ token 绝不能出现在 ssh 子进程的环境里。
 *
 * ssh 把整个环境交给 ProxyCommand / Match exec 跑的 `/bin/sh -c`,而用户 ssh_config 里
 * 一条 `SendEnv *` 会把它直接送到远端服务器。实测 `-o 'SendEnv=-*'` 清不掉配置里的
 * `SendEnv *`,OpenSSH 也没有 `SendEnv none` —— 所以只能不让它进环境。
 */
it('keeps the one-time auth token out of the SSH process environment', async () => {
  const broker = new SshAuthBroker(nodeHost().secrets, () => {})
  const session = await broker.open(profile, 1, { executable: process.execPath })
  try {
    const secret = session.env.NCW_SSH_AUTH_SECRET ?? ''
    const token = readFileSync(secret, 'utf8')
    expect(token.length).toBeGreaterThan(32)
    for (const [name, value] of Object.entries(session.env)) {
      expect(value, `${name} must not carry the token`).not.toContain(token)
    }
  } finally { await session.close() }
})

it('treats host key approval as yes/no and clears pending prompts on window close', async () => {
  let notify!: (request: SshAuthRequest) => void
  const received = new Promise<SshAuthRequest>((resolve) => { notify = resolve })
  const broker = new SshAuthBroker(nodeHost().secrets, (_sender, request) => notify(request))
  const session = await broker.open(profile, 1, { executable: process.execPath })
  try {
    const answer = requestAskpass({ ...session.env, SSH_ASKPASS_PROMPT: 'confirm' }, 'Trust this host?')
    const rejected = expect(answer).rejects.toThrow('cancelled')
    expect((await received).kind).toBe('host-key')
    broker.cancelWindow(1)
    await rejected
  } finally { await session.close() }
})

// ★ 远端 sshd 完全控制 askpass 的 argv[1]。打包形态下 SSH_ASKPASS 指向 Electron 本体,
//   Chromium 会先把它当开关解析,所以提示语绝不能直接落在 argv 的开关位置上。
it.skipIf(process.platform === 'win32')('never hands a server-controlled prompt to the client as a switch', async () => {
  const broker = new SshAuthBroker(nodeHost().secrets, () => {})
  const session = await broker.open(profile, 1, { executable: '/bin/echo' })
  try {
    const helper = session.env.SSH_ASKPASS ?? ''
    expect(helper, 'the helper must be a wrapper, not the client binary itself').not.toBe('/bin/echo')
    const hostile = '--remote-debugging-port=9222'
    const forwarded = execFileSync(helper, [hostile], { encoding: 'utf8' }).trim()
    expect(forwarded).toBe(`-- ${hostile}`)
  } finally { await session.close() }
})