/**
 * `store.ts` 的三条不变式。
 *
 * 这个文件是**步骤 6 会被 SQLite 整体替换**的临时实现,所以测的不是它的代码,
 * 而是它的**契约** —— 换成 `providers` / `model_aliases` 两张表之后,
 * 这份测试必须原样还能跑过。写在这里,是为了让那次替换有个网接着。
 *
 * 三条都不是显然的,而且三条的症状都出现在离 store 很远的地方:
 * 一条别名表的主键(症状在故障切换)、一条级联删除(症状在模型下拉框)、
 * 一条排序(症状在切换顺序)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import { store } from '../store'

const provider = (id: string, priority: number): UpstreamProvider => ({
  id,
  name: id,
  protocol: 'anthropic',
  baseUrl: `https://${id}.invalid`,
  credentialRef: `${id}:key`,
  priority,
  enabled: true
})

const alias = (providerId: string, name: string): ModelAlias => ({
  alias: name,
  providerId,
  upstreamModel: `${providerId}-上游名`,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  contextWindow: 100_000,
  maxOutputTokens: 4096
})

/** 每个用例自己收拾干净 —— store 是模块级单例,用例之间会互相看见 */
beforeEach(() => {
  for (const p of store.listProviders()) store.removeProvider(p.id)
  expect(store.listAliases()).toEqual([])
})

describe('别名表的主键是 (providerId, alias)', () => {
  it('★ 同一个 alias 由两个 provider 提供时,两条都在 —— 这正是故障切换的前提', () => {
    store.putProvider(provider('主', 0))
    store.putProvider(provider('备', 1))
    store.putAlias(alias('主', 'claude-sonnet-4'))
    store.putAlias(alias('备', 'claude-sonnet-4'))

    // 用 alias 当主键的话,这里只剩一条 —— 于是「切到下一个」没有下一个可切,
    // 而症状是「配了两个供应商,主的挂了整个应用就哑了」。
    expect(store.listAliases()).toHaveLength(2)
    expect(store.listAliases().map((a) => a.providerId).sort()).toEqual(['主', '备'])
  })

  it('同一个 (providerId, alias) 重复写入是更新,不是追加', () => {
    store.putProvider(provider('主', 0))
    store.putAlias(alias('主', 'm'))
    store.putAlias({ ...alias('主', 'm'), upstreamModel: '改过的' })

    expect(store.listAliases()).toHaveLength(1)
    expect(store.listAliases()[0]?.upstreamModel).toBe('改过的')
  })

  it('removeAlias 只删指定 provider 的那一条,不误伤同名的另一条', () => {
    store.putProvider(provider('主', 0))
    store.putProvider(provider('备', 1))
    store.putAlias(alias('主', 'm'))
    store.putAlias(alias('备', 'm'))

    store.removeAlias('主', 'm')

    expect(store.listAliases().map((a) => a.providerId)).toEqual(['备'])
  })

  it('拼接主键不会把 `a` + `|b` 和 `a|` + `b` 撞成同一个键', () => {
    store.putProvider(provider('a', 0))
    store.putProvider(provider('a|', 1))
    store.putAlias(alias('a', '|b'))
    store.putAlias(alias('a|', 'b'))

    // 用普通字符当分隔符时这两条会互相顶掉。分隔符选 U+0000 就是为了这个。
    expect(store.listAliases()).toHaveLength(2)
  })
})

describe('删 provider 连带删它的别名', () => {
  it('★ 否则留下一条指向不存在 provider 的别名', () => {
    store.putProvider(provider('主', 0))
    store.putProvider(provider('备', 1))
    store.putAlias(alias('主', 'm1'))
    store.putAlias(alias('主', 'm2'))
    store.putAlias(alias('备', 'm1'))

    store.removeProvider('主')

    // 悬空别名的症状离这里很远:「模型还在下拉框里,选了却报
    // 『没有已启用的供应商』」—— 没人会想到去看删 provider 那段代码。
    expect(store.listAliases().map((a) => a.providerId)).toEqual(['备'])
  })
})

describe('provider 列表按 priority 排', () => {
  it('★ 小的优先,而不是随插入顺序漂移', () => {
    store.putProvider(provider('慢', 50))
    store.putProvider(provider('快', 1))
    store.putProvider(provider('演示', 100))

    // 故障切换按这个顺序挑下一个候选(方案 §5.3)。依赖插入顺序的话,
    // 「先配哪个」就悄悄决定了「先切到哪个」—— 而用户设的 priority 形同虚设。
    expect(store.listProviders().map((p) => p.id)).toEqual(['快', '慢', '演示'])
  })
})
