/**
 * OpenCode Go 的「模型 → 协议」表。
 *
 * ★ 这张表是照官方文档 https://opencode.ai/docs/go 的 Endpoints 一节抄的
 * (2026-09-12 核实),而**文档会变**。下面把每一行都钉成断言,不是为了测
 * `Record` 的查表能力,是为了让「官方改了某个模型的端点」这件事在改表时
 * 有一处会红 —— 否则那次改动的唯一反馈,是用户那边一句读不懂的 500。
 */
import { describe, expect, it } from 'vitest'
import { OPENCODE_GO_MODEL_PROTOCOLS, isOpencodeGoRoute, opencodeGoProtocolFor } from '../opencode-protocol'

/** 预设那条:`presets.ts` 的 `opencode-go`。 */
const go = { id: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' }
/** 用户手填地址建的那条(id 带 `custom-` 前缀,见 `custom-provider.ts`)。 */
const custom = { id: 'custom-abc', baseUrl: 'https://opencode.ai/zen/go/v1' }

describe('官方 Endpoints 表逐行', () => {
  it.each([
    ['grok-4.6', 'openai-responses'],
    ['gpt-5.6-luna', 'openai-responses'],
    ['muse-spark-1.3-contributor', 'openai-responses'],
    ['muse-spark-1.2-contributor', 'openai-responses'],
    ['glm-5.3-flash', 'openai-chat'],
    ['glm-5.3', 'openai-chat'],
    ['glm-5.2', 'openai-chat'],
    ['glm-5.1', 'openai-chat'],
    ['kimi-k3', 'openai-chat'],
    ['kimi-k2.7-code', 'openai-chat'],
    ['kimi-k2.6', 'openai-chat'],
    ['longcat-2.0', 'openai-chat'],
    ['deepseek-v4.1-flash', 'openai-chat'],
    ['deepseek-v4-pro', 'openai-chat'],
    ['deepseek-v4-flash', 'openai-chat'],
    ['deepseek-v4-flash-vision-exp', 'openai-chat'],
    ['mimo-v2.5', 'openai-chat'],
    ['mimo-v2.5-pro', 'openai-chat'],
    ['hy4-preview', 'openai-chat'],
    ['hy3', 'openai-chat'],
    ['minimax-m3', 'anthropic'],
    ['minimax-m2.7', 'anthropic'],
    ['minimax-m2.5', 'anthropic'],
    ['qwen3.8-max', 'anthropic'],
    ['qwen3.8-flash', 'anthropic'],
    ['qwen3.7-max', 'anthropic'],
    ['qwen3.7-plus', 'anthropic'],
    ['qwen3.6-plus', 'anthropic']
  ])('%s → %s', (model, protocol) => {
    expect(opencodeGoProtocolFor(go, model)).toBe(protocol)
  })

  it('★ 文档表 28 行,一行不多一行不少', () => {
    expect(Object.keys(OPENCODE_GO_MODEL_PROTOCOLS)).toHaveLength(28)
  })

  /**
   * ★★ 本次线上故障的回归钉子:
   * `HTTP 500 https://opencode.ai/zen/go/v1/chat/completions model=muse-spark-1.3-contributor`。
   * 这个模型走 `/responses`,继承供应商的 `openai-chat` 就是那句 500 的全部成因。
   */
  it('★★ muse-spark-1.3-contributor 绝不能落到 chat/completions', () => {
    expect(opencodeGoProtocolFor(go, 'muse-spark-1.3-contributor')).toBe('openai-responses')
  })
})

describe('文档表没有、但 /models 接口有的那些', () => {
  it.each([
    ['grok-4.5', 'openai-responses'],
    ['kimi-k2.5', 'openai-chat'],
    ['glm-5', 'openai-chat'],
    ['deepseek-flash', 'openai-chat'],
    ['mimo-v2-pro', 'openai-chat'],
    ['mimo-v2-omni', 'openai-chat'],
    ['hy3-preview', 'openai-chat'],
    ['qwen3.5-plus', 'anthropic']
  ])('按家族前缀兜底:%s → %s', (model, protocol) => {
    expect(opencodeGoProtocolFor(go, model)).toBe(protocol)
  })

  /**
   * ★ 认不出就**不猜**。猜错会把一个今天能用的模型弄坏,而 undefined 只是维持现状
   * (继承供应商的出厂协议)—— 两种错的代价不对称。
   */
  it('★ omen-alpha 哪一类都不像 —— 返回 undefined,保持继承', () => {
    expect(opencodeGoProtocolFor(go, 'omen-alpha')).toBeUndefined()
  })

  it('空模型名不当成一次查表', () => {
    expect(opencodeGoProtocolFor(go, '  ')).toBeUndefined()
  })
})

describe('路由判定', () => {
  it('预设那条按 id 认', () => {
    expect(isOpencodeGoRoute(go)).toBe(true)
  })

  it('手填 Go 地址的自定义供应商也认(id 对不上,但主机名和路径对得上)', () => {
    expect(isOpencodeGoRoute(custom)).toBe(true)
    expect(opencodeGoProtocolFor(custom, 'muse-spark-1.3-contributor')).toBe('openai-responses')
  })

  it('末尾带斜杠一样认', () => {
    expect(isOpencodeGoRoute({ id: 'custom-a', baseUrl: 'https://opencode.ai/zen/go/v1/' })).toBe(true)
  })

  /**
   * ★★ **Zen 按量那条路由不是 Go。** 两张表不一样 —— `minimax-m3` 在 Go 上走
   * `/messages`,在 Zen 上走 `/chat/completions`(见两份官方文档的 Endpoints 表)。
   * 把 Go 的表套到 Zen 上,会把一家今天好好的供应商弄坏。
   */
  it('★★ 同域的 Zen(/zen/v1)不认 —— 它的协议表和 Go 不一样', () => {
    const zen = { id: 'custom-zen', baseUrl: 'https://opencode.ai/zen/v1' }
    expect(isOpencodeGoRoute(zen)).toBe(false)
    expect(opencodeGoProtocolFor(zen, 'minimax-m3')).toBeUndefined()
  })

  /**
   * ★★ 主机名判定不能退化成子串匹配(理由见 `transport.ts` 的 `OPENCODE_HOST`)。
   * 这条盯的是那件事的下游:一台冒名主机不该顺带拿到我们的协议表。
   */
  it('★★ opencode.ai.attacker.com 不是这家', () => {
    expect(isOpencodeGoRoute({ id: 'custom-x', baseUrl: 'https://opencode.ai.attacker.com/zen/go/v1' })).toBe(false)
  })

  it('别家一律不认', () => {
    expect(isOpencodeGoRoute({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(false)
    expect(opencodeGoProtocolFor({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }, 'deepseek-v4-pro'))
      .toBeUndefined()
  })

  it('畸形 baseUrl 当「不是这家」,不抛', () => {
    expect(isOpencodeGoRoute({ id: 'custom-y', baseUrl: 'not a url' })).toBe(false)
  })
})
