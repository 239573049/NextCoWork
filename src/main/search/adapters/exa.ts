/**
 * Exa —— POST https://api.exa.ai/search
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`x-api-key: <key>`(官方也接受 `Authorization: Bearer`)
 * - 请求体:`{ query, numResults, contents: { text: true } }`
 * - 响应:`{ results: [{ title, url, publishedDate?, text? }] }`
 *
 * ★ `contents: { text: true }` 不能省。省了的话返回里只有标题和链接,
 * 模型拿到一串 URL 却不知道里面写了什么,只能对每一条再调一次 WebFetch ——
 * 一次搜索变成十次抓取。
 */
import type { SearchAdapter } from '../types'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { JSON_HEADERS, jsonOrThrow } from './http'

/** 单条正文截多长。Exa 给的是整页正文,原样堆十条能占掉半个上下文窗口。 */
const TEXT_CHARS = 1200

export const exa: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    signal,
    headers: { ...JSON_HEADERS, 'x-api-key': apiKey },
    body: JSON.stringify({
      query,
      numResults: count,
      contents: { text: { maxCharacters: TEXT_CHARS } }
    })
  })
  const json = await jsonOrThrow(res, 'Exa')
  const rows = arrayAt(json, ['results'])
  return harvestAll(rows.length > 0 ? rows : findResultArray(json)).map((h) => ({
    ...h,
    snippet: h.snippet.slice(0, TEXT_CHARS),
    provider: 'exa' as const
  }))
}
