/**
 * 退出登录的容错。
 *
 * ★ 退出是**本地动作**:撤销接口打不通、本地密文解不开(Windows 上换了机器或系统
 *   账户的 DPAPI 密文就会抛)、配置同步停不下来 —— 任何一条都不该把用户锁在
 *   已登录状态里。以前这些步骤是裸调用,第一个异常就把后面的清理全部掐掉,
 *   而界面上只剩一句「操作失败,请重试」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'

const mocks = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  credentials: new Map<string, string>(),
  aliases: [] as ModelAlias[],
  providers: [] as UpstreamProvider[],
  secretsGet: vi.fn<(ref: string) => Promise<string | null>>(),
  setKv: vi.fn<(key: string, value: unknown) => void>(),
  stopConfigSync: vi.fn<() => void>(),
  fetch: vi.fn(),
  emit: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../../window/registry', () => ({ windows: { emitToAll: mocks.emit } }))
vi.mock('../config-sync', () => ({
  startConfigSync: vi.fn(),
  stopConfigSync: mocks.stopConfigSync,
  shutdownConfigSync: vi.fn()
}))
vi.mock('../../runtime', () => ({
  getHost: () => ({
    secrets: {
      get: mocks.secretsGet,
      set: (ref: string, value: string) => { mocks.credentials.set(ref, value); return Promise.resolve() },
      remove: (ref: string) => { mocks.credentials.delete(ref); return Promise.resolve() },
      available: () => true
    },
    fetch: mocks.fetch
  })
}))
vi.mock('../../state/store', () => ({ store: {
  getKv: (key: string, fallback: unknown) => mocks.kv.get(key) ?? fallback,
  setKv: (key: string, value: unknown) => mocks.setKv(key, value),
  listAliases: () => mocks.aliases,
  putAlias: (alias: ModelAlias) => alias,
  removeAlias: (providerId: string, alias: string) => {
    mocks.aliases = mocks.aliases.filter((a) => !(a.providerId === providerId && a.alias === alias))
  },
  listProviders: () => mocks.providers,
  putProvider: (provider: UpstreamProvider) => { mocks.providers = [...mocks.providers, provider] },
  removeProvider: (id: string) => { mocks.providers = mocks.providers.filter((p) => p.id !== id) },
  listUserModelCatalog: () => []
} }))

import { getClientAuthState, signOutClient } from '../client-auth'

const META_KEY = 'client-auth.meta'

beforeEach(() => {
  mocks.kv.clear()
  mocks.kv.set(META_KEY, { mode: 'authenticated', user: { id: 'u1', email: 'a@b.c' }, expiresAt: Date.now() + 600_000 })
  mocks.credentials.clear()
  mocks.credentials.set('nextcowork:client-access-token', 'access')
  mocks.credentials.set('nextcowork:client-refresh-token', 'refresh')
  mocks.aliases = [{ alias: 'glm', providerId: 'nextcowork', upstreamModel: 'glm', priority: 0, enabled: true } as ModelAlias]
  mocks.providers = [{ id: 'nextcowork', name: 'NextCoWork', protocol: 'openai-responses', baseUrl: 'https://nextco.work/v1', credentialRef: 'nextcowork:client-access-token', priority: 1, enabled: true } as UpstreamProvider]
  mocks.setKv.mockImplementation((key, value) => { mocks.kv.set(key, value) })
  mocks.stopConfigSync.mockImplementation(() => undefined)
  mocks.secretsGet.mockImplementation((ref) => Promise.resolve(mocks.credentials.get(ref) ?? null))
  mocks.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
  mocks.emit.mockClear()
})

describe('退出登录', () => {
  it('正常路径:撤销远端凭证并清掉本地登录态、密钥、内置供应商', async () => {
    const next = await signOutClient()
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/client/oauth/revoke'), expect.objectContaining({ method: 'POST' }))
    expect(next.mode).toBe('undecided')
    expect(mocks.kv.get(META_KEY)).toBeNull()
    expect([...mocks.credentials.keys()]).toEqual([])
    expect(mocks.providers).toEqual([])
    expect(mocks.aliases).toEqual([])
  })

  it('refresh token 解不开时跳过远端撤销,本地照样登出干净', async () => {
    mocks.secretsGet.mockRejectedValue(new Error('Error while decrypting the ciphertext provided to safeStorage'))
    const next = await signOutClient()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(next.mode).toBe('undecided')
    expect(mocks.kv.get(META_KEY)).toBeNull()
    expect([...mocks.credentials.keys()]).toEqual([])
    // 本地登录态没了,下一次读状态就是「未决定」,不再显示成已登录
    expect(getClientAuthState().mode).toBe('undecided')
  })

  it('停止配置同步失败不阻断登出', async () => {
    mocks.stopConfigSync.mockImplementation(() => { throw new Error('database is closed') })
    await expect(signOutClient()).resolves.toMatchObject({ mode: 'undecided' })
    expect(mocks.kv.get(META_KEY)).toBeNull()
  })

  it('登录态真没清掉时,抛出带上失败步骤的原因,而不是一句空话', async () => {
    mocks.setKv.mockImplementation(() => { throw new Error('attempt to write a readonly database') })
    await expect(signOutClient()).rejects.toThrow(/store\.clearAuthMeta.*readonly database/u)
  })
})
