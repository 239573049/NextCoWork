/**
 * 回合末判定那道缝（`SessionDeps.onTurnEnd`）。
 *
 * ★ 单开一个文件，不往 `agent-session.test.ts` 里塞：那个文件已经是整套回归网的
 *   主干，而这里要测的是一条**会让循环再跑一轮**的新路径 —— 它最容易出的错
 *   （回调抛异常变成死循环、`goal_status` 变成一条零内容块的上行消息）
 *   都需要自己的夹具。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../shared/agent/event'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import type { RunRequest } from '../../../shared/agent/run-request'
import type { ProviderStreamEvent } from '../../../shared/agent/stream'
import { toolOk } from '../../../shared/agent/tool'
import type { ModelAlias } from '../../../shared/domain/provider'
import { AgentSession, type SessionDeps, type SessionUpstream, type TurnEndResult } from '../agent-session'
import { nodeHost } from '../host'
import { collect, RunHandle } from '../run-registry'
import { ToolRegistry } from '../tool/registry'
import { toAnthropicMessages } from '../upstream/encode/anthropic'
import { toOpenAIChatMessages } from '../upstream/encode/openai-chat'
import { toOpenAIResponsesInput } from '../upstream/encode/openai-responses'
import { estimateMessages } from '../context-assembler'

const ALIAS: ModelAlias = {
  alias: 'claude-sonnet-4',
  providerId: 'p1',
  upstreamModel: 'claude-sonnet-4-20250514',
  capabilities: { tools: true, vision: true, thinking: true, caching: true },
  contextWindow: 200_000,
  maxOutputTokens: 8192
}

function req(over: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    depth: 0,
    input: [{ type: 'text', text: '把测试修好' }],
    mode: 'normal',
    thinking: 'off',
    webSearch: false,
    permissionMode: 'ask',
    model: 'claude-sonnet-4',
    skillIds: [],
    ...over
  }
}

const END = (stopReason: 'end_turn' | 'tool_use' = 'end_turn'): ProviderStreamEvent => ({
  type: 'message_end',
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 }
})

const says = (text: string): ProviderStreamEvent[] => [
  { type: 'message_start', model: 'claude-sonnet-4' },
  { type: 'text_delta', index: 0, text },
  END()
]

const callsTool = (callId: string): ProviderStreamEvent[] => [
  { type: 'message_start', model: 'claude-sonnet-4' },
  { type: 'tool_call_start', index: 0, callId, name: 'Echo' },
  { type: 'tool_call_delta', index: 0, callId, argsDelta: '{}' },
  { type: 'tool_call_end', index: 0, callId },
  END('tool_use')
]

function fakeUpstream(turns: ProviderStreamEvent[][]): SessionUpstream & { turns: number } {
  let i = 0
  const upstream = {
    get turns(): number { return i },
    listModels: () => [ALIAS],
    resolveModel: (model: string) => (model === ALIAS.alias ? ALIAS : undefined),
     
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      const script = turns[Math.min(i, turns.length - 1)]
      i++
      for (const ev of script ?? []) yield ev
    }
  }
  return upstream as SessionUpstream & { turns: number }
}

function echoRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register({
    internalId: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object' },
    readOnly: true,
    destructive: false,
    needsNetwork: false,
    source: { kind: 'builtin' },
    execute: (input) => Promise.resolve(toolOk(JSON.stringify(input)))
  })
  return r
}

async function runWith(o: {
  turns: ProviderStreamEvent[][]
  onTurnEnd?: SessionDeps['onTurnEnd']
  setup?: (handle: RunHandle) => void
  request?: RunRequest
}): Promise<{ events: AgentEvent[]; history: readonly AgentMessage[]; upstreamTurns: number }> {
  const request = o.request ?? req()
  const handle = new RunHandle(request)
  o.setup?.(handle)
  const upstream = fakeUpstream(o.turns)
  const session = new AgentSession(
    {
      host: nodeHost({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }),
      upstream,
      tools: echoRegistry(),
      workspaceRoot: '/ws',
      resumeDelaysMs: [],
      ...(o.onTurnEnd === undefined ? {} : { onTurnEnd: o.onTurnEnd })
    },
    handle,
    request
  )
  const events = collect(handle)
  await session.run()
  return { events: await events, history: session.history, upstreamTurns: upstream.turns }
}

const finish: TurnEndResult = { kind: 'finish' }
const keepGoing: TurnEndResult = { kind: 'continue', inject: [{ type: 'text', text: 'Continue working.' }] }

describe('onTurnEnd · 续跑与收尾', () => {
  it('does not commit an empty continuation or repeat the same request', async () => {
    const result = await runWith({ turns: [says('done')], onTurnEnd: async () => ({ kind: 'continue' }) })
    expect(result.upstreamTurns).toBe(1)
    expect(result.history.some((message) => message.internal)).toBe(false)
  })

  it('honors an abort during stop evaluation before committing feedback', async () => {
    let handle: RunHandle | undefined
    const result = await runWith({
      turns: [says('done')], setup: (h) => { handle = h },
      onTurnEnd: async () => { handle!.abort({ by: 'user' }); return keepGoing }
    })
    expect(result.upstreamTurns).toBe(1)
    expect(handle?.status).toBe('aborted')
    expect(result.history.some((message) => message.internal)).toBe(false)
  })

  it('consumes a background result received during a deferred finish', async () => {
    let handle: RunHandle | undefined
    let checks = 0
    const result = await runWith({
      turns: [says('waiting'), says('used the findings')], setup: (h) => { handle = h },
      onTurnEnd: async () => {
        if (++checks > 1) return finish
        handle!.enqueueInternal({ id: 'background-result', internal: true, parts: [{ type: 'text', text: 'verified findings' }] })
        return { kind: 'finish', acceptPendingInput: true }
      }
    })
    expect(result.upstreamTurns).toBe(2)
    expect(result.history.find((message) => message.id === 'background-result')).toMatchObject({
      internal: true, parts: [{ type: 'text', text: 'verified findings' }]
    })
  })
  it('不装配时行为与以前逐字一致 —— 一轮说完就收工', async () => {
    const { upstreamTurns, history } = await runWith({ turns: [says('好了')] })
    expect(upstreamTurns).toBe(1)
    expect(history.some((m) => m.internal === true)).toBe(false)
  })

  it('返回 finish 时正常收尾', async () => {
    const { upstreamTurns } = await runWith({
      turns: [says('好了')],
      onTurnEnd: () => Promise.resolve(finish)
    })
    expect(upstreamTurns).toBe(1)
  })

  it('★ 返回 continue 时提交一条 internal 用户消息并再请求一次', async () => {
    let asked = 0
    const { upstreamTurns, history } = await runWith({
      turns: [says('第一轮'), says('第二轮')],
      onTurnEnd: () => {
        asked += 1
        return Promise.resolve(
          asked === 1
            ? { kind: 'continue', inject: [{ type: 'text', text: 'Stop hook feedback:\n[让测试全绿]: 还红着' }] }
            : finish
        )
      }
    })
    expect(upstreamTurns).toBe(2)
    const injected = history.filter((m) => m.internal === true)
    expect(injected).toHaveLength(1)
    // ★ internal:它是协作消息，不该出现在聊天气泡里
    expect(injected[0]?.role).toBe('user')
    expect(injected[0]?.parts[0]).toEqual({ type: 'text', text: 'Stop hook feedback:\n[让测试全绿]: 还红着' })
  })

  it('★★ 回调抛异常时按正常收尾，不是死循环 —— 它每一轮 end_turn 都会被调用', async () => {
    const { upstreamTurns } = await runWith({
      turns: [says('好了')],
      onTurnEnd: () => Promise.reject(new Error('判定器炸了'))
    })
    expect(upstreamTurns).toBe(1)
  })

  it('子 run 不装配这条缝（depth > 0 时 deps 里压根没有它）', async () => {
    const seen: boolean[] = []
    await runWith({
      turns: [says('好了')],
      request: req({ depth: 1, parentRunId: 'run-0' }),
      onTurnEnd: (input) => { seen.push(input.isSubagent); return Promise.resolve(finish) }
    })
    // 装了就会被调到，`isSubagent` 必须如实反映 —— 生产侧靠**不装配**来隔离。
    expect(seen).toEqual([true])
  })
})

describe('onTurnEnd · 刹车计数', () => {
  it('★ 带工具的回合把 stoppedTurnStreak 清零，`toolCallsThisRun` 累加', async () => {
    const seen: Array<{ tools: number; streak: number }> = []
    const active: Array<boolean | undefined> = []
    let asked = 0
    await runWith({
      // 第 1 轮空转 → continue；第 2 轮调工具 → 工具结果后第 3 轮说话
      turns: [says('嗯'), callsTool('c1'), says('好了')],
      onTurnEnd: (input) => {
        asked += 1
        seen.push({ tools: input.toolCallsThisRun, streak: input.stoppedTurnStreak })
        active.push(input.stopHookActive)
        return Promise.resolve(asked === 1 ? keepGoing : finish)
      }
    })
    expect(seen[0]).toEqual({ tools: 0, streak: 0 })
    // 第二次询问发生在工具跑完之后：调过 1 次工具，而空转计数被清零了
    expect(seen[1]).toEqual({ tools: 1, streak: 0 })
    expect(active).toEqual([false, true])
  })

  it('连续空转时 streak 一轮一轮涨', async () => {
    const streaks: number[] = []
    let asked = 0
    await runWith({
      turns: [says('嗯')],
      onTurnEnd: (input) => {
        asked += 1
        streaks.push(input.stoppedTurnStreak)
        return Promise.resolve(asked < 3 ? keepGoing : finish)
      }
    })
    expect(streaks).toEqual([0, 1, 2])
  })
})

describe('goal_status · 只在 UI 那一轨', () => {
  const goalStatus: Extract<ContentPart, { type: 'goal_status' }> = {
    type: 'goal_status',
    met: true,
    condition: '让测试全绿',
    reason: 'bun test 退出码 0'
  }

  it('挂在最后一条助手消息上，不新增一条消息', async () => {
    const { history } = await runWith({
      turns: [says('好了')],
      onTurnEnd: () => Promise.resolve({ kind: 'finish' as const, goalStatus })
    })
    const last = history.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.parts.filter((p) => p.type === 'goal_status')).toHaveLength(1)
    // 转录里总共就两条：用户那句 + 助手那句
    expect(history).toHaveLength(2)
  })

  it('★★ 上行消息数不变 —— 它编码成 null，单独成一条就是一条零内容块的 400', async () => {
    const withGoal = await runWith({
      turns: [says('好了')],
      onTurnEnd: () => Promise.resolve({ kind: 'finish' as const, goalStatus })
    })
    const without = await runWith({ turns: [says('好了')] })
    expect(estimateMessages(withGoal.history)).toBe(estimateMessages(without.history))
    for (const encode of [toAnthropicMessages, toOpenAIChatMessages, toOpenAIResponsesInput]) {
      expect(encode(withGoal.history)).toEqual(encode(without.history))
    }
    const encodedWith = toAnthropicMessages(withGoal.history)
    const encodedWithout = toAnthropicMessages(without.history)
    expect(encodedWith).toHaveLength(encodedWithout.length)
    // 而且每一条都还有内容块 —— 空 content 的消息会被上游 400
    for (const message of encodedWith) {
      expect((message.content as unknown[]).length).toBeGreaterThan(0)
    }
  })

  it('最后一条不是助手消息时放弃挂载，不抛 —— 那一轮本来什么都没发生', async () => {
    const check = vi.fn(() => Promise.resolve({ kind: 'finish' as const, goalStatus }))
    const { history } = await runWith({
      // No assistant content was produced: the last message really is the user input.
      turns: [[{ type: 'message_start', model: ALIAS.alias }, END()]],
      onTurnEnd: check
    })
    expect(check).toHaveBeenCalledOnce()
    expect(history).toHaveLength(1)
    expect(history[0]?.role).toBe('user')
    expect(history.every((m) => m.parts.every((p) => p.type !== 'goal_status'))).toBe(true)
  })

  it('warning 走独立通知，不冒充工具或上游错误', async () => {
    const { history, events } = await runWith({
      turns: [says('好了')],
      onTurnEnd: () => Promise.resolve({
        kind: 'finish' as const,
        goalStatus,
        warning: { code: 'unknown' as const, message: '空转太多了', retryable: false, messageKey: 'goal.warn.idleStreak' }
      })
    })
    const parts = history.at(-1)?.parts ?? []
    expect(parts.some((p) => p.type === 'goal_status')).toBe(true)
    expect(parts.some((p) => p.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'notification')).toMatchObject({
      type: 'notification', warning: { messageKey: 'goal.warn.idleStreak' }
    })
  })
})
