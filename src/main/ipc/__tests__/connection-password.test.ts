/**
 * 连接表单里那个密码框的存储侧规矩。
 *
 * ★ 密码是**传输期字段**：它经 `connection:upsert` 进来，被剥下来加密存进 `credentials`，
 * 绝不写进 `connection_profiles` 行、也绝不回渲染层。这两条一旦破了都是静默的 ——
 * 数据库里多出一列明文密码不会报错，`connection:list` 多带一个字段也不会报错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionSecretRef, type ConnectionProfile } from '../../../shared/domain/environment'

const mocks = vi.hoisted(() => ({
  profiles: new Map<string, ConnectionProfile>(),
  credentials: new Map<string, string>(),
  available: true,
  emit: vi.fn(),
  disconnect: vi.fn()
}))

vi.mock('electron', () => ({ app: {}, dialog: {} }))
vi.mock('../../window/registry', () => ({ windows: { emitToAll: mocks.emit } }))
vi.mock('../../runtime', () => ({
  getEnvironments: () => ({ disconnect: mocks.disconnect, status: () => ({ phase: 'disconnected', generation: 0 }) }),
  getHost: () => ({ secrets: {
    get: (ref: string) => Promise.resolve(mocks.credentials.get(ref) ?? null),
    set: (ref: string, value: string) => { mocks.credentials.set(ref, value); return Promise.resolve() },
    remove: (ref: string) => { mocks.credentials.delete(ref); return Promise.resolve() },
    available: () => mocks.available
  } }),
  installEnvironmentInteraction: vi.fn()
}))
vi.mock('../../state/store', () => ({ store: {
  getConnectionProfile: (id: string) => mocks.profiles.get(id),
  listConnectionProfiles: () => [...mocks.profiles.values()],
  putConnectionProfile: (profile: ConnectionProfile) => { mocks.profiles.set(profile.id, profile) },
  listWorkspaces: () => []
} }))

import { listConnections, upsertConnection } from '../connections'

const input = (extra: Record<string, unknown> = {}): Parameters<typeof upsertConnection>[0] => ({
  kind: 'ssh', name: 'server', platform: 'auto', enabled: true,
  target: { kind: 'manual', host: '10.0.0.5', port: 22, username: 'token' }, ...extra
}) as Parameters<typeof upsertConnection>[0]

beforeEach(() => {
  mocks.profiles.clear()
  mocks.credentials.clear()
  mocks.available = true
  mocks.emit.mockClear()
})

describe('账户密码的存储', () => {
  it('存进安全存储，而不是连接档案', async () => {
    const profile = await upsertConnection(input({ password: 'hunter2' }))
    expect(mocks.credentials.get(connectionSecretRef(profile.id, 'password'))).toBe('hunter2')
    // ★ 档案是整行 JSON 落库的 —— 密码只要沾上它一次就是明文落盘
    expect(JSON.stringify(profile), '密码绝不能出现在 connection_profiles 行里').not.toContain('hunter2')
  })

  it('列表只回布尔，不回密码原文', async () => {
    const profile = await upsertConnection(input({ password: 'hunter2' }))
    const listed = await listConnections()
    expect(listed[0]!.hasPassword).toBe(true)
    expect(JSON.stringify(listed), '密码永不离开主进程').not.toContain('hunter2')
    expect(listed[0]!.profile.id).toBe(profile.id)
  })

  /** 留空 = 不动已存的那份。表单里本来就不回填密码，空串只能理解成「没改」 */
  it('不带 password 字段时保留已存的密码', async () => {
    const first = await upsertConnection(input({ password: 'hunter2' }))
    await upsertConnection(input({ id: first.id, revision: first.revision, name: '改个名字' }))
    expect(mocks.credentials.get(connectionSecretRef(first.id, 'password'))).toBe('hunter2')
    expect((await listConnections())[0]!.hasPassword).toBe(true)
  })

  it('显式传 null 才清除', async () => {
    const first = await upsertConnection(input({ password: 'hunter2' }))
    await upsertConnection(input({ id: first.id, revision: first.revision, password: null }))
    expect(mocks.credentials.has(connectionSecretRef(first.id, 'password'))).toBe(false)
    expect((await listConnections())[0]!.hasPassword).toBe(false)
  })

  /**
   * ★ 存不了就什么都不写。
   *
   * Linux 上没有 keyring 时 safeStorage 不可用，而明文落盘不是可接受的降级。部分成功比
   * 整体失败更糟：用户以为密码存好了，下次连接却又被问，还找不到原因。
   */
  it('安全存储不可用时整次保存失败，连档案都不留', async () => {
    mocks.available = false
    await expect(upsertConnection(input({ password: 'hunter2' }))).rejects.toThrow('invalid-profile')
    expect(mocks.profiles.size, '密码存不下时不能留下半个连接').toBe(0)
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('不带密码时，安全存储不可用照样能存连接', async () => {
    mocks.available = false
    await expect(upsertConnection(input())).resolves.toBeDefined()
    expect((await listConnections())[0]!.hasPassword).toBe(false)
  })

  it.each([['x'.repeat(8193)], ['with\0null']])('拒绝畸形密码 %#', async (password) => {
    await expect(upsertConnection(input({ password }))).rejects.toThrow('invalid-profile')
    expect(mocks.profiles.size).toBe(0)
  })
})
