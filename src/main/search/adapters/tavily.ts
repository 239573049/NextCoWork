/**
 * Tavily —— POST https://api.tavily.com/search
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`Authorization: Bearer <key>`
 * - 请求体:`{ query, max_results, search_depth }`
 * - 响应:`{ results: [{ title, url, content, score, published_date? }] }`
 *
 * `content` 是 Tavily 替我们摘好的正文片段,不是 SERP 那种一行摘要 ——
 * 这正是它在目录表里排第一的理由:同样一次调用,交给模型的信息量高一截。
 */
import type { SearchAdapter } from '../types'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { JSON_HEADERS, jsonOrThrow } from './http'

export const tavily: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: count,
      // basic 就够:advanced 贵一个量级,而多出来的那部分对「先看看有什么」帮助有限
      search_depth: 'basic'
    })
  })
  const json = await jsonOrThrow(res, 'Tavily')
  const rows = arrayAt(json, ['results'])
  return harvestAll(rows.length > 0 ? rows : findResultArray(json)).map((h) => ({
    ...h,
    provider: 'tavily' as const
  }))
}
