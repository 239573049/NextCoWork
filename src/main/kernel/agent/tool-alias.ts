/**
 * `tools:` 里那些名字 → 我们的 internalId。
 *
 * ## 这张表挡的是所有失败模式里最坏的一个
 *
 * 用户会把 Claude Code 的 agent 文件**原样**粘过来,里面写的是
 * `tools: Read, Grep, Glob`。把这三个字符串直接喂给
 * `snapshot({ allowList: [...] })`,只要有一个对不上,结果就是**匹配到更少的工具**;
 * 全对不上时是**零个工具**。而零工具的子代理不会报错 —— 它会跑起来、
 * 发现自己什么也做不了、然后**凭想象编一个答案交上来**。
 * 父代理拿到那份答案,看起来完全合理,于是接着往下做。
 *
 * 这就是为什么归一化在**加载期**而不是使用期:认不出的名字要在
 * `agent-load` 的诊断里当场说出来,而不是等到子代理跑完之后没人知道。
 *
 * ## 为什么还需要这张表 —— 我们的名字明明已经和 CC 一样了
 *
 * 内置工具的 internalId 现在逐字照搬 CC(`Read` / `Write` / `Grep` …),
 * 所以这张表**大部分是恒等映射**。它仍然要存在,因为剩下的那一小部分是真的:
 *
 * - **大小写**。`tools: read, grep` 是人会写的,而 `snapshot` 的匹配是精确的。
 * - **CC 有、我们没有的工具**。`MultiEdit` / `NotebookEdit` 在我们这儿都是 `Edit`;
 *   映射过去比拒绝掉好 —— 用户要的是「能改文件」,不是那个具体的实现。
 * - **同名不同物**。CC 的 `WebSearch` 对应我们的 `web_search`(不是 `WebFetch`);
 *   映射错的话,一个被要求「上网查」的子代理会拿到一个只会抓 URL 的工具。
 *
 * ★ 认不出就返回 `undefined`,**不静默丢弃、也不放行**。放行(原样返回)的坏处
 * 更隐蔽:那个名字会静静地待在 allowList 里,永远匹配不到任何东西,
 * 而诊断里一个字都没有。
 */

/**
 * 小写化之后的 CC 名字 → 我们的 internalId。
 *
 * ★ 键**必须**全小写,查表前先 `toLowerCase()`。写成混合大小写的话,
 * 这张表就只能认一种写法,而它存在的理由之一正是不挑写法。
 */
const CC_ALIAS: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  // CC 的批量编辑 / notebook 编辑,在我们这儿都由 Edit 一个工具承担
  multiedit: 'Edit',
  notebookedit: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'LS',
  webfetch: 'WebFetch',
  // ★ 不是 WebFetch。两个是不同的工具,搞混了子代理就上不了网只能抓 URL
  websearch: 'web_search',
  web_search: 'web_search',
  todowrite: 'TodoWrite',
  task: 'Task',
  skill: 'Skill',
  echo: 'echo'
}

/**
 * 一个名字 → internalId。认不出返回 `undefined`。
 *
 * 容忍前后空白(`tools: Read , Grep` 是 `fmList` 按逗号切出来的常见形状)。
 */
export function normalizeToolName(raw: string): string | undefined {
  return CC_ALIAS[raw.trim().toLowerCase()]
}

export interface NormalizeToolsResult {
  /** 认出来的那些,按原顺序、已去重 */
  tools: string[]
  /** 认不出的原文,原样留着 —— 诊断里要把它显示给用户看 */
  unknown: string[]
}

/**
 * 一整份 `tools:` 列表的归一化。
 *
 * ★ 去重是必要的:`tools: Read, MultiEdit, Edit` 会把 `Edit` 归一化出两次,
 * 而 `snapshot` 用的是 Set —— 重复本身无害,但让诊断和界面上显示的
 * 「这个子代理有 3 个工具」变成一句谎话。
 */
export function normalizeToolList(raw: readonly string[]): NormalizeToolsResult {
  const tools: string[] = []
  const seen = new Set<string>()
  const unknown: string[] = []

  for (const item of raw) {
    if (item.trim() === '') continue
    const hit = normalizeToolName(item)
    if (hit === undefined) {
      unknown.push(item.trim())
      continue
    }
    if (seen.has(hit)) continue
    seen.add(hit)
    tools.push(hit)
  }

  return { tools, unknown }
}

/** 给测试和诊断用:这张表认得的全部写法。 */
export const KNOWN_TOOL_ALIASES: readonly string[] = Object.keys(CC_ALIAS)
