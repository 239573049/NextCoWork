/**
 * 「内置供应商预设」目录的判断逻辑。
 *
 * 和 `pricing-table.ts` 同一个理由待在 `.ts` 里:`vitest.config.ts` 是 node 环境、
 * 只匹配 `.test.ts`,`.tsx` 落不进去也没有 jsdom ——
 * 判断逻辑留在组件里就等于**没有测试**,而下面这几条恰恰是会静默错的那种。
 */
import { previewUrl } from '../../../../../shared/domain/baseurl'
import {
  PROVIDER_PRESETS,
  presetsByCategory,
  recommendedPresets,
  type PresetCategory,
  type ProviderEndpoint,
  type ProviderPreset
} from '../../../../../shared/domain/presets'
import { PROTOCOL_LABEL, type UpstreamProtocol } from '../../../../../shared/domain/provider'

/**
 * 参考图那五个 Tab。
 *
 * ★ **「推荐服务」是一个跨类别的视图,不是第五个类别** —— `presets.ts` 里
 * `PresetCategory` 只有四个值,推荐是一个布尔标记。这个区分不是洁癖:
 * 把推荐做成第五个类别,OpenAI 就会因为「进了推荐」而从「海外平台」里**消失**,
 * 用户翻海外平台那一栏找不到 OpenAI。所以推荐这一栏是**重复展示**,
 * 底下四栏才是对 42 条的一次完整划分。测试两头都钉住。
 */
export type CatalogTab = 'recommended' | PresetCategory

export const CATALOG_TABS: readonly { id: CatalogTab; label: string }[] = [
  { id: 'recommended', label: '推荐服务' },
  { id: 'domestic', label: '国内服务' },
  { id: 'aggregator', label: '聚合平台' },
  { id: 'overseas', label: '海外平台' },
  { id: 'local', label: '本地模型' }
]

export function presetsForTab(tab: CatalogTab): ProviderPreset[] {
  return tab === 'recommended' ? recommendedPresets() : presetsByCategory(tab)
}

/** Tab 上的条数。哪一栏有货直接写在标签上,省得用户一栏栏点过去找 */
export function tabCount(tab: CatalogTab): number {
  return presetsForTab(tab).length
}

/**
 * 能不能拉模型列表 —— **三态,不是布尔**。
 *
 * ★ `supportsModelList: false` 在 `presets.ts` 里同时表示「确认没有」和
 * **「没拿到证据」**(智谱 / Z.AI / 火山这几家的探针被 catch-all 401 废掉了)。
 * 那个字段唯一的原始用途是一个按钮的可点性,合并两种含义没问题;
 * 可**界面上写「不支持」就是把「我们不知道」说成了一句事实断言**。
 * 所以第三态叫 `unknown`,措辞也跟着改成「未核实」。
 */
export type ListAccess = 'public' | 'key' | 'unknown'

export function listAccess(e: ProviderEndpoint): ListAccess {
  if (e.modelListPublic === true) return 'public'
  if (e.supportsModelList) return 'key'
  return 'unknown'
}

export const LIST_ACCESS_LABEL: Readonly<Record<ListAccess, string>> = {
  public: '免鉴权可拉列表',
  key: '填 key 后可拉列表',
  unknown: '拉列表未核实'
}

export const VERIFICATION_LABEL: Readonly<Record<ProviderPreset['verification'], string>> = {
  probed: '探针实测',
  documented: '文档提取',
  unverified: '未核实'
}

export interface EndpointRow {
  protocol: UpstreamProtocol
  label: string
  baseUrl: string
  /**
   * ★ **真正会打出去的地址,不是 baseUrl。** 卡片上必须显示这一条:
   * OpenAI 族的版本段在 base 里(`/v1`、`/api/paas/v4`),Anthropic 族**不带**
   * (客户端自己补 `/v1/messages`)—— 两族约定是反的。只显示 base 的话,
   * 「同一家两个协议地址不一样」看着像是数据录错了;显示最终 URL 才看得出两边都对。
   */
  requestUrl: string
  list: ListAccess
}

export function endpointRows(p: ProviderPreset): EndpointRow[] {
  return p.endpoints.map((e) => ({
    protocol: e.protocol,
    label: PROTOCOL_LABEL[e.protocol],
    baseUrl: e.baseUrl,
    requestUrl: previewUrl(e.baseUrl, e.protocol),
    list: listAccess(e)
  }))
}

/**
 * 同一家的几个协议是不是用了**不同的 baseUrl**。
 *
 * 这是整张预设表存在的理由(`presets.ts` 文件头那张前缀对照表):扁平结构下
 * 用户翻一下「API 格式」开关,地址就静默失效 —— 表单看着完全正常,请求 404。
 * 卡片上给这些家标一句,是把那张对照表摆到用户眼前。
 */
export function hasDivergentBaseUrls(p: ProviderPreset): boolean {
  return new Set(p.endpoints.map((e) => e.baseUrl)).size > 1
}

/** 全表里有多少家会随协议换地址。头部那句话要用真数,不写「不少」 */
export function divergentCount(): number {
  return PROVIDER_PRESETS.filter(hasDivergentBaseUrls).length
}

/**
 * 搜索。和 `matchPricing` 一样**空查询返回全部**(而不是像 `nav.ts` 的
 * `matchRows` 那样返回空)—— 那边空查询意味着「没在搜索,显示正常页面」,
 * 这里的列表本身就是内容,清空搜索框得回到完整目录。
 *
 * 地址也进匹配:用户手上往往只有一个域名(「api.moonshot.cn 是哪家来着」)。
 */
export function matchPresets(list: readonly ProviderPreset[], query: string): ProviderPreset[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...list]
  return list.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true
    if (p.id.toLowerCase().includes(q)) return true
    if (p.suggestedModels.some((m) => m.toLowerCase().includes(q))) return true
    return p.endpoints.some((e) => e.baseUrl.toLowerCase().includes(q))
  })
}
