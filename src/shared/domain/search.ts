/**
 * 搜索服务 —— 界面「设置 › 连接 › 搜索服务」,以及内置 `web_search` 工具的数据源。
 *
 * ## 为什么是「一张目录表 + 一份用户配置」两个类型
 *
 * 目录表(`SEARCH_CATALOG`)是**编译进包里的常量**:名字、说明、去哪儿领 Key、
 * 以及**这家现在还能不能用**。用户配置只有三个字段(启用、优先级、有没有 Key),
 * 因为其余的都不该让用户填 —— 端点写死在适配器里,填错了只会得到一个 404。
 *
 * ## priority 的语义
 *
 * 升序 = 先用。`web_search` 按这个顺序依次调用,某家失败(网络错 / 非 2xx /
 * 零结果)就切下一家 —— 与 `UpstreamProvider.priority` 完全同构,理由也同一条,
 * 所以它在 `db/schema.ts` 里同样是**真列**而不是 JSON 里的一个字段。
 *
 * ## `unavailable` 不是「还没做」
 *
 * 填了这个字段的家**这一刻在世界上就用不了**,和本仓库的进度无关:Bing 的搜索
 * API 已经被微软下线,豆包压根没有可供排序的独立搜索接口。界面上原样显示这句话
 * 并禁掉开关 —— 比留一个点了就报错的开关诚实,也比悄悄从列表里删掉诚实
 * (用户在参考产品里见过这两家,找不到会以为是我们漏了)。
 */

export type SearchProviderId =
  | 'tavily'
  | 'exa'
  | 'brave'
  | 'serper'
  | 'serpapi'
  | 'metaso'
  | 'doubao'
  | 'bing'

export interface SearchProviderMeta {
  id: SearchProviderId
  name: string
  /** 列表行的副标题,一句话 */
  description: string
  /** 「获取 Key」那个链接的落点 —— 走 app:openExternal,不在应用内开网页 */
  keyUrl: string
  /**
   * 填了 = 这家现在用不了,原因就是这句话。界面照实显示并禁用开关,
   * 适配器也不会为它存在。见文件头。
   */
  unavailable?: string
}

/**
 * ★ 顺序 = 界面上的默认排列,也是首次写库时的初始 priority。
 * 前五家的请求/响应字段都是从官方 OpenAPI 或官方文档核对过的,
 * 每个适配器文件头记着核对到的那一版长什么样。
 */
export const SEARCH_CATALOG: readonly SearchProviderMeta[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    description: '为大模型优化的搜索,直接返回摘好的正文片段,推荐首选',
    keyUrl: 'https://app.tavily.com/home'
  },
  {
    id: 'exa',
    name: 'Exa',
    description: '语义检索,适合「找一类东西」而不是「找一个关键词」',
    keyUrl: 'https://dashboard.exa.ai/api-keys'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: '独立索引,不转发给第三方搜索引擎,有免费额度',
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys'
  },
  {
    id: 'serper',
    name: 'Serper',
    description: 'Google 结果的轻量代理,便宜、快,返回原始 SERP',
    keyUrl: 'https://serper.dev/api-key'
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    description: 'Google 结果的结构化代理,字段最全,单价偏高',
    keyUrl: 'https://serpapi.com/manage-api-key'
  },
  {
    id: 'metaso',
    name: '秘塔搜索',
    description: '中文内容覆盖好,学术与长文检索强',
    keyUrl: 'https://metaso.cn/search-api/playground'
  },
  {
    id: 'doubao',
    name: '豆包搜索',
    description: '火山方舟的联网能力',
    keyUrl: 'https://console.volcengine.com/ark',
    unavailable:
      '火山方舟没有独立的搜索接口 —— 联网只能作为 Responses API 里的内置工具随模型一起调用,' +
      '拿回来的是模型答案而不是可排序、可切换的结果列表,接不进这里的优先级链路。'
  },
  {
    id: 'bing',
    name: 'Bing Search',
    description: '微软必应网页搜索',
    keyUrl: 'https://learn.microsoft.com/lifecycle/announcements/bing-search-api-retirement',
    unavailable:
      'Bing 搜索 API 已于 2025-08-11 被微软下线,存量实例一并停用、不再接受新用户。' +
      '官方给的替代品是 Azure AI Agent 里的 Grounding with Bing Search,那是另一套东西。'
  }
]

export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = SEARCH_CATALOG.map((m) => m.id)

const META_BY_ID = new Map<SearchProviderId, SearchProviderMeta>(
  SEARCH_CATALOG.map((m) => [m.id, m])
)

/**
 * API Key 在 `credentials` 表里的 ref。和 `mcpSecretRef` 同款,前缀不同 ——
 * 前缀就是这两套密钥不会互相看见的全部保证,所以它必须是字面量,
 * 不能由调用方拼(拼的话某天会有人传进来一个 `mcp:` 开头的 id)。
 */
export function searchSecretRef(id: SearchProviderId): string {
  return `websearch:${id}`
}

export function searchMeta(id: SearchProviderId): SearchProviderMeta | undefined {
  return META_BY_ID.get(id)
}

export function isUsableProvider(id: SearchProviderId): boolean {
  return META_BY_ID.get(id)?.unavailable === undefined
}

/** 用户能改的全部 —— 端点不在里面,见文件头 */
export interface SearchProviderConfig {
  id: SearchProviderId
  enabled: boolean
  /** 升序 = 先用 */
  priority: number
}

/** 列表行要的一切。`hasKey` / `last4` 由主进程从 safeStorage 算出来,明文永不过 IPC */
export interface SearchProviderStatus {
  config: SearchProviderConfig
  hasKey: boolean
  last4?: string
}

export interface SearchResult {
  title: string
  url: string
  /** 摘要片段。各家字段名不一样(content / description / snippet / text),适配器统一到这里 */
  snippet: string
  /** 哪家给的 —— 结果里要标出来,不然模型无从判断可信度 */
  provider: SearchProviderId
  /** ISO 8601,拿不到就没有 */
  publishedAt?: string
}

/** 首次启动时写库的那一份:全部关闭,顺序即目录顺序 */
export function defaultProviderConfigs(): SearchProviderConfig[] {
  return SEARCH_CATALOG.map((m, i) => ({ id: m.id, enabled: false, priority: i }))
}

/**
 * 拖拽排序后重排。**返回的 priority 一定是 0..n-1 连续的**,
 * 因为界面显示的是「第几位」而不是 priority 本身 —— 留出空洞的话,
 * 删掉中间一家再拖一次,序号会跳。
 *
 * `from` / `to` 越界时原样返回,不抛 —— 调用方是拖拽事件,
 * 一次抖动不该让整张列表炸掉。
 */
export function reorderProviders(
  list: readonly SearchProviderConfig[],
  from: number,
  to: number
): SearchProviderConfig[] {
  const n = list.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) {
    return list.map((c, i) => ({ ...c, priority: i }))
  }
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next.map((c, i) => ({ ...c, priority: i }))
}

/**
 * `web_search` 的调用顺序:已启用、这家还能用、且**确实配了 Key**。
 *
 * ★ 第三个条件不能省。少了它,一个开着但没填 Key 的服务会在每次搜索时
 * 白跑一趟 HTTP 才失败 —— 用户看到的是「搜索变慢了」,而不是「我忘了填 Key」。
 */
export function searchChain(
  statuses: readonly SearchProviderStatus[]
): SearchProviderStatus[] {
  return statuses
    .filter((s) => s.config.enabled && s.hasKey && isUsableProvider(s.config.id))
    .sort((a, b) => a.config.priority - b.config.priority)
}
