import { describe, expect, it, vi } from 'vitest'
import { assistantMessage, userMessage, type AgentMessage } from '../../shared/agent/message'
import type { ProviderStreamEvent } from '../../shared/agent/stream'
import type { ModelAlias } from '../../shared/domain/provider'
import { GOAL_EVALUATOR_SYSTEM } from '../goal/prompt'
import { estimateTokens } from '../kernel/context-assembler'
import type { CanonicalRequest } from '../kernel/upstream/canonical'
import { evaluateGoal, renderTranscript, type GoalEvaluatorPort } from '../goal/evaluate'

/** 判定器模型 —— 每个字段都显式给全，不用 cast。 */
const alias = (contextWindow = 200_000): ModelAlias => ({
  alias: 'judge',
  providerId: 'p1',
  upstreamModel: 'judge-1',
  contextWindow,
  maxOutputTokens: 4096,
  capabilities: { tools: false, vision: false, thinking: false, caching: false }
})

const USAGE = { inputTokens: 100, outputTokens: 10 }

/**
 * 一次**完整**的回复：文本 + `end_turn` 的 message_end。
 *
 * ★ 少了后半截就不该被采信 —— 判定要的是「这次回答结束了」，不是「文本恰好是合法 JSON」。
 */
function complete(text: string): AsyncIterable<ProviderStreamEvent> {
  return (async function* (): AsyncIterable<ProviderStreamEvent> {
    if (text !== '') yield { type: 'text_delta', index: 0, text }
    yield { type: 'message_end', stopReason: 'end_turn', usage: USAGE }
  })()
}

const contextLengthError = (): AsyncIterable<ProviderStreamEvent> =>
  (async function* (): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'error', error: { code: 'context_length', message: 'too long', retryable: false } }
  })()

/** 挂住不走、也从不看 signal 的上游 —— 只有 `abortableStream` 能从它那里脱身。 */
const hanging = (): AsyncIterable<ProviderStreamEvent> =>
  (async function* (): AsyncIterable<ProviderStreamEvent> {
    await new Promise<void>(() => {})
    yield { type: 'message_end', stopReason: 'end_turn', usage: USAGE }
  })()

/** 一条只会吐一段文本的假上游。返回捕获到的请求，断言用。 */
function fakeUpstream(text: string, over: Partial<GoalEvaluatorPort> = {}): {
  port: GoalEvaluatorPort
  requests: CanonicalRequest[]
} {
  const requests: CanonicalRequest[] = []
  const port: GoalEvaluatorPort = {
    resolveModel: () => alias(),
    stream: (req) => {
      requests.push(req)
      return complete(text)
    },
    ...over
  }
  return { port, requests }
}

/** 按调用次数给剧本：第 n 次 `stream()` 走第 n 个脚本，越界就重复最后一个。 */
function scripted(
  scripts: readonly (() => AsyncIterable<ProviderStreamEvent>)[],
  contextWindow = 200_000
): { port: GoalEvaluatorPort; requests: CanonicalRequest[] } {
  const requests: CanonicalRequest[] = []
  const port: GoalEvaluatorPort = {
    resolveModel: () => alias(contextWindow),
    stream: (req) => {
      requests.push(req)
      const script = scripts[Math.min(requests.length - 1, scripts.length - 1)]
      return script === undefined ? complete('') : script()
    }
  }
  return { port, requests }
}

/** 请求里发出去的那段 prompt（system 之外唯一的一条消息）。 */
function promptOf(request: CanonicalRequest | undefined): string {
  const part = request?.messages[0]?.parts[0]
  return part?.type === 'text' ? part.text : ''
}

const history: AgentMessage[] = [
  userMessage('u1', [{ type: 'text', text: '把测试修好' }], 1),
  assistantMessage('a1', [{ type: 'text', text: 'bun test 全绿了' }], 2)
]

const base = {
  model: 'judge',
  fallbackModel: 'main',
  question: '达成了吗？',
  messages: history,
  context: { workspaceId: 'w1' },
  signal: new AbortController().signal,
  now: (): number => 1
}

describe('evaluateGoal · 四种结论', () => {
  it('ok:true → met', async () => {
    const { port } = fakeUpstream('{"ok":true,"reason":"bun test 全绿了"}')
    await expect(evaluateGoal({ ...base, upstream: port })).resolves.toEqual({
      kind: 'met',
      reason: 'bun test 全绿了'
    })
  })

  it('ok:false → not_met', async () => {
    const { port } = fakeUpstream('{"ok":false,"reason":"还有两个红的"}')
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('not_met')
  })

  it('impossible → impossible', async () => {
    const { port } = fakeUpstream('{"ok":false,"impossible":true,"reason":"那个包不存在"}')
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('impossible')
  })

  it('★ 垃圾输出 → skipped{error}，不是 not_met', async () => {
    const { port } = fakeUpstream('大概可以了吧')
    await expect(evaluateGoal({ ...base, upstream: port })).resolves.toEqual({
      kind: 'skipped',
      reason: 'error'
    })
  })
})

describe('evaluateGoal · 请求形状', () => {
  it('★ 无工具、禁思考、1024 输出，system 逐字是判定器那一份', async () => {
    const { port, requests } = fakeUpstream('{"ok":true}')
    await evaluateGoal({ ...base, upstream: port })
    expect(requests[0]?.tools).toEqual([])
    expect(requests[0]?.thinkingLevel).toBe('off')
    expect(requests[0]?.maxOutputTokens).toBe(1024)
    expect(requests[0]?.system).toBe(GOAL_EVALUATOR_SYSTEM)
    expect(requests[0]?.messages).toHaveLength(1)
  })

  it('判定模型为空时按**成对**的回落：模型和 providerId 一起换成 run 那一对', async () => {
    const seen: Array<[string, string | undefined]> = []
    const { port, requests } = fakeUpstream('{"ok":true}', {
      resolveModel: (model, providerId) => {
        seen.push([model, providerId])
        return alias()
      }
    })
    await evaluateGoal({
      ...base,
      upstream: port,
      model: '   ',
      modelProviderId: 'p-judge',
      fallbackModel: 'main',
      fallbackModelProviderId: 'p-run'
    })
    expect(seen).toEqual([['main', 'p-run']])
    expect(requests[0]?.model).toBe('main')
    expect(requests[0]?.modelProviderId).toBe('p-run')
  })

  it('指定了判定模型时用它的 providerId，不串到 run 那一对上', async () => {
    const { port, requests } = fakeUpstream('{"ok":true}')
    await evaluateGoal({
      ...base,
      upstream: port,
      model: 'judge',
      modelProviderId: 'p-judge',
      fallbackModel: 'main',
      fallbackModelProviderId: 'p-run'
    })
    expect(requests[0]?.model).toBe('judge')
    expect(requests[0]?.modelProviderId).toBe('p-judge')
  })

  it('连 run 模型都没有 → skipped{no_model}，一次请求都不发', async () => {
    const { port, requests } = fakeUpstream('{"ok":true}')
    await expect(evaluateGoal({ ...base, upstream: port, model: '', fallbackModel: '' }))
      .resolves.toEqual({ kind: 'skipped', reason: 'no_model' })
    expect(requests).toHaveLength(0)
  })

  it('别名表里查不到 → skipped{no_model}', async () => {
    const { port } = fakeUpstream('{"ok":true}', { resolveModel: () => undefined })
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('skipped')
  })

  it('转录为空 → skipped{transcript_empty}（防御性）', async () => {
    const { port } = fakeUpstream('{"ok":true}')
    await expect(evaluateGoal({ ...base, upstream: port, messages: [] }))
      .resolves.toEqual({ kind: 'skipped', reason: 'transcript_empty' })
  })

  it('★ 整条转录只有 UI-only 的块（thinking / goal_status）→ 一次请求都不发', async () => {
    const messages: AgentMessage[] = [
      assistantMessage(
        'a',
        [
          { type: 'thinking', text: '我觉得应该已经好了' },
          { type: 'goal_status', met: true, condition: '让测试全绿', reason: '我觉得好了' }
        ],
        1
      )
    ]
    const { port, requests } = fakeUpstream('{"ok":true}')
    await expect(evaluateGoal({ ...base, upstream: port, messages }))
      .resolves.toEqual({ kind: 'skipped', reason: 'transcript_empty' })
    expect(requests).toHaveLength(0)
  })
})

describe('evaluateGoal · 只有完整的回复才算数', () => {
  const json = '{"ok":true,"reason":"bun test 全绿了"}'

  it('★ 流断在半路（没有 message_end）→ skipped{error}，不是 met', async () => {
    const { port } = fakeUpstream(json, {
      stream: (req) => {
        void req
        return (async function* (): AsyncIterable<ProviderStreamEvent> {
          yield { type: 'text_delta', index: 0, text: json }
        })()
      }
    })
    await expect(evaluateGoal({ ...base, upstream: port })).resolves.toEqual({
      kind: 'skipped',
      reason: 'error'
    })
  })

  it('★ 止于 max_tokens（文本是完整的 JSON）→ skipped{error}', async () => {
    const { port } = fakeUpstream(json, {
      stream: () =>
        (async function* (): AsyncIterable<ProviderStreamEvent> {
          yield { type: 'text_delta', index: 0, text: json }
          yield { type: 'message_end', stopReason: 'max_tokens', usage: USAGE }
        })()
    })
    await expect(evaluateGoal({ ...base, upstream: port })).resolves.toEqual({
      kind: 'skipped',
      reason: 'error'
    })
  })

  it('★ 止于 tool_use（判定器根本没有工具）→ skipped{error}', async () => {
    const { port } = fakeUpstream(json, {
      stream: () =>
        (async function* (): AsyncIterable<ProviderStreamEvent> {
          yield { type: 'text_delta', index: 0, text: json }
          yield { type: 'message_end', stopReason: 'tool_use', usage: USAGE }
        })()
    })
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('skipped')
  })
})

describe('evaluateGoal · 中断与超时', () => {
  it('★ 调用前就已经中断 → 一次请求都不发', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { port, requests } = fakeUpstream('{"ok":true}')
    await expect(evaluateGoal({ ...base, upstream: port, signal: aborted.signal }))
      .resolves.toEqual({ kind: 'skipped', reason: 'error' })
    expect(requests).toHaveLength(0)
  })

  it('★ 上游挂住（生成器完全不看 signal）→ 到点 abort，skipped{timeout}', async () => {
    vi.useFakeTimers()
    try {
      const { port } = scripted([hanging])
      const promise = evaluateGoal({ ...base, upstream: port, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1001)
      await expect(promise).resolves.toEqual({ kind: 'skipped', reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 调用方中断正在跑的判定 → skipped{error}', async () => {
    const controller = new AbortController()
    const { port } = scripted([hanging])
    const promise = evaluateGoal({ ...base, upstream: port, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(promise).resolves.toEqual({ kind: 'skipped', reason: 'error' })
  })

  it('★ 已经吐出合法 JSON、随后调用方中断 → 绝不是 met', async () => {
    const controller = new AbortController()
    const { port } = fakeUpstream('', {
      stream: () =>
        (async function* (): AsyncIterable<ProviderStreamEvent> {
          yield { type: 'text_delta', index: 0, text: '{"ok":true,"reason":"测试全绿了"}' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: USAGE }
          // 结论还没落地就中断了 —— 那份材料是完整的，但这次判定已经不算数
          await new Promise((resolve) => setTimeout(resolve, 0))
          controller.abort()
        })()
    })
    await expect(evaluateGoal({ ...base, upstream: port, signal: controller.signal }))
      .resolves.toEqual({ kind: 'skipped', reason: 'error' })
  })
})

describe('evaluateGoal · 失败与重试', () => {
  it('上游报 context_length → 按更小预算重来一次', async () => {
    const { port, requests } = scripted([
      contextLengthError,
      () => complete('{"ok":true,"reason":"ok"}')
    ])
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('met')
    expect(requests).toHaveLength(2)
  })

  it('两次都 context_length → skipped{error}，不再第三次', async () => {
    const { port, requests } = scripted([contextLengthError])
    await expect(evaluateGoal({ ...base, upstream: port })).resolves.toEqual({
      kind: 'skipped',
      reason: 'error'
    })
    expect(requests).toHaveLength(2)
  })

  it('★ 非 context_length 的上游错误 → skipped{error}，**不**重试', async () => {
    const { port, requests } = scripted([
      () =>
        (async function* (): AsyncIterable<ProviderStreamEvent> {
          yield { type: 'error', error: { code: 'network', message: 'boom', retryable: true } }
        })()
    ])
    expect((await evaluateGoal({ ...base, upstream: port })).kind).toBe('skipped')
    expect(requests).toHaveLength(1)
  })

  it('★ 重试那一份**真的更小** —— 预算是 0.25 个窗口，不是重来一遍', async () => {
    const turns: AgentMessage[] = []
    for (let i = 0; i < 30; i++) {
      turns.push(userMessage(`u${String(i)}`, [{ type: 'text', text: 'x'.repeat(400) }], i))
    }
    const { port, requests } = scripted(
      [contextLengthError, () => complete('{"ok":true,"reason":"ok"}')],
      8_000
    )
    await evaluateGoal({ ...base, upstream: port, messages: turns })
    expect(requests).toHaveLength(2)
    const first = promptOf(requests[0])
    const second = promptOf(requests[1])
    expect(estimateTokens(second)).toBeLessThan(estimateTokens(first))
    // 两份都被裁过（30 条 400 字的拉丁文本，任何一份预算都装不下全部）
    expect(first).toContain('truncated')
    expect(second).toContain('truncated')
  })

  it('★ 两次尝试共用同一个墙钟 —— 重试不会把超时翻倍', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      const calls: number[] = []
      const port: GoalEvaluatorPort = {
        resolveModel: () => alias(),
        stream: () => {
          calls.push(Date.now() - startedAt)
          const first = calls.length === 1
          if (first) {
            return (async function* (): AsyncIterable<ProviderStreamEvent> {
              // 第一次耗掉 600ms 才报 context_length
              await new Promise((resolve) => setTimeout(resolve, 600))
              yield {
                type: 'error',
                error: { code: 'context_length', message: 'too long', retryable: false }
              }
            })()
          }
          return hanging()
        }
      }
      const promise = evaluateGoal({ ...base, upstream: port, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(600)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(2)
      // 只剩 400ms —— 第二次尝试挂住，到 1000ms 时整个判定就得结束
      await vi.advanceTimersByTimeAsync(401)
      await expect(promise).resolves.toEqual({ kind: 'skipped', reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('renderTranscript · 回合边界与预算', () => {
  /** 20 个回合，每回合 [user, assistant]，各自带一个可辨认的标记（MARK-A … MARK-T）。 */
  const markedTurns = (): AgentMessage[] => {
    const messages: AgentMessage[] = []
    for (let i = 0; i < 20; i++) {
      const mark = `MARK-${String.fromCharCode(65 + i)}`
      messages.push(userMessage(`u${String(i)}`, [{ type: 'text', text: `${mark} ${'x'.repeat(400)}` }], i))
      messages.push(assistantMessage(`a${String(i)}`, [{ type: 'text', text: `answer-${mark}` }], i))
    }
    return messages
  }

  it('装得下时一条都不裁，也不加前缀', () => {
    const text = renderTranscript(history, 100_000)
    expect(text).not.toContain('truncated')
    expect(text).toContain('把测试修好')
  })

  it('★ 裁掉的部分换成显式前缀，留下的是**最近的完整回合**', () => {
    const text = renderTranscript(markedTurns(), 560)
    expect(text).toContain("Earlier conversation truncated to fit the hook evaluator's context window")
    expect(text).toContain('earlier messages omitted')
    expect(text).toContain('insufficient evidence in transcript')
    // 最近那一回合整条都在（user 和它的 assistant 回复）
    expect(text).toContain('MARK-T')
    expect(text).toContain('answer-MARK-T')
    // 最早那几回合被裁掉
    expect(text).not.toContain('MARK-A')
    // ★ 留下的第一行永远是一个回合的起点，不是半截 tool_result
    expect(text.split('\n')[1]).toMatch(/^user: /)
  })

  it('★ 最新那一回合自己就装不下 → 整份转录都不发（不是发一份缺最新证据的旧转录）', () => {
    const messages: AgentMessage[] = [
      userMessage('u0', [{ type: 'text', text: 'MARK-EARLY' }], 1),
      assistantMessage('a0', [{ type: 'text', text: 'answer-EARLY' }], 2),
      userMessage('u1', [{ type: 'text', text: `MARK-LATE ${'x'.repeat(4_000)}` }], 3)
    ]
    const text = renderTranscript(messages, 200)
    expect(text).toContain('insufficient evidence in transcript')
    expect(text).not.toContain('MARK-LATE')
    expect(text).not.toContain('MARK-EARLY')
  })

  it('★ 预算连一条都装不下时也不发超长消息 —— evaluateGoal 直接 skipped', async () => {
    const messages: AgentMessage[] = [
      userMessage('u0', [{ type: 'text', text: 'MARK-EARLY' }], 1),
      assistantMessage('a0', [{ type: 'text', text: 'answer-EARLY' }], 2),
      userMessage('u1', [{ type: 'text', text: `MARK-LATE ${'x'.repeat(4_000)}` }], 3)
    ]
    // 窗口小到 0.5 的那个预算连最新那一轮（约 1000 词元）都装不下 —— 而且此时
    // 更早那一轮**是**装得下的，留下的却是空：宁可整份不发，也不发一份缺最新证据的
    const { port, requests } = fakeUpstream('{"ok":true}', {
      resolveModel: () => alias(3_000)
    })
    await expect(evaluateGoal({ ...base, upstream: port, messages }))
      .resolves.toEqual({ kind: 'skipped', reason: 'transcript_empty' })
    expect(requests).toHaveLength(0)
  })

  it('★ 按 estimateTokens 算，不按 chars/4 —— 中文一个字就是一个词元', () => {
    const cjk = (n: number): AgentMessage[] => [
      userMessage('u', [{ type: 'text', text: '好'.repeat(n) }], 1)
    ]
    const latin = (n: number): AgentMessage[] => [
      userMessage('u', [{ type: 'text', text: 'x'.repeat(n) }], 1)
    ]
    // 同样 200 个字符：拉丁装得下，中文装不下（202 > 100）
    expect(renderTranscript(latin(200), 100)).toContain('x')
    expect(renderTranscript(cjk(200), 100)).not.toContain('好')
    expect(renderTranscript(cjk(200), 300)).toContain('好')
  })

  it('保留的是**最近**那几条，不是最早那几条', () => {
    const messages = [
      userMessage('old', [{ type: 'text', text: `很久以前 ${'x'.repeat(400)}` }], 1),
      userMessage('new', [{ type: 'text', text: '刚刚说的话' }], 2)
    ]
    const text = renderTranscript(messages, 100)
    expect(text).toContain('刚刚说的话')
    expect(text).toContain('truncated')
    expect(text).not.toContain('很久以前')
  })

  it('★ thinking 不进判定器 —— 模型的草稿不该被当成证据', () => {
    const messages = [
      assistantMessage(
        'a',
        [
          { type: 'thinking', text: '我觉得应该已经好了' },
          { type: 'text', text: '改完了' }
        ],
        1
      )
    ]
    const text = renderTranscript(messages, 100_000)
    expect(text).not.toContain('我觉得应该已经好了')
    expect(text).toContain('改完了')
  })

  it('goal_status 也不进 —— 那是我们自己盖的章', () => {
    const messages = [
      assistantMessage(
        'a',
        [
          { type: 'text', text: '改完了' },
          { type: 'goal_status', met: false, condition: '让测试全绿', reason: '还红着' }
        ],
        1
      )
    ]
    expect(renderTranscript(messages, 100_000)).not.toContain('还红着')
  })

  it('工具调用与结果进判定器 —— 它们才是证据', () => {
    const messages = [
      assistantMessage('a', [{ type: 'tool_call', callId: 'c1', name: 'Bash', input: { command: 'bun test' } }], 1),
      userMessage('u', [{ type: 'tool_result', callId: 'c1', output: { content: '12 pass, 0 fail' }, isError: false }], 2)
    ]
    const text = renderTranscript(messages, 100_000)
    expect(text).toContain('bun test')
    expect(text).toContain('12 pass, 0 fail')
  })

  it('★ 工具结果带上 callId 与错误状态 —— 证据要能归因到那一次调用', () => {
    const messages = [
      assistantMessage('a', [{ type: 'tool_call', callId: 'call-7', name: 'Bash', input: { command: 'bun test' } }], 1),
      userMessage('u', [{ type: 'tool_result', callId: 'call-7', output: { content: '1 fail' }, isError: true }], 2)
    ]
    const text = renderTranscript(messages, 100_000)
    expect(text).toContain('call-7')
    expect(text).toContain('[error]')
    expect(text).toContain('1 fail')
  })

  it('file_ref 只带路径 —— 附件本身送不进判定器', () => {
    const messages = [
      userMessage('u', [{ type: 'file_ref', path: '/tmp/report.txt', name: 'report.txt' }], 1),
      assistantMessage('a', [{ type: 'text', text: '看过了' }], 2)
    ]
    const text = renderTranscript(messages, 100_000)
    expect(text).toContain('/tmp/report.txt')
    expect(text).toContain('看过了')
  })
})
