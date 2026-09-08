/**
 * 「自定义供应商」——预设表之外的那一条路。
 *
 * 预设目录有 42 家,但它是一张**快照**:自建中转、公司内网的私有部署、
 * 昨天刚上线的新网关,一家都不在里面。没有这条路的话,这些用户在设置页
 * 走到头就是一句「没有匹配的供应商」——而他手上明明有地址和 key。
 *
 * 和 `provider-catalog.ts` / `provider-edit.ts` 同一个理由待在 `.ts` 里:
 * `vitest.config.ts` 是 node 环境、`include` 只收 `.ts`,判断逻辑留在 `.tsx`
 * 里就等于没有测试。下面三条都是会静默错的那种。
 */
import { normalizeBaseUrl } from '../../../../../shared/domain/baseurl'
import { findPreset } from '../../../../../shared/domain/presets'
import type { UpstreamProtocol, UpstreamProvider } from '../../../../../shared/domain/provider'
import { PRESET_PRIORITY } from './provider-edit'

/**
 * ★★ **id 必须带这个前缀,不是为了好看。**
 *
 * `baseUrlForProtocol` 和 `presetHasProtocol` 都用 `findPreset(provider.id)`
 * 找回端点表。自定义供应商如果碰巧取到了 `openai` 这种 id,用户翻一下
 * 「API 格式」开关,他自己填的地址就会被**换成 OpenAI 的预设地址** ——
 * 表单看着完全正常,请求打到了另一家。前缀让 `findPreset` 必然返回 null,
 * 于是 `provider-edit.ts` 里那条「认不出的一律保留原地址」兜住它。
 *
 * (`presets.test.ts` 那边守着「没有预设 id 以此开头」,两头都钉住。)
 */
export const CUSTOM_PROVIDER_PREFIX = 'custom-'

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX)
}

/**
 * 名字 → id。
 *
 * ★ **中文名不会产生空 id。** 转写只保留 ASCII 字母数字,而这个产品的用户
 * 十有八九会把它叫「公司内网中转」——全被过滤掉之后剩下空串,拼出来就是
 * 一个光秃秃的 `custom-`,第二家再建又是同一个 id,于是 `upsertProvider`
 * 按 id 覆盖,**第一家被第二家静默顶掉**。所以空串兜到 `provider`。
 *
 * ★ 斜杠在这里已经被字符白名单挡掉了,但主进程仍然会再拒一次
 * (`modelSelectionKey` 的复合键靠第一个斜杠解析)—— 两道是故意的。
 */
export function customProviderId(name: string, existingIds: readonly string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider'
  const base = `${CUSTOM_PROVIDER_PREFIX}${slug}`
  const taken = new Set(existingIds)
  if (!taken.has(base) && findPreset(base) === null) return base
  // 重名不报错,顺延 —— 用户建两家「中转」是完全正常的,而报错会把他卡在这里
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`
    if (!taken.has(candidate) && findPreset(candidate) === null) return candidate
  }
}

/**
 * 表单的拦截项。**只拦真的过不去的**,形状可疑交给 `baseUrlWarnings` 提示。
 *
 * 那条界线是这样划的:名字空 / 地址空 / 地址根本不是个 URL —— 存进去必然
 * 是一条永远请求不出去的记录;而「Anthropic 地址带了 /v1」「OpenAI 地址
 * 少了版本段」这类**十有八九不对但可能对**的,拦下来就是拿一张我们实测的
 * 快照否决用户手里的真实部署。同 `baseUrlWarnings` 文件头那句:
 * 返回警告不是拒绝。
 */
export type CustomProviderIssue = 'name-required' | 'url-required' | 'url-invalid'

export function validateCustomProvider(input: {
  name: string
  baseUrl: string
}): CustomProviderIssue | null {
  if (input.name.trim() === '') return 'name-required'
  const normalized = normalizeBaseUrl(input.baseUrl)
  if (normalized === '') return 'url-required'
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return 'url-invalid'
  }
  /*
    ★ 只放行 http/https,和主进程那边一致。挡的不是笔误而是 `file:` /
    `data:` 这类被 `new URL` 收下的东西 —— 它们能存进去,却在发请求时
    才炸,而那时错误信息里已经没有「地址协议不对」这条线索了。
  */
  return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'url-invalid'
}

/**
 * 表单 → 一条真的供应商记录。
 *
 * ★ 地址在这里就跑一遍 `normalizeBaseUrl`(主进程还会再跑一遍,幂等):
 * 用户十有八九粘的是整条请求地址,不在这里整理的话,他建完在右侧看到的
 * 地址和自己粘的不一样,那种不一致比不整理更难查。
 *
 * ★ **不填密钥**,`credentialRef` 给占位:主进程一律不采信渲染层传来的
 * 这个值,它自己派生 `provider:<id>`(同 `providerFromPreset`)。
 */
export function customProviderDraft(
  input: { name: string; baseUrl: string; protocol: UpstreamProtocol; subscription?: boolean },
  existingIds: readonly string[]
): UpstreamProvider {
  const name = input.name.trim()
  const id = customProviderId(name, existingIds)
  return {
    id,
    name,
    protocol: input.protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    credentialRef: `provider:${id}`,
    priority: PRESET_PRIORITY,
    enabled: true,
    // ★ 和 `providerFromPreset` 同一条规矩:false 不落键,库里干净些
    ...(input.subscription === true ? { subscription: true } : {})
  }
}
