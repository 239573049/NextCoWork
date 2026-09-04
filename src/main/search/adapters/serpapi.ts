/**
 * SerpApi —— GET https://serpapi.com/search.json
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`api_key` 走**查询串**,这家没有请求头方案
 * - 查询串:`engine=google`、`q`、`num`、`api_key`
 * - 响应:`{ organic_results: [{ title, link, snippet, date? }] }`
 *
 * ★ Key 进 URL 是这家的接口决定的,不是我们的选择。带来一个具体后果:
 * 出错时**不能把 URL 拼进错误信息**,否则 Key 会跟着日志和界面上的错误提示走。
 * 下面只把服务商名字交给 `jsonOrThrow`,URL 一个字都不给它。
 */
import type { SearchAdapter } from '../types'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { jsonOrThrow } from './http'

export const serpapi: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google')
  url.searchParams.set('q', query)
  url.searchParams.set('num', String(count))
  url.searchParams.set('api_key', apiKey)

  const res = await fetch(url, { signal, headers: { accept: 'application/json' } })
  const json = await jsonOrThrow(res, 'SerpApi')
  const rows = arrayAt(json, ['organic_results'])
  return harvestAll(rows.length > 0 ? rows : findResultArray(json)).map((h) => ({
    ...h,
    provider: 'serpapi' as const
  }))
}
