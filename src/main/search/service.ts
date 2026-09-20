/**
 * 按优先级依次调用,失败切下一家 —— 与 `UpstreamRouter` 同构,理由也同一条。
 *
 * ## 这个文件为什么有一个「装配槽」
 *
 * `web_search` 工具要拿 API Key,而工具拿到的宿主是
 * `ToolHost = Pick<KernelHost, 'fs'|'spawn'|'fetch'|'clock'|'logger'>` ——
 * 那里面**故意没有 `secrets`**(方案 §9:工具不该有能力读任何一个密钥)。
 * 所以 Key 不能从 `ctx.host` 来。
 *
 * 也不能在模块顶层闭包捕获 `getHost()`:`installHost()` 之后已注册的工具会
 * 攥着旧宿主,这正是 `registry.ts:39-48` 那段注释记下的坑。
 *
 * 于是:`runtime.ts` 装一个**访问器**进来,这里**每次调用现读**。
 * 换宿主、改配置、改 Key 都立刻生效,而工具自己一个密钥也拿不到 ——
 * 它只能说「帮我搜一下」,拿回结果。
 */
import type {
  SearchProviderId,
  SearchProviderStatus,
  SearchResult,
  SearchSourceId
} from '../../shared/domain/search'
import { BUILTIN_SOURCE_ID, searchChain, searchMeta } from '../../shared/domain/search'
import { ADAPTERS } from './adapters'
import { withUserAgent } from './adapters/http'
import { runBuiltinSearch } from './builtin'
import { withTimeout } from './timeout'
import type { AdapterDeps } from './types'

/** 一家最多等多久。全败的上限是这个数乘以链长,所以不能松。 */
const PER_PROVIDER_TIMEOUT_MS = 15_000

export interface SearchConfigSource {
  /** 当前的服务列表(含 hasKey),每次调用现读 */
  statuses(): Promise<SearchProviderStatus[]>
  /** 明文 Key。**只有这个模块调它**,工具那一侧永远拿不到 */
  apiKey(id: SearchProviderId): Promise<string | null>
  /**
   * 用户手填的自建 SearxNG 地址(`settings.builtinSearch.searxngUrl`),没填就是空串。
   *
   * 需求:免 Key 兜底要优先用用户自己那台实例。**每次调用现读** ——
   * 和上面两个同一条理由:用户刚在设置页改完,下一次搜索就该按新值来。
   */
  selfHostedSearxng(): string
}

let source: SearchConfigSource | null = null

/** 由 `runtime.ts` 在装宿主时调一次 */
export function installSearchConfig(src: SearchConfigSource): void {
  source = src
}

/** 测试用:把槽清空,免得上一个用例的假配置漏给下一个 */
export function resetSearchConfigForTest(): void {
  source = null
}

export interface SearchOutcome {
  results: SearchResult[]
  /** 最终是哪家给出的结果。没有结果时是 undefined;免 Key 兜底给出的是 `'builtin'` */
  provider?: SearchSourceId
  /**
   * 内置兜底用的那个源(实例域名或引擎名)。只有 `provider === 'builtin'` 时才有 ——
   * 「免费源」这三个字对用户没有信息量,「searx.be」才有。
   */
  sourceLabel?: string
  /**
   * 内置兜底里「有源正常应答、但它说没有结果」。见 `builtin/index.ts` 同名字段。
   * 付费链那边不设这个标记:那条链上零结果按「这家可能改字段名了」处理,理由见下面 runSearch 的注释。
   */
  reachedEmpty?: boolean
  /**
   * 一路上失败的家和原因,顺序即尝试顺序。
   * **即使最后成功了也带着** —— 「Tavily 401、退到了 Brave」这件事,
   * 用户只有在这里才看得到;成功就把它吞掉的话,那个坏掉的 Key 会一直坏下去。
   */
  failures: Array<{ id: SearchSourceId; message: string }>
}

function label(id: SearchProviderId): string {
  return searchMeta(id)?.name ?? id
}

/**
 * 给一家套上超时。
 *
 * ★ 超时**只中断这一家**,不动 `deps.signal` —— 那是整个 run 的中断信号,
 * abort 它等于把用户的整轮对话掐了。
 *
 * 实现现在住在 `./timeout.ts`:免 Key 兜底那条链路要用同一份,
 * 两份实现里迟早有一份会退化成直接 abort 外层 signal。
 */

/**
 * 搜一次。
 *
 * 切下一家的三个条件,和 `types.ts` 里那条分工对应:
 * 1. 适配器抛异常(网络错、非 2xx、响应不是 JSON)→ 切
 * 2. 返回空数组 → **也切**。这一条值得说明:「这家好好的但没搜到」在理论上
 *    该如实报告,可实际上零结果最常见的成因是这家的响应字段改了名
 *    (见 `harvest.ts` 文件头)。切一下的代价是一次多余的请求,
 *    不切的代价是「搜索坏了但看起来像没搜到」—— 后者要难查得多。
 * 3. 没配 Key / 这家标了 unavailable / 没有适配器 → 根本不进链(`searchChain` 已滤)
 *
 * ## 付费链没出结果时会退到免 Key 的内置源
 *
 * 需求:一个服务都没配的用户(以及 Key 过期、额度用完的用户)也该能搜到东西,
 * 而不是收到一句「去配 Key」就没了下文。内置源在 `builtin/` 下,不需要任何 Key。
 *
 * ★ 退到内置源时,付费链的 `failures` **一并带回去**。丢掉它的话,
 * 用户那个填错的 Key 会永远错下去,而表面上「搜索还能用」—— 这和上面
 * `failures` 注释记的是同一条理由。
 */
export async function runSearch(
  query: string,
  count: number,
  deps: Pick<AdapterDeps, 'fetch'> & { signal: AbortSignal }
): Promise<SearchOutcome> {
  if (source === null) {
    throw new Error('搜索服务还没有装配 —— 这是接线错误,不是配置问题。')
  }
  const chain = searchChain(await source.statuses())
  const failures: SearchOutcome['failures'] = []

  for (const status of chain) {
    const id = status.config.id
    const adapter = ADAPTERS[id]
    if (adapter === undefined) continue

    const key = await source.apiKey(id)
    if (key === null || key === '') {
      // hasKey 说有、现取却没有 —— 库和密钥环不一致,如实记一笔再往下走
      failures.push({ id, message: `${label(id)} 的 API Key 读不出来,可能是本机加密数据已损坏。` })
      continue
    }

    try {
      const results = await withTimeout(deps.signal, PER_PROVIDER_TIMEOUT_MS, (signal) =>
        adapter({ query, count }, key, { fetch: withUserAgent(deps.fetch), signal })
      )
      if (results.length > 0) return { results: results.slice(0, count), provider: id, failures }
      failures.push({ id, message: `${label(id)} 没有返回任何结果。` })
    } catch (err) {
      /*
        ★ 整个 run 被中断时**立刻停手往上抛**,不要接着试下一家。
        不判这一条的话,用户按了停止,搜索链还会把剩下五家挨个跑一遍。
      */
      if (deps.signal.aborted) throw err
      failures.push({
        id,
        message: `${label(id)}:${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  return runFallback(query, count, failures, deps)
}

/**
 * 付费链没给出结果时走这里。
 *
 * ★ 它**不抛**(除了用户中断):内置源全挂也只是多几条 failures。
 * 抛的话,`web_search` 那三种分得很细的失败文案就全变成一句异常,
 * 而那三种情况里模型该做的事完全不同(换查询词 / 去配 Key / 告诉用户网络不通)。
 */
async function runFallback(
  query: string,
  count: number,
  failures: SearchOutcome['failures'],
  deps: Pick<AdapterDeps, 'fetch'> & { signal: AbortSignal }
): Promise<SearchOutcome> {
  const selfHosted = source === null ? '' : source.selfHostedSearxng()
  const builtin = await runBuiltinSearch(query, count, {
    fetch: deps.fetch,
    signal: deps.signal,
    selfHostedSearxng: selfHosted
  })
  const all = [
    ...failures,
    ...builtin.failures.map((message) => ({ id: BUILTIN_SOURCE_ID, message }))
  ]
  if (builtin.results.length === 0) {
    return { results: [], reachedEmpty: builtin.reachedEmpty, failures: all }
  }
  return {
    results: builtin.results,
    provider: BUILTIN_SOURCE_ID,
    ...(builtin.sourceLabel === undefined ? {} : { sourceLabel: builtin.sourceLabel }),
    failures: all
  }
}

/**
 * 设置页那个「测试」按钮。**只回通不通,不回结果** ——
 * 回结果的话这条 IPC 频道就成了一个绕过工具链、绕过联网开关的搜索入口。
 */
export async function testProvider(
  id: SearchProviderId,
  deps: Pick<AdapterDeps, 'fetch'> & { signal: AbortSignal },
  now: () => number
): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
  if (source === null) return { ok: false, message: '搜索服务还没有装配。' }

  const meta = searchMeta(id)
  if (meta?.unavailable !== undefined) return { ok: false, message: meta.unavailable }

  const adapter = ADAPTERS[id]
  if (adapter === undefined) return { ok: false, message: `${label(id)} 没有可用的适配器。` }

  const key = await source.apiKey(id)
  if (key === null || key === '') return { ok: false, message: '还没有填 API Key。' }

  const started = now()
  try {
    // 只要 1 条:这是连通性测试,不是搜索,没必要为它花一次完整额度
    const results = await withTimeout(deps.signal, PER_PROVIDER_TIMEOUT_MS, (signal) =>
      adapter({ query: 'hello', count: 1 }, key, { fetch: withUserAgent(deps.fetch), signal })
    )
    const latencyMs = now() - started
    return results.length > 0
      ? { ok: true, latencyMs }
      : {
          ok: true,
          latencyMs,
          // 通了但没结果:Key 是好的,值得说清楚,免得用户以为测试失败了
          message: '连接正常,但这次查询没有返回结果。'
        }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 设置页底部「内置搜索」那一小节的测试按钮。
 *
 * 和 `testProvider` 同一条立场:**只回通不通和用了哪个源,不回结果** ——
 * 回结果的话这条频道就成了一个绕过工具链、绕过联网开关的搜索入口。
 *
 * ★ 不补正文(`enrich: false`)。用户按这个按钮是想知道「这条链路通不通」,
 * 补正文只会让它多转最多 6 秒。
 */
export async function testBuiltin(
  deps: Pick<AdapterDeps, 'fetch'> & { signal: AbortSignal },
  now: () => number
): Promise<{ ok: boolean; latencyMs?: number; source?: string; message?: string }> {
  const started = now()
  try {
    const outcome = await runBuiltinSearch('hello', 1, {
      fetch: deps.fetch,
      signal: deps.signal,
      selfHostedSearxng: source === null ? '' : source.selfHostedSearxng(),
      enrich: false
    })
    const latencyMs = now() - started
    if (outcome.results.length === 0) {
      // 全挂时把每一层的原话给出去 —— 「不可用」三个字不能告诉用户该改什么
      return { ok: false, latencyMs, message: outcome.failures.join(' / ') }
    }
    return {
      ok: true,
      latencyMs,
      ...(outcome.sourceLabel === undefined ? {} : { source: outcome.sourceLabel })
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
