import { describe, expect, it } from 'vitest'
import type { AgentMessage, ContentPart } from '../../../../shared/agent/message'
import { assistantMessage, userMessage } from '../../../../shared/agent/message'
import type { ToolInfo } from '../../../../shared/agent/tool'
import { joinUpstreamUrl, type CanonicalRequest } from '../canonical'
import { encodeAnthropic, toAnthropicMessages, toAnthropicTools } from '../encode/anthropic'

function u(...parts: ContentPart[]): AgentMessage {
  return userMessage('u', parts, 0)
}
function a(...parts: ContentPart[]): AgentMessage {
  return assistantMessage('a', parts, 0)
}

const BASE: CanonicalRequest = {
  model: 'alias',
  system: '',
  messages: [],
  tools: [],
  maxOutputTokens: 4096
}

describe('toAnthropicMessages · 会被上游拒收的形状', () => {
  /**
   * ★ 空 text 块是 400(`text content blocks must be non-empty`)。
   * 它很容易产生:中断发生在第一个 delta 之前,或模型直接以 tool_use 开场。
   */
  it('丢掉空 text 块', () => {
    expect(toAnthropicMessages([a({ type: 'text', text: '' }, { type: 'text', text: 'ok' })])).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
    ])
  })

  /** 所有块都被丢完的消息整条跳过 —— 空 content 的消息同样是 400 */
  it('丢掉变空的整条消息', () => {
    expect(toAnthropicMessages([u({ type: 'text', text: 'hi' }), a({ type: 'text', text: '' })])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    ])
  })

  /**
   * ★ 相邻同角色必须合并。我们这边很容易产生两条连续 user 消息:
   * 并行工具的结果、以及中断时补的 interrupted 回执。Anthropic 要求严格交替。
   */
  it('合并相邻同角色消息', () => {
    const out = toAnthropicMessages([
      u({ type: 'tool_result', callId: 'c1', output: { content: 'A' }, isError: false }),
      u({ type: 'tool_result', callId: 'c2', output: { content: 'B' }, isError: false }),
      u({ type: 'text', text: '继续' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
    expect(out[0]?.content).toHaveLength(3)
  })

  it('中间那条消息被丢空时,它两侧的同角色消息要合并', () => {
    const out = toAnthropicMessages([
      a({ type: 'text', text: '一' }),
      u({ type: 'text', text: '' }), // 整条被丢
      a({ type: 'text', text: '二' })
    ])
    expect(out).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] }
    ])
  })

  it('不合并不同角色', () => {
    const out = toAnthropicMessages([u({ type: 'text', text: 'q' }), a({ type: 'text', text: 'r' })])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('toAnthropicMessages · thinking 与透传', () => {
  /**
   * ★ 没有 signature 的 thinking 块不能回传(`thinking blocks require a signature`)。
   * 丢掉只是少一段推理上下文;带个假签名是 400,整轮请求都废了。
   */
  it('丢掉没有签名的 thinking 块', () => {
    expect(toAnthropicMessages([a({ type: 'thinking', text: '推理' })])).toEqual([])
  })

  it('带签名的 thinking 块原样回传', () => {
    const out = toAnthropicMessages([
      a({ type: 'thinking', text: '推理', opaque: { signature: 'ErUB' } })
    ])
    expect(out[0]?.content).toEqual([{ type: 'thinking', thinking: '推理', signature: 'ErUB' }])
  })

  it('redacted_thinking 即使正文为空也要回传', () => {
    const out = toAnthropicMessages([a({ type: 'thinking', text: '', opaque: { redacted: 'EvQB' } })])
    expect(out[0]?.content).toEqual([{ type: 'redacted_thinking', data: 'EvQB' }])
  })

  it('opaque 形状不对时按无签名处理,不崩', () => {
    for (const bad of [null, 'str', 42, {}, { signature: 7 }]) {
      expect(toAnthropicMessages([a({ type: 'thinking', text: 'x', opaque: bad })]), String(bad)).toEqual([])
    }
  })
})

describe('toAnthropicMessages · 工具', () => {
  it('tool_call → tool_use,tool_result → tool_result', () => {
    const out = toAnthropicMessages([
      a({ type: 'tool_call', callId: 'toolu_1', name: 'read', input: { path: 'a' } }),
      u({ type: 'tool_result', callId: 'toolu_1', output: { content: '内容' }, isError: false })
    ])
    expect(out).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '内容', is_error: false }] }
    ])
  })

  /** 无参工具的 input 可能是 undefined —— 下发 undefined 会被 JSON.stringify 掉,变成缺字段 */
  it('input 缺失时补成空对象', () => {
    const out = toAnthropicMessages([a({ type: 'tool_call', callId: 'c', name: 'now', input: undefined })])
    expect(out[0]?.content[0]).toMatchObject({ input: {} })
  })

  it('isError 透传给 is_error', () => {
    const out = toAnthropicMessages([
      u({ type: 'tool_result', callId: 'c', output: { content: '炸了' }, isError: true })
    ])
    expect(out[0]?.content[0]).toMatchObject({ is_error: true })
  })

  /** error part 只属于 UI 那一轨。回传给模型,模型就会开始为我们的 bug 道歉 */
  it('error part 不上行', () => {
    const out = toAnthropicMessages([
      a(
        { type: 'error', error: { code: 'network', message: 'x', retryable: true } },
        { type: 'text', text: '正文' }
      )
    ])
    expect(out[0]?.content).toEqual([{ type: 'text', text: '正文' }])
  })
})

describe('toAnthropicTools', () => {
  /** ★ 下发的是 externalName(≤64、字符受限),不是 internalId */
  it('下发 externalName 而不是 internalId', () => {
    const t: ToolInfo = {
      internalId: 'mcp__github-enterprise-internal__create_pull_request_review_comment',
      externalName: 'mcp__github_create_pr_review_c_9f3a12bc',
      description: 'd',
      inputSchema: { type: 'object' },
      readOnly: false,
      destructive: false,
      needsNetwork: false,
      source: { kind: 'builtin' }
    }
    expect(toAnthropicTools([t])).toEqual([
      { name: 'mcp__github_create_pr_review_c_9f3a12bc', description: 'd', input_schema: { type: 'object' } }
    ])
  })
})

describe('encodeAnthropic', () => {
  it('基本请求体', () => {
    const enc = encodeAnthropic(
      { ...BASE, system: '你是助手', messages: [u({ type: 'text', text: 'hi' })] },
      'claude-x',
      'sk-1'
    )
    expect(enc.path).toBe('/v1/messages')
    expect(enc.headers).toMatchObject({ 'x-api-key': 'sk-1', 'anthropic-version': '2023-06-01' })
    expect(enc.body).toMatchObject({ model: 'claude-x', max_tokens: 4096, stream: true, system: '你是助手' })
  })

  it('空 system 不下发该字段', () => {
    expect(encodeAnthropic(BASE, 'm', 'k').body).not.toHaveProperty('system')
  })

  it('无工具时不下发 tools 字段', () => {
    expect(encodeAnthropic(BASE, 'm', 'k').body).not.toHaveProperty('tools')
  })

  /**
   * ★ 开 thinking 时 max_tokens 必须大于 budget_tokens,否则 400。
   * 不在这里兜住,它就以「高思考档位下必然报错」的形式出现在用户面前。
   */
  it('thinking 预算不小于 max_tokens 时抬高 max_tokens', () => {
    const body = encodeAnthropic({ ...BASE, maxOutputTokens: 4096, thinkingBudget: 8192 }, 'm', 'k')
      .body as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body.max_tokens).toBe(8192 + 4096)
  })

  it('max_tokens 已经够大时不改动', () => {
    const body = encodeAnthropic({ ...BASE, maxOutputTokens: 32000, thinkingBudget: 8192 }, 'm', 'k')
      .body as Record<string, unknown>
    expect(body.max_tokens).toBe(32000)
  })

  /** 开启 thinking 时上游不接受 temperature */
  it('开 thinking 时不下发 temperature', () => {
    const body = encodeAnthropic({ ...BASE, thinkingBudget: 1024, temperature: 0.7 }, 'm', 'k').body as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty('temperature')
  })

  it('不开 thinking 时 temperature 正常下发', () => {
    const body = encodeAnthropic({ ...BASE, temperature: 0.7 }, 'm', 'k').body as Record<string, unknown>
    expect(body.temperature).toBe(0.7)
  })

  it('stopSequences 为空数组时不下发', () => {
    const body = encodeAnthropic({ ...BASE, stopSequences: [] }, 'm', 'k').body as Record<string, unknown>
    expect(body).not.toHaveProperty('stop_sequences')
  })
})

/**
 * ⚠️ 协议 §8 的拼接规则是个会咬人的启发式,所以只写这一遍 ——
 * 设置页显示给用户确认的那一行,和实际请求用的必须是同一份逻辑。
 */
describe('joinUpstreamUrl', () => {
  const cases: Array<[string, string]> = [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/', 'https://api.anthropic.com/v1/messages'],
    ['https://x.com/api/v1', 'https://x.com/api/v1/messages'],
    ['https://x.com/api/v1/', 'https://x.com/api/v1/messages'],
    ['https://x.com/api/v1///', 'https://x.com/api/v1/messages'],
    // v1beta 不以 /v1 结尾 —— 补全整个 /v1/messages 才是对的
    ['https://x.com/api/v1beta', 'https://x.com/api/v1beta/v1/messages']
  ]
  for (const [base, want] of cases) {
    it(base, () => expect(joinUpstreamUrl(base, '/v1/messages')).toBe(want))
  }

  it('path 不带前导斜杠也能拼', () => {
    expect(joinUpstreamUrl('https://a.com', 'v1/messages')).toBe('https://a.com/v1/messages')
  })
})
