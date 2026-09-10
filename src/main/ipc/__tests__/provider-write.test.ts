/**
 * `provider:upsert` / `provider:remove` 的写入面。
 *
 * 这里只测三样**无声失败**的东西 —— 三样都不会报错,只会让某件事在以后某一刻错掉:
 *
 * 1. **baseUrl 的协议白名单**。`file:` 的 baseUrl 会被 `joinUpstreamUrl` 拼进
 *    `net.fetch`,等于把任意文件读取权交给渲染层。它不会抛在这里,会抛在很远的地方。
 * 2. **`credentialRef` 不采信渲染层**。采信了就意味着「供应商 A 可以指向供应商 B 的
 *    密钥」,而密钥只写不读,谁也不会发现指错了。
 * 3. ★★ **删完之后 `defaultModel` 不许悬空**。这条最隐蔽:用户删了一个不用的供应商,
 *    症状是**下一次发送找不到候选**,而那两件事之间在界面上没有任何联系。
 *
 * 用真文件库、每个用例开新目录 —— 和 `db/__tests__/roundtrip.test.ts` 同一套。
 * 不装 host:这三条路径一步都不碰 `secrets`(碰的是 `setCredential`,那条要真密钥环)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpstreamProvider } from '../../../shared/domain/provider'
import { anthropicCacheTtlOf } from '../../../shared/domain/provider'
import { closeDatabase, openDatabase } from '../../db/index'
import { resetRuntimeForTest } from '../../runtime'
import { store } from '../../state/store'
import {
  listModels,
  listProviders,
  removeModel,
  removeProvider,
  renameModel,
  setAliases,
  upsertProvider
} from '../provider'
import { BUILTIN_PROVIDER_ID, CLIENT_PROVIDER_ID } from '../../../shared/domain/presets'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-provider-'))
  openDatabase(dir)
  resetRuntimeForTest()
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const draft = (over: Partial<UpstreamProvider> = {}): UpstreamProvider => ({
  id: 'acme',
  name: 'Acme',
  protocol: 'anthropic',
  baseUrl: 'https://api.acme.invalid',
  credentialRef: 'provider:acme',
  priority: 10,
  enabled: true,
  ...over
})

describe('upsertProvider', () => {
  it('只放行 http / https', () => {
    expect(() => upsertProvider(draft({ baseUrl: 'file:///etc/passwd' }))).toThrow(/http/)
    expect(() => upsertProvider(draft({ baseUrl: 'data:text/plain,x' }))).toThrow(/http/)
    // 本地运行时是明文 http,不能一起挡掉
    expect(upsertProvider(draft({ baseUrl: 'http://127.0.0.1:11434' })).baseUrl).toBe(
      'http://127.0.0.1:11434'
    )
  })

  it('不是合法 URL 的地址直接拒掉,而不是存进去等发请求时才炸', () => {
    expect(() => upsertProvider(draft({ baseUrl: 'api.acme.invalid' }))).toThrow(/合法/)
    expect(() => upsertProvider(draft({ baseUrl: '   ' }))).toThrow(/不能为空/)
  })

  it('未知协议拒掉 —— 它决定鉴权头和请求路径,存错了每一次请求都是错的', () => {
    expect(() =>
      upsertProvider(draft({ protocol: 'gemini' as UpstreamProvider['protocol'] }))
    ).toThrow(/协议/)
  })

  it('★ 新建时 credentialRef 由主进程派生,渲染层填什么都不算数', () => {
    const saved = upsertProvider(draft({ credentialRef: 'provider:someone-else' }))
    expect(saved.credentialRef).toBe('provider:acme')
  })

  it('★ 更新时保留库里那条 ref —— 改名换地址不该弄丢已经存好的 key', () => {
    upsertProvider(draft())
    const renamed = upsertProvider(
      draft({
        name: 'Acme 2',
        baseUrl: 'https://v2.acme.invalid',
        credentialRef: 'provider:hijack'
      })
    )
    expect(renamed.credentialRef).toBe('provider:acme')
    expect(renamed.name).toBe('Acme 2')
  })

  it('名称去空白;全空白的名称拒掉', () => {
    expect(upsertProvider(draft({ name: '  Acme  ' })).name).toBe('Acme')
    expect(() => upsertProvider(draft({ name: '   ' }))).toThrow(/名称/)
  })

  it('按 Provider 保存 Anthropic 缓存档位，并在旧字段缺失时有效值为 off', () => {
    expect(anthropicCacheTtlOf(draft())).toBe('off')
    const saved = upsertProvider(
      draft({ protocolOptions: { anthropic: { cacheTtl: '5m' } } })
    )
    expect(anthropicCacheTtlOf(saved)).toBe('5m')

    const changedProtocol = upsertProvider(
      draft({ protocol: 'openai-chat', protocolOptions: undefined })
    )
    expect(anthropicCacheTtlOf(changedProtocol)).toBe('5m')
    expect(anthropicCacheTtlOf(upsertProvider(draft({ protocol: 'anthropic' })))).toBe('5m')
  })

  it('省略 protocolOptions 的旧版更新不会清空配置；显式嵌套更新保留未来字段', () => {
    const withFuture = draft({
      protocolOptions: {
        anthropic: { cacheTtl: '1h' },
        futureProtocol: {
          enabled: true,
          transport: { region: 'cn-east', timeoutMs: 10_000 }
        }
      } as UpstreamProvider['protocolOptions']
    })
    upsertProvider(withFuture)

    const renamed = upsertProvider(draft({ name: 'Acme 新名字' }))
    expect(renamed.protocolOptions).toEqual({
      anthropic: { cacheTtl: '1h' },
      futureProtocol: {
        enabled: true,
        transport: { region: 'cn-east', timeoutMs: 10_000 }
      }
    })

    const changed = upsertProvider(
      draft({
        protocolOptions: {
          anthropic: { cacheTtl: 'off' },
          futureProtocol: { transport: { timeoutMs: 30_000 } }
        } as UpstreamProvider['protocolOptions']
      })
    )
    expect(changed.protocolOptions).toEqual({
      anthropic: { cacheTtl: 'off' },
      futureProtocol: {
        enabled: true,
        transport: { region: 'cn-east', timeoutMs: 30_000 }
      }
    })
  })

  it('空的嵌套更新保留已有档位；显式 undefined/null 不能清空或绕过校验', () => {
    upsertProvider(draft({ protocolOptions: { anthropic: { cacheTtl: '1h' } } }))

    const emptyTop = upsertProvider(
      draft({ protocolOptions: {} })
    )
    expect(anthropicCacheTtlOf(emptyTop)).toBe('1h')

    const emptyAnthropic = upsertProvider(
      draft({ protocolOptions: { anthropic: {} } } as unknown as UpstreamProvider)
    )
    expect(anthropicCacheTtlOf(emptyAnthropic)).toBe('1h')

    expect(() =>
      upsertProvider(
        draft({
          protocolOptions: { anthropic: { cacheTtl: undefined } }
        } as unknown as UpstreamProvider)
      )
    ).toThrow(/off、5m 或 1h/)
    expect(() =>
      upsertProvider(
        draft({ protocolOptions: { anthropic: null } } as unknown as UpstreamProvider)
      )
    ).toThrow(/必须是一个对象/)
    expect(anthropicCacheTtlOf(listProviders().find((p) => p.id === 'acme')!)).toBe('1h')
  })

  it('显式非法 TTL 被拒绝且不覆盖原配置；异常旧值按 off 使用', () => {
    upsertProvider(draft({ protocolOptions: { anthropic: { cacheTtl: '1h' } } }))
    expect(() =>
      upsertProvider(
        draft({
          protocolOptions: { anthropic: { cacheTtl: '90d' } }
        } as unknown as UpstreamProvider)
      )
    ).toThrow(/off、5m 或 1h/)
    expect(anthropicCacheTtlOf(listProviders().find((p) => p.id === 'acme')!)).toBe('1h')

    // Direct/imported legacy JSON may contain an unknown value; persistence
    // sanitizes it so a future read can never accidentally enable caching.
    store.putProvider(
      draft({
        protocolOptions: { anthropic: { cacheTtl: 'unknown' } }
      } as unknown as UpstreamProvider)
    )
    expect(anthropicCacheTtlOf(listProviders().find((p) => p.id === 'acme')!)).toBe('off')
  })

  it('重播种内置 Provider 时保留已保存的协议配置', () => {
    store.putProvider(
      draft({
        id: BUILTIN_PROVIDER_ID,
        protocol: 'openai-chat',
        protocolOptions: { anthropic: { cacheTtl: '1h' } }
      })
    )

    // resetRuntimeForTest clears the per-process seeded flag while leaving the
    // SQLite row in place, matching an application restart.
    resetRuntimeForTest()
    const seeded = listProviders().find((p) => p.id === BUILTIN_PROVIDER_ID)
    expect(seeded).toMatchObject({
      protocol: 'openai-chat',
      protocolOptions: { anthropic: { cacheTtl: '1h' } }
    })
  })
})

describe('removeProvider 之后设置不许悬空', () => {
  /** 建一个供应商 + 一条别名,别名名字和 id 同名,方便断言 */
  const withAlias = (id: string, priority: number): void => {
    upsertProvider(draft({ id, name: id, baseUrl: `https://${id}.invalid`, priority }))
    store.putAlias({
      alias: id,
      providerId: id,
      upstreamModel: id,
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
      contextWindow: 1000,
      maxOutputTokens: 100
    })
  }

  it('★ defaultModel 指向被删的别名时,接到剩下的第一条', () => {
    withAlias('alpha', 1)
    withAlias('beta', 2)
    store.updateSettings({ defaultModel: 'alpha' })

    removeProvider('alpha')

    const after = store.getSettings().defaultModel
    expect(after).not.toBe('alpha')
    // 接到的必须是**真的还在**的那条,不是随便一个字符串
    expect(listModels().map((m) => m.alias)).toContain(after)
  })

  it('一条别名都不剩时置空 —— 空串是合法值(界面显示「跟随对话」)', () => {
    withAlias('alpha', 1)
    store.updateSettings({ defaultModel: 'alpha' })

    // 演示上游是 seed 种进来的,一并删掉才是「一条不剩」
    for (const p of listProviders()) removeProvider(p.id)

    expect(store.getSettings().defaultModel).toBe('')
  })

  it('删的是别人时不动 defaultModel', () => {
    withAlias('alpha', 1)
    withAlias('beta', 2)
    store.updateSettings({ defaultModel: 'alpha' })

    removeProvider('beta')

    expect(store.getSettings().defaultModel).toBe('alpha')
  })

  it('子代理模型悬空时置空(空串 = 跟随主对话,本来就合法)', () => {
    withAlias('alpha', 1)
    withAlias('beta', 2)
    store.updateSettings({ defaultModel: 'beta', subagent: { model: 'alpha' } })

    removeProvider('alpha')

    expect(store.getSettings().subagent.model).toBe('')
    expect(store.getSettings().defaultModel).toBe('beta')
  })

  it('别名跟着供应商一起消失', () => {
    withAlias('alpha', 1)
    expect(listModels('alpha')).toHaveLength(1)

    removeProvider('alpha')

    expect(listModels('alpha')).toHaveLength(0)
    expect(listProviders().map((p) => p.id)).not.toContain('alpha')
  })

  it('删一个不存在的 id 是无操作,不抛', () => {
    const before = listProviders().length
    expect(() => removeProvider('nope')).not.toThrow()
    expect(listProviders()).toHaveLength(before)
  })
})

describe('模型别名的逐行管理', () => {
  it('保存的优先级顺序不会被数据库的字母序覆盖', () => {
    upsertProvider(draft())

    setAliases('acme', ['zeta', 'alpha', 'middle'])

    expect(listModels('acme').map((model) => model.upstreamModel)).toEqual([
      'zeta',
      'alpha',
      'middle'
    ])
  })

  it('重命名最后一个同名别名时，默认模型和子代理模型跟着更新', () => {
    upsertProvider(draft())
    setAliases('acme', ['original'])
    store.updateSettings({ defaultModel: 'original', subagent: { model: 'original' } })

    renameModel('acme', 'original', 'renamed')

    expect(listModels('acme')[0]?.alias).toBe('renamed')
    expect(store.getSettings()).toMatchObject({
      defaultModel: 'renamed',
      subagent: { model: 'renamed' }
    })
  })
})

/**
 * 设置项从「一个裸别名」变成「别名 + 供应商」之后,别名表变动时的修复规则。
 * ★ 核心不变式:**一次都不做跨供应商的静默回退**。
 */
describe('锁定了供应商的设置项在别名表变动后怎么修', () => {
  /** 两家都提供同一个别名 —— 就是用户报的那个撞名场景 */
  const bothOffer = (alias: string): void => {
    for (const [id, priority] of [['routin', 1], ['codex', 2]] as const) {
      upsertProvider(draft({ id, name: id, baseUrl: `https://${id}.invalid`, priority }))
      store.putAlias({
        alias, providerId: id, upstreamModel: alias,
        capabilities: { tools: true, vision: false, thinking: false, caching: false },
        contextWindow: 1000, maxOutputTokens: 100
      })
    }
  }

  it('删掉的是没锁定的那家时,设置一个字都不动', () => {
    bothOffer('shared')
    store.updateSettings({ defaultModel: 'shared', defaultModelProviderId: 'codex' })

    removeProvider('routin')

    expect(store.getSettings()).toMatchObject({
      defaultModel: 'shared', defaultModelProviderId: 'codex'
    })
  })

  it('★ 锁定的那家被删而别名还在别处:只解锁,不改名、也不换成另一家', () => {
    bothOffer('shared')
    store.updateSettings({ defaultModel: 'shared', defaultModelProviderId: 'codex' })

    removeProvider('codex')

    const after = store.getSettings()
    expect(after.defaultModel).toBe('shared')
    expect(after.defaultModelProviderId).toBeUndefined()
  })

  it('锁定的那家是唯一提供者时才接到别的别名,且供应商跟着一起写上', () => {
    bothOffer('shared')
    upsertProvider(draft({ id: 'solo', name: 'solo', baseUrl: 'https://solo.invalid', priority: 3 }))
    store.putAlias({
      alias: 'only-here', providerId: 'solo', upstreamModel: 'only-here',
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
      contextWindow: 1000, maxOutputTokens: 100
    })
    store.updateSettings({ defaultModel: 'only-here', defaultModelProviderId: 'solo' })

    removeProvider('solo')

    const after = store.getSettings()
    expect(after.defaultModel).not.toBe('only-here')
    const alive = listModels()
    expect(alive.map((m) => m.alias)).toContain(after.defaultModel)
    // 接过去时必须**同时**写上供应商,否则又留下一个只有别名的悬空配对
    expect(alive.some((m) => m.alias === after.defaultModel
      && m.providerId === after.defaultModelProviderId)).toBe(true)
  })

  it('供应商只是被**停用**时不改写 —— 停用可逆,改了他开回来就发现选择没了', () => {
    bothOffer('shared')
    store.updateSettings({ defaultModel: 'shared', defaultModelProviderId: 'codex' })

    upsertProvider(draft({ id: 'codex', name: 'codex', baseUrl: 'https://codex.invalid',
      priority: 2, enabled: false }))

    expect(store.getSettings()).toMatchObject({
      defaultModel: 'shared', defaultModelProviderId: 'codex'
    })
  })

  it('审核模型也被照顾到 —— 以前它根本不在这个函数的视野里', () => {
    bothOffer('shared')
    upsertProvider(draft({ id: 'solo', name: 'solo', baseUrl: 'https://solo.invalid', priority: 3 }))
    store.putAlias({
      alias: 'reviewer', providerId: 'solo', upstreamModel: 'reviewer',
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
      contextWindow: 1000, maxOutputTokens: 100
    })
    store.updateSettings({ permissionReviewerModel: 'reviewer', permissionReviewerModelProviderId: 'solo' })

    removeProvider('solo')

    const after = store.getSettings()
    expect(after.permissionReviewerModel).toBe('')
    expect(after.permissionReviewerModelProviderId).toBeUndefined()
  })

  it('改名:锁定的正是这一家时无条件跟着改,哪怕别家还有同名别名', () => {
    bothOffer('shared')
    store.updateSettings({ defaultModel: 'shared', defaultModelProviderId: 'codex' })

    renameModel('codex', 'shared', 'shared-v2')

    expect(store.getSettings()).toMatchObject({
      defaultModel: 'shared-v2', defaultModelProviderId: 'codex'
    })
  })

  it('改名:锁定的是另一家时不动', () => {
    bothOffer('shared')
    store.updateSettings({ defaultModel: 'shared', defaultModelProviderId: 'routin' })

    renameModel('codex', 'shared', 'shared-v2')

    expect(store.getSettings()).toMatchObject({
      defaultModel: 'shared', defaultModelProviderId: 'routin'
    })
  })
})

describe('供应商 id 的字符约束', () => {
  it('拒收带斜杠的 id —— 它会让 providerId/alias 复合键歧义', () => {
    expect(() => upsertProvider(draft({ id: 'a/b', name: 'x', baseUrl: 'https://x.invalid' })))
      .toThrow(/斜杠/u)
  })
})

/**
 * 内置 NextCoWork 那条是**字段级托管**,不是整条只读。
 *
 * 边界:名称 / 地址 / 凭证归登录流程(`client-auth.ts`),协议格式和模型列表归用户。
 * 两侧都是无声失败的那类 —— 托管字段被采信了,平台 access token 就会被发到
 * 用户填的那个地址去;而模型别名要是仍然拒写,设置页上的按钮点了只会弹一句报错。
 */
describe('内置 NextCoWork 供应商:哪些能改,哪些不能', () => {
  const PLATFORM_URL = 'https://nextco.work/v1'

  /** 登录流程建出来的那条(`ensureClientProvider`)。这里直接落库,不经过 upsert */
  const seedClient = (): void => {
    store.putProvider({
      id: CLIENT_PROVIDER_ID,
      name: 'NextCoWork',
      protocol: 'openai-chat',
      baseUrl: PLATFORM_URL,
      credentialRef: 'nextcowork:client-access-token',
      priority: 1,
      enabled: true
    })
  }

  const client = (): UpstreamProvider | undefined =>
    listProviders().find((p) => p.id === CLIENT_PROVIDER_ID)

  it('协议格式能改', () => {
    seedClient()

    upsertProvider({ ...draft(), id: CLIENT_PROVIDER_ID, name: 'NextCoWork', baseUrl: PLATFORM_URL, protocol: 'anthropic' })

    expect(client()?.protocol).toBe('anthropic')
  })

  it('同一次调用里改名称和地址会被忽略 —— 那两个字段归登录流程', () => {
    seedClient()

    upsertProvider({
      ...draft(),
      id: CLIENT_PROVIDER_ID,
      name: '我的中转',
      baseUrl: 'https://evil.invalid/v1',
      protocol: 'anthropic'
    })

    expect(client()).toMatchObject({
      name: 'NextCoWork',
      baseUrl: PLATFORM_URL,
      credentialRef: 'nextcowork:client-access-token',
      // 托管字段被挡住,不该连带把用户真正改的那个也丢掉
      protocol: 'anthropic'
    })
  })

  it('模型列表能整表替换,也能逐条删', () => {
    seedClient()

    setAliases(CLIENT_PROVIDER_ID, ['gpt-a', 'gpt-b'])
    expect(listModels(CLIENT_PROVIDER_ID).map((m) => m.upstreamModel)).toEqual(['gpt-a', 'gpt-b'])

    removeModel(CLIENT_PROVIDER_ID, 'gpt-a')
    expect(listModels(CLIENT_PROVIDER_ID).map((m) => m.upstreamModel)).toEqual(['gpt-b'])
  })

  it('还没登录时凭空建一条会被拒 —— 那样建出来的拿不到 access token', () => {
    expect(() => upsertProvider({ ...draft(), id: CLIENT_PROVIDER_ID }))
      .toThrow(/登录/u)
  })

  it('仍然不能删', () => {
    seedClient()

    expect(() => removeProvider(CLIENT_PROVIDER_ID)).toThrow(/不能删除/u)
    expect(client()).toBeDefined()
  })
})
