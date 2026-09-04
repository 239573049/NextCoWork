/**
 * 六个适配器共用的那点 HTTP 收尾。
 *
 * ★ 非 2xx **抛**,而不是返回空 —— `types.ts` 里那条「失败抛、空结果返回空」
 * 的分工是整条故障切换链的地基:401 该切下一家,零结果不该。
 *
 * 错误信息里带上状态码和响应正文的开头。切换链全败时这些话会拼在一起交给模型,
 * 而「Tavily: 401 Unauthorized」比「搜索失败」有用得多 —— 用户据此知道该去改哪个 Key。
 */

/** 响应正文里截多长进错误信息。够看清 `{"error":"invalid api key"}`,又不至于把一整页 HTML 倒进去 */
const ERROR_BODY_CHARS = 300

export async function jsonOrThrow(res: Response, who: string): Promise<unknown> {
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, ERROR_BODY_CHARS).trim()
    } catch {
      // 正文读不出来不影响我们已经知道的状态码
    }
    throw new Error(
      `${who} 返回 HTTP ${String(res.status)}${res.statusText === '' ? '' : ` ${res.statusText}`}` +
        (detail === '' ? '' : `:${detail}`)
    )
  }
  try {
    return await res.json()
  } catch {
    throw new Error(`${who} 返回的不是合法 JSON。`)
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json' } as const
