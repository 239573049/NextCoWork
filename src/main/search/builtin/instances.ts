/**
 * 内置免 Key 源的第一层:公共 / 自建 SearxNG 实例的候选名单。
 *
 * 需求:用户一个搜索服务都没配时,`web_search` 得有地方去搜。SearxNG 是唯一
 * 既免 Key、又给结构化 JSON 的公开选项,所以它排在直抓 SERP 之前。
 *
 * ## 不变式
 *
 * 1. **自建实例排第一**。用户填了地址就是想用它,轮到公共实例说明它挂了。
 * 2. 内置实例**照常过 SSRF 闸**(调用方 `searxng.ts` 负责),这里只管名单和顺序。
 *    用户手填的那一个是唯一例外,理由写在 `searxng.ts` 的文件头。
 * 3. 名单是**编译进包的常量**,和 `shared/domain/search.ts` 的 `SEARCH_CATALOG` 同款。
 *
 * ## 故意不做
 *
 * **不在运行时从 searx.space 拉实例列表。** 那要多一次网络往返、一份缓存、
 * 一套「缓存过期怎么办」,而这条链路本身就是兜底 —— 兜底比主路更需要可预测。
 * 已知代价照实记:名单里的实例挂掉了,要发版才能换,用户在那之前的出路是
 * 填一个自建实例(设置 › 连接 › 搜索 底部)或者配一家专业服务。
 *
 * 名单为什么这么短:候选最多试 3 个(见 `index.ts` 的预算),再长也轮不到;
 * 而且按下面那段实测,第一层能不能通基本由「有没有自建实例」决定,
 * 再堆五个公共实例只会让每次搜索多等几秒超时。
 */

/**
 * 公共 SearxNG 实例。取自公开的实例目录,按「宣称开着 `format=json`」挑的三个。
 *
 * ★ **这三个都没能在开发机上验通**(2026-09-20 实测):searx.be 返回一个
 * 「正在验证你的浏览器」页,search.bus-hit.me 直接断连,priv.au 把请求重定向走了。
 * 这不是名单选错了 —— 公共实例普遍加了人机验证和限流,而且随时会变。
 *
 * 所以:**第二层(直抓 SERP)不是冗余,它才是多数机器上真正跑起来的那一条**
 * (同一次实测里,Bing 的结果页正常返回并被 `serp.ts` 解析出了 8 条)。
 * 谁要是看到「这里已经有三个实例了」就去删第二层,兜底会在大部分网络下当场失效。
 *
 * 想稳定用第一层的办法只有一个:在「设置 › 连接 › 搜索」底部填自己的实例。
 * 那也是这个字段存在的理由。
 */
export const PUBLIC_SEARXNG_INSTANCES: readonly string[] = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://priv.au'
]

/**
 * 候选顺序:自建(若填了)→ 内置。**按 origin 去重** ——
 * 用户把自建地址填成了内置名单里的某一个时,不该白试两遍。
 *
 * `selfHosted` 原样返回(只 trim 掉两端空白),合法性交给调用方的 `new URL()`:
 * 这里判不了「这台机器上那个端口有没有 SearxNG」,而半套校验会给用户
 * 「填对了」的错觉。
 */
export function searxngCandidates(selfHosted: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string): void => {
    const url = raw.trim()
    if (url === '') return
    // origin 取不出来说明这根本不是个地址;原样放进去,让调用方的 new URL() 报出真正的原因
    const key = originOf(url) ?? url
    if (seen.has(key)) return
    seen.add(key)
    out.push(url)
  }

  push(selfHosted)
  for (const url of PUBLIC_SEARXNG_INSTANCES) push(url)
  return out
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}
