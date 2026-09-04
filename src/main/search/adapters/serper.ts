/**
 * Serper —— POST https://google.serper.dev/search
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`X-API-KEY: <key>`
 * - 请求体:`{ q, num, gl, hl }`
 * - 响应:`{ organic: [{ title, link, snippet, date? }] }`,另有
 *   `knowledgeGraph` / `answerBox` / `news` 等并排的块
 *
 * ★ 只取 `organic`。`answerBox` 那类块是 Google 自己抽出来的答案 ——
 * 把它混进结果列表,模型会把「Google 说的」当成一个有出处的网页来引用,
 * 而它没有一个能核实的 url。
 */
import type { SearchAdapter } from '../types'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { JSON_HEADERS, jsonOrThrow } from './http'

export const serper: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    signal,
    headers: { ...JSON_HEADERS, 'x-api-key': apiKey },
    body: JSON.stringify({ q: query, num: count })
  })
  const json = await jsonOrThrow(res, 'Serper')
  // 文档里两个名字都出现过(`organic` / `organic_results`),两个都试
  const rows = [...arrayAt(json, ['organic']), ...arrayAt(json, ['organic_results'])]
  return harvestAll(rows.length > 0 ? rows : findResultArray(json)).map((h) => ({
    ...h,
    provider: 'serper' as const
  }))
}
