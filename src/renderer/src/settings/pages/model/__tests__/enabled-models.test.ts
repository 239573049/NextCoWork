import { describe, expect, it } from 'vitest'
import type { ModelAlias, UpstreamProvider } from '../../../../../../shared/domain/provider'
import {
  BUILTIN_PLAN_PROVIDER_ID,
  BUILTIN_PROVIDER_ID,
  findPreset
} from '../../../../../../shared/domain/presets'
import { avatarInitial, providerEntries } from '../enabled-models'

const prov = (id: string, name = id): UpstreamProvider => ({
  id,
  name,
  protocol: 'openai-chat',
  baseUrl: `https://${id}.example.com/v1`,
  credentialRef: `cred:${id}`,
  priority: 0,
  enabled: true
})

const alias = (a: string, providerId: string): ModelAlias => ({
  alias: a,
  providerId,
  upstreamModel: a,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  contextWindow: 200_000,
  maxOutputTokens: 8192
})

describe('providerEntries', () => {
  it('每个供应商一行,顺序照 providers', () => {
    const e = providerEntries([prov('a'), prov('b')], [], '')
    expect(e.map((x) => x.provider.id)).toEqual(['a', 'b'])
  })

  it('别名按 providerId 归到各自那一行', () => {
    const e = providerEntries(
      [prov('a'), prov('b')],
      [alias('m1', 'a'), alias('m2', 'b'), alias('m3', 'a')],
      ''
    )
    expect(e[0]?.aliases.map((m) => m.alias)).toEqual(['m1', 'm3'])
    expect(e[1]?.aliases.map((m) => m.alias)).toEqual(['m2'])
  })

  it('副标题取第一个别名;一个都没有时是 null,不是空串', () => {
    const e = providerEntries([prov('a'), prov('b')], [alias('m1', 'a')], '')
    expect(e[0]?.primaryAlias).toBe('m1')
    expect(e[1]?.primaryAlias).toBeNull()
  })

  it('默认徽章落在提供该别名的那一家', () => {
    const e = providerEntries([prov('a'), prov('b')], [alias('m1', 'a'), alias('m2', 'b')], 'm2')
    expect(e.map((x) => x.isDefault)).toEqual([false, true])
  })

  /**
   * ★★ 这一条是我们和参考图的**结构差异**:故障切换轴就是「同一别名多个供应商」,
   * 所以能提供默认别名的可能不止一家。只给第一家挂徽章等于宣称另一家跟这次请求
   * 无关,而它随时会接手。
   */
  it('同一别名有多家提供时,每一家都算默认', () => {
    const e = providerEntries([prov('a'), prov('b')], [alias('m1', 'a'), alias('m1', 'b')], 'm1')
    expect(e.map((x) => x.isDefault)).toEqual([true, true])
  })

  it('默认模型为空串(跟随对话)时没有任何一家是默认', () => {
    const e = providerEntries([prov('a')], [alias('m1', 'a')], '')
    expect(e.every((x) => !x.isDefault)).toBe(true)
  })

  it('默认模型指向一个已经不存在的别名时,不挂徽章也不报错', () => {
    const e = providerEntries([prov('a')], [alias('m1', 'a')], '已经删掉的模型')
    expect(e.every((x) => !x.isDefault)).toBe(true)
  })

  it('没有供应商时是空数组', () => {
    expect(providerEntries([], [], '')).toEqual([])
  })
})

/**
 * ★★ 内置那两条上游的「主模型」—— 副标题显示谁,由**预设表的 `suggestedModels` 顺序**
 * 决定(`main/runtime.ts` 的 seed 按下标算 `priority`,这里取 `aliases[0]`)。
 *
 * 单独钉一条,是因为这层耦合隔了两个模块、跨了主/渲染进程,而它断掉不会报错:
 * 有人「顺手」把订阅线的模型列表按字母排一下,左列副标题就从 `gpt-5.6-sol`
 * 变成 `gpt-5.3-codex-spark` —— 界面照常渲染,只是显示的不再是那条线该用的模型。
 */
describe('内置上游的主模型', () => {
  const primaryOf = (presetId: string): string | null => {
    const models = findPreset(presetId)?.suggestedModels ?? []
    const aliases = models.map((m) => alias(m, presetId))
    return providerEntries([prov(presetId)], aliases, '')[0]?.primaryAlias ?? null
  }

  it('按量线显示 deepseek-v4-pro,订阅线显示 gpt-5.6-sol', () => {
    expect(primaryOf(BUILTIN_PROVIDER_ID)).toBe('deepseek-v4-pro')
    expect(primaryOf(BUILTIN_PLAN_PROVIDER_ID)).toBe('gpt-5.6-sol')
  })

  /** 两条线各显示各的 —— 混在一起就说明 providerId 归属错了 */
  it('两条线的主模型不是同一个', () => {
    expect(primaryOf(BUILTIN_PROVIDER_ID)).not.toBe(primaryOf(BUILTIN_PLAN_PROVIDER_ID))
  })
})

describe('avatarInitial', () => {
  it('取首字并大写', () => {
    expect(avatarInitial('routinAI')).toBe('R')
    expect(avatarInitial('智谱')).toBe('智')
  })

  it('忽略前导空格', () => {
    expect(avatarInitial('  NewMax')).toBe('N')
  })

  /** ★ `name[0]` 会在这里切出半个代理对,渲染成 ▯ */
  it('emoji 开头时取完整的那一个字符,不是半个代理对', () => {
    expect(avatarInitial('🚀 Gateway')).toBe('🚀')
  })

  it('空名字有兜底,不返回空串', () => {
    expect(avatarInitial('')).toBe('?')
    expect(avatarInitial('   ')).toBe('?')
  })
})
