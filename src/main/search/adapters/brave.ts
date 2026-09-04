/**
 * Brave Search —— GET https://api.search.brave.com/res/v1/web/search
 *
 * 核对到的形状(2026-09):
 * - 鉴权:`X-Subscription-Token: <key>`,并且**必须**带 `Accept: application/json`
 * - 查询串:`q`、`count`
 * - 响应:`{ web: { results: [{ title, url, description, page_age? }] } }`
 *
 * ★ 结果数组在 `web.results` 下,不是顶层 `results` —— 顶层还并排放着
 * `news` / `videos` / `faq` 几个块。取错一层的症状是零结果而非报错。
 */
import type { SearchAdapter } from '../types'
import { arrayAt, findResultArray, harvestAll } from '../harvest'
import { jsonOrThrow } from './http'

export const brave: SearchAdapter = async ({ query, count }, apiKey, { fetch, signal }) => {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const res = await fetch(url, {
    signal,
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': apiKey
    }
  })
  const json = await jsonOrThrow(res, 'Brave Search')
  const rows = arrayAt(json, ['web', 'results'])
  return harvestAll(rows.length > 0 ? rows : findResultArray(json)).map((h) => ({
    ...h,
    provider: 'brave' as const
  }))
}
