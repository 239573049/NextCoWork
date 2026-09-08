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
  SearchResult
} from '../../shared/domain/search'
import { searchChain, searchMeta } from '../../shared/domain/search'
import { ADAPTERS } from './adapters'
import { withUserAgent } from './adapters/http'
import type { AdapterDeps } from './types'

/** 一家最多等多久。全败的上限是这个数乘以链长,所以不能松。 */
const PER_PROVIDER_TIMEOUT_MS = 15_000

export interface SearchConfigSource {
  /** 当前的服务列表(含 hasKey),每次调用现读 */
  statuses(): Promise<SearchProviderStatus[]>
  /** 明文 Key。**只有这个模块调它**,工具那一侧永远拿不到 */
  apiKey(id: SearchProviderId): Promise<string | null>
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
  /** 最终是哪家给出的结果。没有结果时是 undefined */
  provider?: SearchProviderId
  /**
   * 一路上失败的家和原因,顺序即尝试顺序。
   * **即使最后成功了也带着** —— 「Tavily 401、退到了 Brave」这件事,
   * 用户只有在这里才看得到;成功就把它吞掉的话,那个坏掉的 Key 会一直坏下去。
   */
  failures: Array<{ id: SearchProviderId; message: string }>
}

function label(id: SearchProviderId): string {
  return searchMeta(id)?.name ?? id
}

/**
 * 给一家套上超时。
 *
 * ★ 超时**只中断这一家**,不动 `deps.signal` —— 那是整个 run 的中断信号,
 * abort 它等于把用户的整轮对话掐了。所以这里另起一个 controller,
 * 并把外面那个 signal 转发进来。
 */
async function withTimeout<T>(
  outer: AbortSignal,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ctl = new AbortController()
  const onOuter = (): void => {
    ctl.abort(outer.reason)
  }
  if (outer.aborted) onOuter()
  outer.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => {
    ctl.abort(new Error('超时'))
  }, ms)
  // 定时器不该拖住进程退出
  timer.unref?.()
  try {
    return await fn(ctl.signal)
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuter)
  }
}

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
      failures.push({ id, message: `${label(id)} 的 API Key 读不出来,可能是系统密钥环变了。` })
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

  return { results: [], failures }
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
