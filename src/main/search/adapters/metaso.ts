/**
 * 秘塔搜索 —— POST https://metaso.cn/api/open/search/v2
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`Authorization: Bearer <key>`,`Content-Type: application/json`
 * - 请求体:`{ question, lang, stream }`(`question` 而不是 `q` / `query`)
 *
 * ★ **这一家的响应字段没有公开文档**,只有请求侧是核对过的。
 * 于是它是六家里唯一**完全**靠 `findResultArray` 兜底的:按「哪个数组的元素
 * 长得像结果」去找,而不是猜一个字段名写死。
 *
 * 这是一个有意识的取舍,写在这里免得下一个人以为是偷懒:猜错字段名的症状是
 * HTTP 200 + 零结果 —— 看起来像「没搜到」,于是切换链会静静地跳过这一家,
 * 谁也不会发现它其实一直是坏的。按形状找至少在响应结构变化时仍然能工作。
 *
 * 另:文档提到专题检索需要 `searchTopicId`。我们发的是全网检索,不带这个参数;
 * 若这家将来把它变成必填,失败会以「HTTP 4xx + 服务器的原话」出现在切换链的
 * 聚合错误里,而不是变成一次静默的零结果。
 */
import type { SearchAdapter } from '../types'
import { findResultArray, harvestAll } from '../harvest'
import { JSON_HEADERS, jsonOrThrow } from './http'

export const metaso: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const res = await fetch('https://metaso.cn/api/open/search/v2', {
    method: 'POST',
    signal,
    headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ question: query, lang: 'zh', stream: false })
  })
  const json = await jsonOrThrow(res, '秘塔搜索')
  return harvestAll(findResultArray(json))
    .slice(0, count)
    .map((h) => ({ ...h, provider: 'metaso' as const }))
}
