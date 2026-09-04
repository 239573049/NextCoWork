import { describe, expect, it } from 'vitest'
import { previewUrl } from '../../../../../../shared/domain/baseurl'
import {
  PROVIDER_PRESETS,
  findPreset,
  type PresetCategory,
  type ProviderPreset
} from '../../../../../../shared/domain/presets'
import {
  CATALOG_TABS,
  divergentCount,
  endpointRows,
  hasDivergentBaseUrls,
  listAccess,
  matchPresets,
  presetsForTab,
  tabCount
} from '../provider-catalog'

/**
 * ★ 取一条预设并且**取不到就直说取不到**。
 * 之前这里写的是 `findPreset('openrouter') as never` —— 断言骗过了类型,
 * 但哪天这个 id 改了名,null 会一路走进 `endpointRows`,报出来的是
 * 「Cannot read properties of null」,而真正的原因(预设改名了)一个字都不提。
 */
function preset(id: string): ProviderPreset {
  const p = findPreset(id)
  if (p === null) throw new Error(`预设 ${id} 不在表里了 —— 改了 id 就把这条测试一起改`)
  return p
}

describe('Tab 与预设表的自洽', () => {
  /**
   * ★ 这一条守的是「新加一个分类却忘了加 Tab」——
   * 那种漏法不会报错,只会让那一类预设**在界面上不存在**。
   */
  it('每个 category 都有一个 Tab 能走到', () => {
    const tabs = new Set(CATALOG_TABS.map((t) => t.id))
    for (const p of PROVIDER_PRESETS) {
      expect(tabs.has(p.category), `${p.id} 的分类 ${p.category} 没有 Tab`).toBe(true)
    }
  })

  it('四个分类 Tab 合起来正好是全表,不重不漏', () => {
    const cats: PresetCategory[] = ['domestic', 'aggregator', 'overseas', 'local']
    const ids = cats.flatMap((c) => presetsForTab(c)).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(PROVIDER_PRESETS.length)
  })

  /**
   * ★★ 这是 `presets.ts` 里点名的那个界面 bug 的防线:推荐若做成第五个**类别**,
   * OpenAI 会因为进了推荐而从「海外平台」里消失。推荐必须是**重复展示**。
   */
  it('推荐里的每一家,在它自己的分类栏里也还在', () => {
    for (const p of presetsForTab('recommended')) {
      const inOwn = presetsForTab(p.category).some((x) => x.id === p.id)
      expect(inOwn, `${p.id} 进了推荐就从 ${p.category} 里消失了`).toBe(true)
    }
  })

  it('推荐非空,且比全表小 —— 它是精选不是全选', () => {
    const n = tabCount('recommended')
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(PROVIDER_PRESETS.length)
  })

  it('每个 Tab 的条数就是它筛出来的条数', () => {
    for (const t of CATALOG_TABS) expect(tabCount(t.id)).toBe(presetsForTab(t.id).length)
  })
})

describe('endpointRows', () => {
  it('每条 endpoint 出一行,协议标签跟着走', () => {
    const or = preset('openrouter')
    const rows = endpointRows(or)
    expect(rows).toHaveLength(or.endpoints.length)
    expect(rows.map((r) => r.protocol)).toEqual(or.endpoints.map((e) => e.protocol))
  })

  /**
   * ★ 两族的版本段约定是**反的**:OpenAI 族的 `/v1` 在 base 里,
   * Anthropic 族不带、由客户端补。只显示 baseUrl 的话这看着像录错了数据,
   * 显示最终 URL 才看得出两边都对。
   */
  it('OpenRouter 两个协议的 base 不同,但拼出来的地址各自都对', () => {
    const rows = endpointRows(preset('openrouter'))
    const chat = rows.find((r) => r.protocol === 'openai-chat')
    const anth = rows.find((r) => r.protocol === 'anthropic')
    expect(chat?.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(anth?.baseUrl).toBe('https://openrouter.ai/api')
    expect(chat?.requestUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(anth?.requestUrl).toBe('https://openrouter.ai/api/v1/messages')
  })

  it('requestUrl 和真实请求走的是同一个拼接函数', () => {
    for (const p of PROVIDER_PRESETS) {
      for (const r of endpointRows(p)) {
        expect(r.requestUrl, `${p.id}/${r.protocol}`).toBe(previewUrl(r.baseUrl, r.protocol))
      }
    }
  })

  it('全表拼出来的地址都是合法 URL,且没有重复的 /v1/v1', () => {
    for (const p of PROVIDER_PRESETS) {
      for (const r of endpointRows(p)) {
        expect(() => new URL(r.requestUrl), `${p.id} ${r.requestUrl}`).not.toThrow()
        expect(r.requestUrl, `${p.id}`).not.toContain('/v1/v1')
      }
    }
  })
})

describe('listAccess —— 三态,不是布尔', () => {
  it('免鉴权 → public', () => {
    expect(listAccess({ protocol: 'openai-chat', baseUrl: 'x', supportsModelList: true, modelListPublic: true })).toBe('public')
  })

  it('要 key → key', () => {
    expect(listAccess({ protocol: 'openai-chat', baseUrl: 'x', supportsModelList: true })).toBe('key')
  })

  /** ★ false 同时意味着「确认没有」和「没拿到证据」,所以不能说成「不支持」 */
  it('没证据 → unknown,而不是一句「不支持」', () => {
    expect(listAccess({ protocol: 'anthropic', baseUrl: 'x', supportsModelList: false })).toBe('unknown')
  })

  it('modelListPublic 为真时,supportsModelList 怎样都算 public', () => {
    expect(listAccess({ protocol: 'openai-chat', baseUrl: 'x', supportsModelList: false, modelListPublic: true })).toBe('public')
  })
})

describe('hasDivergentBaseUrls', () => {
  it('OpenRouter 会随协议换地址', () => {
    expect(hasDivergentBaseUrls(preset('openrouter'))).toBe(true)
  })

  it('只有一条 endpoint 的预设不算', () => {
    const single = PROVIDER_PRESETS.filter((p) => p.endpoints.length === 1)
    expect(single.length).toBeGreaterThan(0)
    for (const p of single) expect(hasDivergentBaseUrls(p), p.id).toBe(false)
  })

  it('divergentCount 是真数,且确实有这么一批', () => {
    const n = divergentCount()
    expect(n).toBe(PROVIDER_PRESETS.filter(hasDivergentBaseUrls).length)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(PROVIDER_PRESETS.length)
  })
})

describe('matchPresets', () => {
  /** ★ 和 nav.ts 的 matchRows 故意相反:那边空查询=没在搜,这边列表本身就是内容 */
  it('空查询返回全部', () => {
    expect(matchPresets(PROVIDER_PRESETS, '')).toHaveLength(PROVIDER_PRESETS.length)
    expect(matchPresets(PROVIDER_PRESETS, '   ')).toHaveLength(PROVIDER_PRESETS.length)
  })

  it('按名字命中,大小写无关', () => {
    expect(matchPresets(PROVIDER_PRESETS, 'OpenRouter').map((p) => p.id)).toContain('openrouter')
    expect(matchPresets(PROVIDER_PRESETS, 'openrouter').map((p) => p.id)).toContain('openrouter')
  })

  it('按地址命中 —— 用户手上常常只有一个域名', () => {
    const hit = matchPresets(PROVIDER_PRESETS, 'openrouter.ai')
    expect(hit.map((p) => p.id)).toContain('openrouter')
  })

  it('本地那几家能靠 127.0.0.1 搜出来', () => {
    const hit = matchPresets(PROVIDER_PRESETS, '127.0.0.1')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit.every((p) => p.category === 'local')).toBe(true)
  })

  it('按推荐模型命中', () => {
    const withModels = PROVIDER_PRESETS.find((p) => p.suggestedModels.length > 0)
    const m = withModels?.suggestedModels[0] as string
    expect(matchPresets(PROVIDER_PRESETS, m).map((p) => p.id)).toContain(withModels?.id)
  })

  it('没命中返回空(驱动空态)', () => {
    expect(matchPresets(PROVIDER_PRESETS, 'zzz没有这一家')).toEqual([])
  })

  it('只在传进来的那一撮里筛,不偷偷扩回全表', () => {
    const local = presetsForTab('local')
    expect(matchPresets(local, 'openrouter')).toEqual([])
  })
})
