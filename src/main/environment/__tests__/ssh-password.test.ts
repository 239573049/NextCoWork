/**
 * 表单里存下的账户密码，如何在 ssh 询问时被自动作答。
 *
 * ★ OpenSSH 不接受任何非交互方式传入的密码（没有开关、没有环境变量、stdin 也不行），
 * 唯一通道就是 SSH_ASKPASS。所以「表单填一次密码之后不再弹窗」这件事，全部实现就是
 * 下面这条自动作答路径 —— 它判错的两个方向代价都很实：判松了把密码发给不该发的主机，
 * 判紧了用户存了密码却照样天天弹窗。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { SshAuthRequest, SshConnectionProfile } from '../../../shared/domain/environment'
import { connectionSecretRef } from '../../../shared/domain/environment'
import type { KernelHost } from '../../kernel/host'
import { requestAskpass, shouldAutoAnswer, SshAuthBroker } from '../ssh/askpass'

const profile: SshConnectionProfile = { id: 'pw-test', kind: 'ssh', name: 'test', enabled: true, platform: 'auto',
  revision: 1, createdAt: 0, updatedAt: 0, target: { kind: 'manual', host: '10.0.0.5', port: 22, username: 'token' } }

const PASSWORD_REF = connectionSecretRef(profile.id, 'password')
// 真实 OpenSSH 的密码提示长这样（注意冒号后面那个空格）
const PROMPT = "token@10.0.0.5's password: "

function memorySecrets(initial: Record<string, string> = {}): KernelHost['secrets'] & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (ref) => Promise.resolve(store.get(ref) ?? null),
    set: (ref, value) => { store.set(ref, value); return Promise.resolve() },
    remove: (ref) => { store.delete(ref); return Promise.resolve() },
    available: () => true
  }
}

describe('shouldAutoAnswer', () => {
  const base = { prompt: PROMPT, resolved: { user: 'token', hostname: '10.0.0.5' }, alreadyUsed: false }

  it('只对密码类提示自动作答', () => {
    expect(shouldAutoAnswer({ ...base, kind: 'password' })).toBe(true)
    for (const kind of ['host-key', 'passphrase', 'challenge'] as const) {
      expect(shouldAutoAnswer({ ...base, kind }), `${kind} 必须交给人`).toBe(false)
    }
  })

  /**
   * ★ 一次连接尝试只答一次。存的密码要是过期了，ssh 默认会问三次
   * （`NumberOfPasswordPrompts`）—— 闷头答三遍同一个错密码，用户看到的是「卡住了」，
   * 而不是「密码不对」。
   */
  it('一次连接尝试只自动答一次', () => {
    expect(shouldAutoAnswer({ ...base, kind: 'password', alreadyUsed: true })).toBe(false)
  })

  /** ★ `ssh -G` 的结果还没到就不答：没有它就无从判断这个提示来自链路上的哪一跳 */
  it('解析结果缺失时判否（fail closed）', () => {
    expect(shouldAutoAnswer({ ...base, kind: 'password', resolved: undefined })).toBe(false)
  })

  it('没有 ProxyJump 时直接作答', () => {
    expect(shouldAutoAnswer({ ...base, kind: 'password', resolved: { hostname: '10.0.0.5', proxyJump: 'none' } })).toBe(true)
    expect(shouldAutoAnswer({ ...base, kind: 'password', resolved: { hostname: '10.0.0.5' } })).toBe(true)
  })

  /**
   * ★ 这一条是整个策略的理由。经跳板机时**第一个**密码提示来自跳板机 ——
   * 无条件自动作答等于把目标机的密码交给跳板机。
   */
  it('经跳板机时，提示指向跳板机就不作答', () => {
    const resolved = { user: 'token', hostname: '10.0.0.5', proxyJump: 'jump.example.com' }
    expect(shouldAutoAnswer({ kind: 'password', prompt: "token@jump.example.com's password: ", resolved, alreadyUsed: false }),
      '跳板机的提示不能拿目标机的密码去答').toBe(false)
    expect(shouldAutoAnswer({ kind: 'password', prompt: PROMPT, resolved, alreadyUsed: false }),
      '指向目标机的提示照答').toBe(true)
  })

  /** PAM 的 `Password:` 不含主机名 —— 有跳板机时无从判断来自哪一跳，只能交给人 */
  it('经跳板机时，认不出主机的提示交给人', () => {
    expect(shouldAutoAnswer({ kind: 'password', prompt: 'Password: ',
      resolved: { user: 'token', hostname: '10.0.0.5', proxyJump: 'jump' }, alreadyUsed: false })).toBe(false)
  })

  /** 没有跳板机时同一条 PAM 提示反而能答：整条链路只有一跳，提示必然来自目标机 */
  it('没有跳板机时，PAM 的裸 Password: 照样作答', () => {
    expect(shouldAutoAnswer({ kind: 'password', prompt: 'Password: ',
      resolved: { user: 'token', hostname: '10.0.0.5' }, alreadyUsed: false })).toBe(true)
  })
})

describe('broker 的自动作答', () => {
  it('存了密码就直接回给 ssh，界面上不弹窗', async () => {
    const notify = vi.fn()
    const broker = new SshAuthBroker(memorySecrets({ [PASSWORD_REF]: 'stored-secret' }), notify)
    const session = await broker.open(profile, 1, { executable: process.execPath })
    try {
      session.resolve(new Map([['user', 'token'], ['hostname', '10.0.0.5']]))
      expect(await requestAskpass(session.env, PROMPT)).toBe('stored-secret')
      expect(notify, '自动作答不该惊动渲染层').not.toHaveBeenCalled()
    } finally { await session.close() }
  })

  /**
   * ★ `ssh -G` 还没落地就来的提示要退回弹窗。时序上这不该发生（transport 先跑 -G 再认证），
   * 但一旦哪天顺序变了，宁可多弹一次窗，也不能拿一个来路不明的提示去对密码。
   */
  it('解析结果还没到时退回弹窗', async () => {
    const notify = vi.fn()
    const broker = new SshAuthBroker(memorySecrets({ [PASSWORD_REF]: 'stored-secret' }), notify)
    const session = await broker.open(profile, 1, { executable: process.execPath })
    try {
      const answer = requestAskpass(session.env, PROMPT)
      const rejected = expect(answer).rejects.toThrow()
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
      broker.cancelWindow(1)
      await rejected
    } finally { await session.close() }
  })

  /**
   * ★ 密码被拒之后**要说出来**。否则用户看到的是「我明明在连接里存了密码，它还是问我」，
   * 而真正发生的是那个密码不对 —— 用户会去怀疑功能坏了。
   */
  it('第二次询问退回弹窗，并说明已保存的密码被拒', async () => {
    const requests: SshAuthRequest[] = []
    const broker = new SshAuthBroker(memorySecrets({ [PASSWORD_REF]: 'stale' }), (_sender, request) => requests.push(request))
    const session = await broker.open(profile, 1, { executable: process.execPath })
    try {
      session.resolve(new Map([['user', 'token'], ['hostname', '10.0.0.5']]))
      expect(await requestAskpass(session.env, PROMPT)).toBe('stale')
      expect(requests, '第一次是自动答的').toHaveLength(0)

      const second = requestAskpass(session.env, PROMPT)
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(requests[0]!.savedRejected, '第二次必须标明已保存的密码被拒').toBe(true)
      expect(requests[0]!.hasSaved).toBe(true)
      await broker.respond(1, { id: requests[0]!.id, value: 'typed-by-hand' })
      expect(await second).toBe('typed-by-hand')
    } finally { await session.close() }
  })
})

describe('凭据的槽位', () => {
  /**
   * ★ 密码和连接表单里那个密码框是**同一份**。两套并存的话，表单清空了而弹窗存的那份还在，
   * 界面上既看不到也删不掉。
   */
  it('弹窗里勾「记住」的密码，落在表单能看到的那个槽位上', async () => {
    const secrets = memorySecrets()
    const requests: SshAuthRequest[] = []
    const broker = new SshAuthBroker(secrets, (_sender, request) => requests.push(request))
    const session = await broker.open(profile, 1, { executable: process.execPath })
    try {
      const answer = requestAskpass(session.env, PROMPT)
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      await broker.respond(1, { id: requests[0]!.id, value: 'typed', remember: true })
      await answer
      expect(secrets.store.get(PASSWORD_REF)).toBe('typed')
    } finally { await session.close() }
  })

  /** 私钥口令仍按提示哈希分开存 —— 一条链路上多个 hop 的 key 各有各的口令，挤一个槽位会互相覆盖 */
  it('私钥口令仍按提示分开存', async () => {
    const secrets = memorySecrets()
    const requests: SshAuthRequest[] = []
    const broker = new SshAuthBroker(secrets, (_sender, request) => requests.push(request))
    const session = await broker.open(profile, 1, { executable: process.execPath })
    const prompt = 'Enter passphrase for key /home/token/.ssh/id_ed25519: '
    try {
      const answer = requestAskpass(session.env, prompt)
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(requests[0]!.kind).toBe('passphrase')
      await broker.respond(1, { id: requests[0]!.id, value: 'key-pass', remember: true })
      await answer
      expect(secrets.store.get(PASSWORD_REF), '口令不能挤掉账户密码').toBeUndefined()
      expect(secrets.store.get(`connection:${profile.id}:prompt:${createHash('sha256').update(prompt).digest('hex')}`)).toBe('key-pass')
    } finally { await session.close() }
  })
})
