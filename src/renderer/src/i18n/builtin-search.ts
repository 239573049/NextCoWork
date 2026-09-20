/**
 * 「设置 › 连接 › 搜索」底部那一小节(免 Key 的内置搜索)的文案。
 *
 * 单独一个文件,照 `git.ts` / `ssh.ts` 的先例 —— 不往 `index.tsx` 那几千行里堆。
 *
 * ★ 这里的措辞是**对用户的唯一一次告知**:这条链路刻意不弹窗(弹窗会打断一次
 * 本该无感的兜底),所以「查询词会发给公共实例」「质量低于专业服务」这两件事
 * 必须在这一小节里说清楚。删减这两句等于把告知去掉了。
 *
 * ★ 实例域名、引擎名(searx.be / Bing / 百度)**不翻译**,它们是领域值(AGENTS §6.5)。
 */

/**
 * 带参数的文案那一个入参类型。必须显式标 —— 理由见 `git.ts` 里同名的这段:
 * 不标的话参数被推断成 implicit any,spread 进总表时整张表不再匹配 `Messages`。
 */
type Params = Record<string, string | number>

export const builtinSearchZh = {
  'connection.builtinSearch.title': '内置搜索(无需 API Key)',
  'connection.builtinSearch.hint':
    '上面一家都没配置、或者它们全部失败时,会自动用内置的免费搜索源兜底:先试公共 SearxNG 实例,不行再直接读取 Bing、DuckDuckGo、百度的结果页。搜索词会发送给这些站点;结果的质量和时效低于你自己配置的专业搜索服务。',
  'connection.builtinSearch.instanceLabel': '自建 SearxNG 实例',
  'connection.builtinSearch.instanceHint':
    '填了就优先用你自己的实例,留空则只用内置的公共实例。本机地址(如 http://localhost:8080)可以直接填。',
  'connection.builtinSearch.placeholder': 'http://localhost:8080',
  'connection.builtinSearch.test': '测试',
  'connection.builtinSearch.testing': '正在搜索…',
  'connection.builtinSearch.ok': ({ source, latency }: Params) => `可用 · 来源 ${source} · ${latency}ms`,
  'connection.builtinSearch.failed': ({ reason }: Params) => `没搜到:${reason}`,
  'connection.builtinSearch.unknownError': '内置搜索这次没有可用的源。'
}

export const builtinSearchEn = {
  'connection.builtinSearch.title': 'Built-in search (no API key)',
  'connection.builtinSearch.hint':
    'When nothing above is configured — or every provider fails — a built-in free source takes over: public SearxNG instances first, then the result pages of Bing, DuckDuckGo and Baidu. Your query is sent to those sites, and the results are less accurate and less fresh than a search provider you configure yourself.',
  'connection.builtinSearch.instanceLabel': 'Your own SearxNG instance',
  'connection.builtinSearch.instanceHint':
    'Filled in, it is tried before the public instances; left empty, only the public ones are used. A local address such as http://localhost:8080 is accepted.',
  'connection.builtinSearch.placeholder': 'http://localhost:8080',
  'connection.builtinSearch.test': 'Test',
  'connection.builtinSearch.testing': 'Searching…',
  'connection.builtinSearch.ok': ({ source, latency }: Params) => `Working · via ${source} · ${latency}ms`,
  'connection.builtinSearch.failed': ({ reason }: Params) => `No results: ${reason}`,
  'connection.builtinSearch.unknownError': 'No built-in source could be used this time.'
}
