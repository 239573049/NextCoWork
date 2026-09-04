/**
 * 品牌识别表 —— 从自由文本猜出是哪家模型/供应商。
 *
 * 和 `ProviderIcon.tsx` 分开是有原因的:那边有 31 条 `?raw` 导入,只有
 * 走 Vite 才解析得了;这边是纯函数,能在普通 vitest 里跑(`vitest.config.ts`
 * 的 environment 是 node)。而这张表恰恰是最需要测的部分 ——
 * **正则顺序错一位,就会有模型显示成别家的 logo,而且没人会报 bug。**
 */

/**
 * 运行期也要有这份列表(不只是类型),测试才能断言
 * **每个牌子都至少被一条规则覆盖到** —— 只有类型的话,
 * 「加了牌子但忘了写规则」是个永远匹配不到的死项,没人会发现。
 */
export const BRANDS = [
  'anthropic', 'azure', 'baichuan', 'bedrock', 'claude', 'deepseek',
  'doubao', 'fireworks', 'gemini', 'groq', 'hunyuan', 'kimi',
  'lmstudio', 'meta', 'minimax', 'mistral', 'moonshot', 'ollama',
  'openai', 'openrouter', 'perplexity', 'qwen', 'siliconcloud',
  'spark', 'stepfun', 'together', 'vertexai', 'volcengine',
  'xai', 'yi', 'zhipu'
] as const

export type Brand = (typeof BRANDS)[number]

/**
 * **顺序即优先级**,先命中先用。几处顺序是刻意的:
 *
 * - `claude` 在 `anthropic` 前:`claude-*` 是模型,该显示 Claude 的字形。
 * - `kimi` 在 `moonshot` 前:两个字形都有,各显示各的。
 * - `doubao` 在 `volcengine` 前:火山引擎上的豆包模型该显示豆包。
 * - ★ `ollama` 在 `meta` 前:**「Ollama」里含着「llama」** —— 松散的
 *   `/llama/` 会把 Ollama 匹配成 Meta。这里不改用 `\bllama` 收紧,
 *   是因为那样又会漏掉 `codellama`;靠顺序解决,两边都对。
 *
 * 用正则不用 `includes`,是因为短 token 会误伤 —— `o1`/`o3` 这种两字符的
 * 模型名直接子串匹配会在别的名字中间命中,所以给它们加了 `\b` 边界。
 *
 * 中文也要匹配:设置页里供应商名是用户自己填的,写「深度求索」的人不比
 * 写 `deepseek` 的少。
 */
const RULES: readonly (readonly [RegExp, Brand])[] = [
  [/claude/i, 'claude'],
  [/anthropic/i, 'anthropic'],
  [/\b(gpt|o[134])\b|openai|chatgpt/i, 'openai'],
  [/deepseek|深度求索/i, 'deepseek'],
  [/qwen|qwq|tongyi|通义|千问/i, 'qwen'],
  [/kimi/i, 'kimi'],
  [/moonshot|月之暗面/i, 'moonshot'],
  [/glm|zhipu|chatglm|智谱/i, 'zhipu'],
  [/gemini|palm|google|谷歌/i, 'gemini'],
  [/grok|\bxai\b/i, 'xai'],
  // ★ 必须在 meta 之前:'Ollama' 里含着 'llama'
  [/ollama/i, 'ollama'],
  [/llama|\bmeta\b/i, 'meta'],
  [/mistral|codestral|mixtral/i, 'mistral'],
  [/minimax|abab/i, 'minimax'],
  [/doubao|豆包/i, 'doubao'],
  [/volc|火山/i, 'volcengine'],
  [/hunyuan|混元/i, 'hunyuan'],
  [/spark|讯飞|星火/i, 'spark'],
  // StepFun 的模型就叫 step-1 / step-2,光匹配 'stepfun' 会全漏
  [/\bstep-|stepfun|阶跃/i, 'stepfun'],
  [/baichuan|百川/i, 'baichuan'],
  [/\byi-|零一万物/i, 'yi'],
  [/openrouter/i, 'openrouter'],
  [/silicon|硅基流动/i, 'siliconcloud'],
  [/lm.?studio/i, 'lmstudio'],
  [/groq/i, 'groq'],
  [/together/i, 'together'],
  [/fireworks/i, 'fireworks'],
  [/perplexity|sonar/i, 'perplexity'],
  [/bedrock/i, 'bedrock'],
  [/vertex/i, 'vertexai'],
  [/azure/i, 'azure']
]

/**
 * 依次试每个候选名,**先给最具体的**:模型别名比供应商名更可能带牌子
 * (聚合商 provider 叫「RoutinAI」,但它下面的 alias 是 `claude-fable-5-1`)。
 *
 * 猜不中返回 null —— 这是正常路径,不是错误。用户可以配任何上游,
 * 我们不可能认得全,认不出就退回通用图标。
 */
export function resolveBrand(...names: readonly (string | undefined)[]): Brand | null {
  for (const name of names) {
    if (name === undefined || name === '') continue
    for (const rule of RULES) {
      if (rule[0].test(name)) return rule[1]
    }
  }
  return null
}
