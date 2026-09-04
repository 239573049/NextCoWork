/**
 * Base URL 归一化 —— 方案 §5.2 / §7。
 *
 * 这个函数的错误代价**不对称**:少削一段用户看得见也改得动,
 * 多削一段会把一个本来正确的地址悄悄改错,而用户会以为是请求实现有问题。
 * 所以「不该动的别动」那几条比「该削的削掉」更重要,测试也按这个配比写。
 */
import { describe, expect, it } from 'vitest'
import {
  baseUrlWarnings,
  joinUpstreamUrl,
  normalizeBaseUrl,
  previewUrl,
  REQUEST_PATH
} from '../baseurl'

describe('normalizeBaseUrl · 削掉完整请求地址的尾巴', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://api.x.com/v1/chat/completions', 'https://api.x.com/v1'],
    ['https://api.x.com/v1/messages', 'https://api.x.com/v1'],
    ['https://api.x.com/v1/responses', 'https://api.x.com/v1'],
    ['https://api.openai.com/v1/models', 'https://api.openai.com/v1'],
    ['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1']
  ]
  for (const [input, want] of cases) {
    it(input, () => expect(normalizeBaseUrl(input)).toBe(want))
  }
})

describe('★ normalizeBaseUrl · 不该动的一律别动', () => {
  /**
   * ★★ 方案 §5.2 点名的坑。`/api/v1beta` 是个**合法的、用户手打的 Base URL**,
   * 削成 `https://x.com/api` 之后请求会打到一个不存在的端点上。
   * 把 `/v1` 之类的**路径前缀**写进后缀表就会造成这个错。
   */
  it('https://x.com/api/v1beta 不能被误判成完整请求地址', () => {
    expect(normalizeBaseUrl('https://x.com/api/v1beta')).toBe('https://x.com/api/v1beta')
  })

  const untouched: readonly string[] = [
    'https://api.anthropic.com',
    'https://api.deepseek.com/v1',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://ark.cn-beijing.volces.com/api/v3',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://api.groq.com/openai/v1',
    'https://api.fireworks.ai/inference/v1'
  ]
  for (const input of untouched) {
    it(input, () => expect(normalizeBaseUrl(input)).toBe(input))
  }

  it('「completions」出现在中间而不是结尾时不削', () => {
    expect(normalizeBaseUrl('https://x.com/v1/messages/extra')).toBe(
      'https://x.com/v1/messages/extra'
    )
  })
})

describe('normalizeBaseUrl · 清理', () => {
  it('削尾斜杠', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1')
  })

  it('裸域名的尾斜杠也削掉 —— a.com/ 和 a.com 该是一个东西', () => {
    expect(normalizeBaseUrl('https://a.com/')).toBe('https://a.com')
    expect(normalizeBaseUrl('https://a.com')).toBe('https://a.com')
  })

  it('去掉查询串和锚点', () => {
    expect(normalizeBaseUrl('https://a.com/v1?key=abc#x')).toBe('https://a.com/v1')
  })

  it('前后空白', () => {
    expect(normalizeBaseUrl('  https://a.com/v1  ')).toBe('https://a.com/v1')
  })

  it('没写协议时补 https', () => {
    expect(normalizeBaseUrl('api.x.com/v1')).toBe('https://api.x.com/v1')
  })

  /** 本地运行时补 https 的话必然连不上 —— 它们都只听 http */
  it('本地回环补的是 http', () => {
    expect(normalizeBaseUrl('127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
  })

  it('空串还是空串,不变成 https://', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
  })

  it('压根不是 URL 就原样返回,让「测试连接」去报错', () => {
    expect(normalizeBaseUrl('这不是地址')).toBe('这不是地址')
  })
})

/** ★ §7 那条例外的防线。 */
describe('★ Gemini 的 OpenAI 兼容层', () => {
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/'

  it('尾斜杠必须保住(官方示例就是这个形状)', () => {
    expect(normalizeBaseUrl(GEMINI)).toBe(GEMINI)
  })

  it('从完整请求地址粘进来时也归一化到带尾斜杠的那个形状', () => {
    expect(normalizeBaseUrl(`${GEMINI}chat/completions`)).toBe(GEMINI)
  })

  /**
   * ★★ 这一条**曾经是 `it.fails`**:`REQUEST_PATH` 当时写的是
   * `/v1/chat/completions`,于是这里会拼出 `/v1beta/openai/v1/chat/completions`。
   *
   * 后来发现那不是「Gemini 一个例外」,而是**整个 OpenAI 族**的约定被写反了 ——
   * 版本段属于 base,不属于 path(证据是那张各家前缀表,见 `REQUEST_PATH` 的注释)。
   * 改对之后 DeepInfra / 智谱 / 火山 / 千帆 和 Gemini 一起对了。
   */
  it('拼出来的就是兼容层的真实端点', () => {
    expect(previewUrl(GEMINI, 'openai-chat')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    )
  })
})

/**
 * ★★ 上面那条的一般化 —— 报告 §3.1 里**每一种**版本段前缀各来一条。
 *
 * 这一组是「OpenAI 族的版本段属于 base」这个结论唯一的防线:
 * 退回 `/v1/chat/completions` 的话,除了第一条以外全会多出一段版本。
 */
describe('★ OpenAI 兼容层:各家版本段前缀都不同,一律不再补 /v1', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    [
      'https://api.fireworks.ai/inference/v1',
      'https://api.fireworks.ai/inference/v1/chat/completions'
    ],
    // ↓ 这四家不以 /v1 结尾,`joinUpstreamUrl` 的去重分支救不了它们
    ['https://api.deepinfra.com/v1/openai', 'https://api.deepinfra.com/v1/openai/chat/completions'],
    [
      'https://open.bigmodel.cn/api/paas/v4',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    ],
    [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
    ],
    ['https://qianfan.baidubce.com/v2', 'https://qianfan.baidubce.com/v2/chat/completions']
  ]

  for (const [base, want] of CASES) {
    it(base, () => expect(previewUrl(base, 'openai-chat')).toBe(want))
  }
})

describe('previewUrl · 和真实请求共用一份逻辑', () => {
  it('三种协议各自的路径', () => {
    expect(previewUrl('https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages'
    )
    expect(previewUrl('https://api.openai.com/v1', 'openai-chat')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(previewUrl('https://api.openai.com/v1', 'openai-responses')).toBe(
      'https://api.openai.com/v1/responses'
    )
  })

  /** 去重分支只剩 Anthropic 这一条路在用了 —— 手填 `.../anthropic/v1` 的那种 */
  it('Anthropic:baseUrl 已经带 /v1 时不重复', () => {
    expect(previewUrl('https://api.deepseek.com/anthropic/v1', 'anthropic')).toBe(
      'https://api.deepseek.com/anthropic/v1/messages'
    )
  })

  /** 回显和真实请求必须是同一个函数算出来的,否则迟早分叉 */
  it('previewUrl 就是 joinUpstreamUrl + REQUEST_PATH', () => {
    for (const p of ['anthropic', 'openai-chat', 'openai-responses'] as const) {
      expect(previewUrl('https://a.com/api', p)).toBe(
        joinUpstreamUrl('https://a.com/api', REQUEST_PATH[p])
      )
    }
  })
})

describe('baseUrlWarnings', () => {
  const kinds = (b: string, p: 'anthropic' | 'openai-chat'): string[] =>
    baseUrlWarnings(b, p).map((w) => w.kind)

  /**
   * ★ Anthropic 兼容端点一律不带 `/v1`,客户端自己会补 `/v1/messages`。
   * 用户手填 `.../anthropic/v1` 得到的是 `/v1/v1/messages` → 404,
   * 而 404 不会告诉他多了一段。
   */
  it('anthropic 协议 + /v1 结尾要出警告', () => {
    expect(kinds('https://x.com/anthropic/v1', 'anthropic')).toContain('anthropic-v1-suffix')
  })

  it('同一个地址在 openai 协议下不警告 —— 那边就该带 /v1', () => {
    expect(kinds('https://x.com/anthropic/v1', 'openai-chat')).not.toContain('anthropic-v1-suffix')
  })

  it('anthropic 协议 + 不带 /v1 不警告', () => {
    expect(kinds('https://open.bigmodel.cn/api/anthropic', 'anthropic')).toHaveLength(0)
  })

  it('警告文案里带上最终会请求的 URL', () => {
    const w = baseUrlWarnings('https://x.com/anthropic/v1', 'anthropic')[0]
    expect(w?.message).toContain('https://x.com/anthropic/v1/messages')
  })

  /**
   * ★ 光秃秃的域名在 OpenAI 族里几乎一定是漏了版本段 —— 报告里 30 多家兼容层
   * **没有一家**的 base 是裸域名。这条警告是 `REQUEST_PATH` 改动的配套:
   * path 里不再补 `/v1`,所以缺版本段这件事要在填表时就说出来。
   */
  it('openai 协议 + 裸域名要提示缺版本段', () => {
    expect(kinds('https://api.openai.com', 'openai-chat')).toContain('openai-missing-version')
    // 尾斜杠是同一件事,别因为 URL 的序列化差异漏判
    expect(kinds('https://api.openai.com/', 'openai-chat')).toContain('openai-missing-version')
  })

  it('带了版本段就不提示 —— 各家形状不同,只认「有没有路径」', () => {
    for (const b of [
      'https://api.openai.com/v1',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://api.deepinfra.com/v1/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/'
    ]) {
      expect(kinds(b, 'openai-chat'), b).not.toContain('openai-missing-version')
    }
  })

  /** anthropic 那边裸域名是**对的**(官方就是 `https://api.anthropic.com`),别误报 */
  it('anthropic 协议下裸域名不提示', () => {
    expect(kinds('https://api.anthropic.com', 'anthropic')).toHaveLength(0)
  })

  it('localhost 要提示换成 127.0.0.1', () => {
    expect(kinds('http://localhost:11434/v1', 'openai-chat')).toContain('localhost')
  })

  it('127.0.0.1 的 http 不算不安全', () => {
    expect(kinds('http://127.0.0.1:11434/v1', 'openai-chat')).toHaveLength(0)
  })

  it('公网 http 要提示密钥会裸奔', () => {
    expect(kinds('http://api.x.com/v1', 'openai-chat')).toContain('insecure')
  })

  it('空地址不警告 —— 用户还没开始填', () => {
    expect(baseUrlWarnings('', 'anthropic')).toHaveLength(0)
  })
})
