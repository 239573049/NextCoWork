/**
 * 路径模糊匹配 —— `@` 文件选择器背后的那个排序。
 *
 * ## 为什么排序住在 shared 而不是主进程里
 *
 * 它是这个功能里**唯一有对错可言**的部分:敲 `chatv` 该先看到
 * `views/chat/ChatView.tsx` 而不是 `docs/chat-view-notes.md`。
 * 放在 IPC handler 里就只能靠端到端点一遍去验,而排序的回归恰恰是那种
 * 「不报错、只是变难用了」的退化 —— 没有单测就等于没人看着。
 *
 * ## 分档而不是加权求和
 *
 * 打分刻意做成**几个离散的档**(文件名前缀 > 文件名包含 > 整条路径包含 >
 * 子序列),档内才用长度和深度打破平局。加权求和调起来没有尽头,而且
 * 「为什么这一条排前面」永远解释不清;分档的结果是可以一句话说明白的。
 */

/** 一条候选。`path` 是**工作区相对**、始终用 `/` 分隔(同 `FileEntry.path`) */
export interface PathCandidate {
  path: string
  name: string
}

/** 档位基准分。相邻两档差得足够大,好让档内的微调永远翻不过档。 */
const TIER = {
  namePrefix: 5000,
  nameContains: 4000,
  pathContains: 3000,
  nameSubsequence: 2000,
  pathSubsequence: 1000
} as const

/**
 * `needle` 的每个字符是否按顺序出现在 `hay` 里(允许跳字符)。
 *
 * ★ 这一档存在的理由是缩写:`ccv` 要能找到 `chat/ChatView.tsx`。
 * 代价是它对短查询极其宽松 —— 所以它是**最低**的两档,
 * 任何一个真正包含查询串的结果都排在它前面。
 */
export function isSubsequence(hay: string, needle: string): boolean {
  if (needle === '') return true
  let i = 0
  // ★ 两边都按 UTF-16 码元走。`for...of` 按码点迭代,而 `needle[i]` 按码元索引 ——
  //   混用的话,文件名里一个 emoji 就会让两边错位。
  for (let h = 0; h < hay.length; h++) {
    if (hay[h] === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

/**
 * 档内的微调 —— **越小越靠前**,而且整体必须小于一个档的间距(1000),
 * 否则一条又深又长的路径会掉到下一档去。
 */
function tieBreak(c: PathCandidate): number {
  const depth = c.path.split('/').length - 1
  // 深度权重大于长度:同名文件优先给根附近那一个
  return Math.min(depth * 12 + c.path.length, 900)
}

/**
 * 一条候选对这次查询的得分。**不匹配返回 null**,不是 0 ——
 * 0 是一个合法的低分,用它表示「不匹配」会让调用方漏掉过滤。
 */
export function scorePath(candidate: PathCandidate, query: string): number | null {
  const q = query.toLowerCase()
  if (q === '') return -tieBreak(candidate)

  const name = candidate.name.toLowerCase()
  const path = candidate.path.toLowerCase()
  const penalty = tieBreak(candidate)

  const inName = name.indexOf(q)
  if (inName === 0) return TIER.namePrefix - penalty
  if (inName > 0) return TIER.nameContains - inName - penalty
  // ★ 整条路径这一档要能吃下 `chat/comp` 这种带斜杠的写法 —— 用户脑子里
  //   的定位方式常常是「哪个目录下的什么」,而不是纯文件名。
  if (path.includes(q)) return TIER.pathContains - penalty
  if (isSubsequence(name, q)) return TIER.nameSubsequence - penalty
  if (isSubsequence(path, q)) return TIER.pathSubsequence - penalty
  return null
}

/**
 * 排序并截断。★ **稳定排序**:分数相同的两条保持索引里的原有次序,
 * 否则同一个查询在两次敲键之间可能给出不同的顺序,列表会自己跳。
 */
export function rankPaths<T extends PathCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number
): T[] {
  const scored: Array<{ item: T; score: number; i: number }> = []
  for (const [i, item] of candidates.entries()) {
    const score = scorePath(item, query)
    if (score !== null) scored.push({ item, score, i })
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, limit).map((s) => s.item)
}
