import type { ThinkingConfig } from '../../provider'
import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, source } from '../helpers'

/**
 * Ollama —— 两个职责:自己的目录条目 + **Ollama 系供应商上所有模型的思考线形**。
 *
 * ============================ 目录条目为什么只带 `:tag` ============================
 * 条目只覆盖**带 `:tag` 形态**的模型名(如 `gpt-oss:120b`)。不带 tag 的名字
 * (`kimi-k3`、`glm-5.3`)由各自厂商的条目精确命中,这里**故意不重复** —— 两条
 * 同 id 的目录行会让 exact 匹配拿到先注册的那条,这边的配置被静默作废,而目录
 * 的唯一性测试也会拦。
 *
 * ★★ 为什么需要这些条目(2026-09-15 调查定案):目录按名字匹配 thinking 配置,
 * 而 `normalizeModelId` 只做小写化 —— `gpt-oss:120b`(冒号)永远匹配不上 openai
 * vendor 的 `gpt-oss-120b`(连字符),thinkingConfig 落空后用户的 Think 开关
 * (尤其「关」)对 Ollama 完全不生效。全局把冒号折叠成连字符不可取:
 * OpenRouter 风格的路由名(`vendor/model:variant`)里冒号有语义。
 *
 * ============================ 思考线形(三个端点一套内核) ============================
 * 官方文档(docs.ollama.com/capabilities/thinking,2026-09-15 摘录)与 v0.34.0 源码
 * 交叉验证:
 *
 * - **思考默认开启**;"多数模型接受布尔(`true`/`false`)或档位(`low`/`medium`/`high`/`max`)";
 * - **GPT-OSS 是例外**:只认 `low`/`medium`/`high`,布尔被忽略,且**trace 关不干净**
 *   —— 所以它的条目里没有 `none`(给一个关不掉的「关」是在骗用户);
 * - OpenAI 兼容层(`/v1/chat/completions`)吃 `reasoning_effort`(网关把 minimal/low/
 *   medium/high/xhigh/ultra/max/none 全收下,越界的向两端钳位、`none` = 关);
 *   Anthropic 兼容层(`/v1/messages`)读 `thinking.type` 的开/关**且**档位只认
 *   `output_config.effort` —— 而且源码里那一支挂在 `think == nil` 上:同时发
 *   `thinking:{type:'enabled'}` 会让 effort 被无视(见 thinking-adapter 的注释);
 * - 服务端把档位字符串统一折成 `enable_thinking: true` + `chat_template_kwargs.
 *   reasoning_effort`(gpt-oss 的 harmony 引擎直接消费它;其余模型由各自模板决定,
 *   不吃档位的模板会把任何档位当「开」—— 不报错,只是不区分)。
 *
 * ============ `OLLAMA_STANDARD_THINKING`:任何模型绑到 Ollama 上的线形 ============
 * `model-binding.ts` 对「绑定在 Ollama 系供应商上、但命中的是别家目录条目」的模型
 * **就地套用**这套配置 —— 智谱/DeepSeek 条目的方言字段(`thinking:{type}`、custom
 * 路径)会被 Ollama 的兼容层静默丢弃(`glm-5.3` 切「关」无效,就是这个名字劫持)。
 * 配置与上面那些条目**共用同一个常量**,两处不会分叉。
 */
export const OLLAMA_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'max'] as const

/** OpenAI 兼容层的线形:`reasoning_effort`,且声明 standardWire 跳过方言启发式 */
export const OLLAMA_STANDARD_THINKING: ThinkingConfig = {
  mode: 'effort',
  defaultEnabled: true,
  defaultEffort: 'medium',
  parameterPath: 'reasoning_effort',
  /*
   * ★★ 不能省。deepseek/glm 这些**名字**会被 thinking-adapter 的名字启发式抓进
   * DeepSeek/智谱的官方方言分支(它们要的 `thinking:{type}` 字段 Ollama 不认),
   * standardWire 是所有 Ollama 线形的入口开关 —— 官方供应商的条目不声明它,
   * 行为一个字节不变。
   */
  standardWire: true
}

/**
 * GPT-OSS 的档位:官方文档说它只认 low/medium/high,布尔被忽略、trace 关不掉。
 * 与 `OLLAMA_STANDARD_THINKING` 共用线形,只有档位表短一截(无 `none`、无 `max`)。
 */
const GPT_OSS_EFFORTS = ['low', 'medium', 'high'] as const

export const OLLAMA: readonly BuiltinModelRecord[] = [
  model('ollama', 'gpt-oss:120b', 'GPT OSS 120B', {
    capabilities: textCapabilities({ thinking: true }),
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    thinkingConfig: OLLAMA_STANDARD_THINKING,
    reasoningEfforts: GPT_OSS_EFFORTS,
    source: source('https://docs.ollama.com/capabilities/thinking')
  }),
  model('ollama', 'gpt-oss:20b', 'GPT OSS 20B', {
    capabilities: textCapabilities({ thinking: true }),
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    thinkingConfig: OLLAMA_STANDARD_THINKING,
    reasoningEfforts: GPT_OSS_EFFORTS,
    source: source('https://docs.ollama.com/capabilities/thinking')
  }),
  /*
   * 其余带 tag 的建议模型:官方文档说「多数模型接受布尔或档位」,给全套档位。
   * 上下文/输出上限没有官方数字可引,留目录默认值 —— 编一个看似可信的数字比缺省更糟。
   */
  model('ollama', 'deepseek-v4-pro:0813', 'DeepSeek V4 Pro (0813)', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: OLLAMA_STANDARD_THINKING,
    reasoningEfforts: OLLAMA_REASONING_EFFORTS,
    source: source('https://docs.ollama.com/cloud')
  }),
  model('ollama', 'qwen3.5:397b', 'Qwen 3.5 397B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: OLLAMA_STANDARD_THINKING,
    reasoningEfforts: OLLAMA_REASONING_EFFORTS,
    source: source('https://docs.ollama.com/cloud')
  })
]
