/**
 * 搜索服务的目录表与两个纯函数。
 *
 * 这里钉的不是「函数返回值对不对」,而是三条**坏起来不出声**的性质:
 *
 * 1. **目录 id 唯一。** id 是 `searchSecretRef` 的组成部分,重了就是两家共用
 *    同一把 Key —— 表现是「我在 A 家填的 Key,B 家也显示已配置」。
 * 2. **`reorderProviders` 的 priority 连续。** 界面显示的是「第几位」而不是
 *    priority 本身,留出空洞不会立刻显形,要等删掉中间一家再拖一次才看得见序号跳。
 * 3. **`searchChain` 会滤掉没 Key 的家。** 少了这一条,一个开着但没填 Key 的
 *    服务会在每次搜索时白跑一趟 HTTP 才失败,用户看到的是「搜索变慢了」。
 */
import { describe, expect, it } from 'vitest'
import type { SearchProviderConfig, SearchProviderStatus } from '../search'
import {
  SEARCH_CATALOG,
  SEARCH_PROVIDER_IDS,
  defaultProviderConfigs,
  isUsableProvider,
  reorderProviders,
  searchChain,
  searchMeta,
  searchSecretRef
} from '../search'

describe('SEARCH_CATALOG', () => {
  it('id 不重复', () => {
    expect(new Set(SEARCH_PROVIDER_IDS).size).toBe(SEARCH_CATALOG.length)
  })

  it('每一家都有名字、说明和领 Key 的地址', () => {
    for (const m of SEARCH_CATALOG) {
      expect(m.name).not.toBe('')
      expect(m.description).not.toBe('')
      expect(m.keyUrl).toMatch(/^https:\/\//)
    }
  })

  /**
   * ★ `unavailable` 是一句要**原样显示给用户**的话,不是一个布尔。
   * 空字符串会让界面上出现一行空白提示,而开关照样被禁掉 —— 用户完全看不出为什么。
   */
  it('标了用不了的家,原因是一句真话而不是空串', () => {
    for (const m of SEARCH_CATALOG) {
      if (m.unavailable === undefined) continue
      expect(m.unavailable.length).toBeGreaterThan(10)
    }
  })

  it('searchMeta 查得到每一个 id,查不到的返回 undefined', () => {
    for (const id of SEARCH_PROVIDER_IDS) expect(searchMeta(id)?.id).toBe(id)
    // @ts-expect-error 故意传一个不在联合里的 id —— 运行时不能抛
    expect(searchMeta('不存在的家')).toBeUndefined()
  })

  it('isUsableProvider 与 unavailable 是同一件事的两种问法', () => {
    for (const m of SEARCH_CATALOG) {
      expect(isUsableProvider(m.id)).toBe(m.unavailable === undefined)
    }
  })

  /** ★ 前缀是这两套密钥不会互相看见的全部保证 —— 它必须是字面量 */
  it('ref 一律 websearch: 打头,且各家互不相同', () => {
    const refs = SEARCH_PROVIDER_IDS.map((id) => searchSecretRef(id))
    expect(refs.every((r) => r.startsWith('websearch:'))).toBe(true)
    expect(new Set(refs).size).toBe(refs.length)
    // 和 MCP 那套(mcp: 打头)不可能撞上
    expect(refs.some((r) => r.startsWith('mcp:'))).toBe(false)
  })
})

describe('defaultProviderConfigs', () => {
  it('全关,且 priority 就是目录顺序', () => {
    const cfgs = defaultProviderConfigs()
    expect(cfgs.map((c) => c.id)).toEqual([...SEARCH_PROVIDER_IDS])
    expect(cfgs.every((c) => !c.enabled)).toBe(true)
    expect(cfgs.map((c) => c.priority)).toEqual(cfgs.map((_, i) => i))
  })
})

describe('reorderProviders', () => {
  const list = (): SearchProviderConfig[] =>
    ['tavily', 'exa', 'brave'].map((id, i) => ({
      id: id as SearchProviderConfig['id'],
      enabled: false,
      priority: i * 10 // 故意留空洞,看它会不会压平
    }))

  it('往后拖:被拖的落到目标位,中间的整体前移', () => {
    const out = reorderProviders(list(), 0, 2)
    expect(out.map((c) => c.id)).toEqual(['exa', 'brave', 'tavily'])
  })

  it('往前拖', () => {
    const out = reorderProviders(list(), 2, 0)
    expect(out.map((c) => c.id)).toEqual(['brave', 'tavily', 'exa'])
  })

  /** ★ 这条是重点:出来的 priority 一定是 0..n-1 连续的,输入有空洞也一样 */
  it('priority 被压成 0..n-1,不留空洞', () => {
    expect(reorderProviders(list(), 0, 2).map((c) => c.priority)).toEqual([0, 1, 2])
    expect(reorderProviders(list(), 1, 1).map((c) => c.priority)).toEqual([0, 1, 2])
  })

  it('下标越界时原样返回,但仍然把 priority 压平', () => {
    const out = reorderProviders(list(), 0, 99)
    expect(out.map((c) => c.id)).toEqual(['tavily', 'exa', 'brave'])
    expect(out.map((c) => c.priority)).toEqual([0, 1, 2])
  })

  it('不改传进来的那个数组', () => {
    const src = list()
    reorderProviders(src, 0, 2)
    expect(src.map((c) => c.id)).toEqual(['tavily', 'exa', 'brave'])
  })
})

describe('searchChain', () => {
  const st = (
    id: SearchProviderConfig['id'],
    o: { enabled?: boolean; hasKey?: boolean; priority?: number } = {}
  ): SearchProviderStatus => ({
    config: { id, enabled: o.enabled ?? true, priority: o.priority ?? 0 },
    hasKey: o.hasKey ?? true
  })

  it('按 priority 升序,不按传进来的顺序', () => {
    const out = searchChain([st('brave', { priority: 2 }), st('tavily', { priority: 1 })])
    expect(out.map((s) => s.config.id)).toEqual(['tavily', 'brave'])
  })

  it('关掉的、没 Key 的、用不了的,三种都不进链', () => {
    const out = searchChain([
      st('tavily', { enabled: false }),
      st('exa', { hasKey: false }),
      st('bing'), // 目录里标了 unavailable
      st('brave', { priority: 9 })
    ])
    expect(out.map((s) => s.config.id)).toEqual(['brave'])
  })

  it('一家都不合格时返回空数组,不是 undefined', () => {
    expect(searchChain([st('tavily', { hasKey: false })])).toEqual([])
  })
})
