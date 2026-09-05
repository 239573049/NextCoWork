import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../shared/agent/event'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import { assistantMessage, userMessage } from '../../../shared/agent/message'
import type { RunRequest } from '../../../shared/agent/run-request'
import { MAX_TURNS } from '../../../shared/agent/run-request'
import type { ProviderStreamEvent } from '../../../shared/agent/stream'
import type { ToolResult, ToolSource } from '../../../shared/agent/tool'
import { toolOk } from '../../../shared/agent/tool'
import type { ModelAlias } from '../../../shared/domain/provider'
import {
  AgentSession,
  type ApproveFn,
  type SessionDeps,
  type SessionUpstream
} from '../agent-session'
import { nodeHost } from '../host'
import { collect, RunHandle } from '../run-registry'
import { ToolRegistry, type ToolContext } from '../tool/registry'
import type { CanonicalRequest, UpstreamRequestContext } from '../upstream/canonical'

// ─────────────────────────── 夹具 ───────────────────────────

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
    input: [{ type: 'text', text: '你好' }],
    mode: 'normal',
    thinking: 'off',
    webSearch: false,
    permissionMode: 'ask',
    model: 'claude-sonnet-4',
    skillIds: [],
    ...over
  }
}

/** 安静的 host —— 会话在若干路径上会 warn/error,测试里不需要看 */
function quietHost(): ReturnType<typeof nodeHost> {
  return nodeHost({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
}

interface FakeUpstream extends SessionUpstream {
  /** 每一轮实际发出去的请求 —— 断言工具列表、消息累积都靠它 */
  readonly requests: CanonicalRequest[]
  /** 每一轮独立传递的运行上下文 —— 不应混进 CanonicalRequest。 */
  readonly contexts: UpstreamRequestContext[]
}

/**
 * 按轮次脚本化的假上游。
 *
 * ★ 这个十几行的假对象就是 `SessionUpstream` 存在的理由(见 agent-session.ts):
 * 整个循环能在不搭供应商、不搭凭证、不搭健康表的情况下跑完。
 */
function fakeUpstream(
  turns: ProviderStreamEvent[][],
  opts: { models?: ModelAlias[] } = {}
): FakeUpstream {
  const requests: CanonicalRequest[] = []
  const contexts: UpstreamRequestContext[] = []
  let i = 0
  return {
    requests,
    contexts,
    listModels: () => opts.models ?? [ALIAS],
    async *stream(
      r,
      _signal,
      context
    ): AsyncIterable<ProviderStreamEvent> {
      requests.push(r)
      contexts.push(context)
      // 轮次用尽就重复最后一段 —— MAX_TURNS 那条测试要跑满 25 轮
      const script = turns[Math.min(i, turns.length - 1)]
      i++
      for (const ev of script ?? []) yield ev
    }
  }
}

const END = (stopReason: 'end_turn' | 'tool_use' = 'end_turn'): ProviderStreamEvent => ({
  type: 'message_end',
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 }
})

/** 说一句话就收工 */
function says(text: string): ProviderStreamEvent[] {
  return [
    { type: 'message_start', model: 'claude-sonnet-4' },
    { type: 'text_delta', index: 0, text },
    END()
  ]
}

/** 调一次工具 */
function callsTool(callId: string, name: string, args = '{}'): ProviderStreamEvent[] {
  return [
    { type: 'message_start', model: 'claude-sonnet-4' },
    { type: 'tool_call_start', index: 0, callId, name },
    { type: 'tool_call_delta', index: 0, callId, argsDelta: args },
    { type: 'tool_call_end', index: 0, callId },
    END('tool_use')
  ]
}

interface Registered {
  internalId: string
  readOnly?: boolean
  destructive?: boolean
  needsNetwork?: boolean
  source?: ToolSource
  execute?: (input: unknown, ctx: ToolContext) => Promise<ToolResult>
}

function registry(...tools: Registered[]): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of tools) {
    r.register({
      internalId: t.internalId,
      description: `${t.internalId} 工具`,
      inputSchema: { type: 'object' },
      readOnly: t.readOnly ?? true,
      destructive: t.destructive ?? false,
      needsNetwork: t.needsNetwork ?? false,
      source: t.source ?? { kind: 'builtin' },
      execute: t.execute ?? ((input) => Promise.resolve(toolOk(JSON.stringify(input))))
    })
  }
  return r
}

interface Ran {
  events: AgentEvent[]
  history: readonly AgentMessage[]
  handle: RunHandle
  upstream: FakeUpstream
}

async function runSession(o: {
  upstream: FakeUpstream
  tools?: ToolRegistry
  request?: RunRequest
  history?: readonly AgentMessage[]
  approve?: ApproveFn
  onToolUsage?: SessionDeps['onToolUsage']
}): Promise<Ran> {
  const request = o.request ?? req()
  const handle = new RunHandle(request)
  const session = new AgentSession(
    {
      host: quietHost(),
      upstream: o.upstream,
      tools: o.tools ?? registry(),
      workspaceRoot: '/ws',
      ...(o.history !== undefined ? { history: o.history } : {}),
      ...(o.approve !== undefined ? { approve: o.approve } : {}),
      ...(o.onToolUsage !== undefined ? { onToolUsage: o.onToolUsage } : {})
    },
    handle,
    request
  )
  // ★ 订阅在前、启动在后 —— 与渲染层的时序一致(方案 §3 规则 2)
  const events = collect(handle)
  await session.run()
  return { events: await events, history: session.history, handle, upstream: o.upstream }
}

// 便捷断言
const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.type)
const commits = (events: AgentEvent[]): AgentMessage[] =>
  events.flatMap((e) => (e.type === 'message_commit' ? [e.message] : []))
const partsOf = (ms: readonly AgentMessage[]): ContentPart[] => ms.flatMap((m) => m.parts)
const runEnd = (events: AgentEvent[]): Extract<AgentEvent, { type: 'run_end' }> => {
  const e = events.at(-1)
  if (e?.type !== 'run_end') throw new Error(`最后一个事件不是 run_end,而是 ${e?.type}`)
  return e
}

/**
 * ★ 全套测试共用的那条不变式:**每个 tool_call 都必须有配对的 tool_result**。
 *
 * Anthropic 要求 tool_use 在紧随的 user 消息里配对;违反它下一轮就是 400,
 * 而报错会指向消息数组,看起来像 adapter 的 bug(方案 §4.8)。
 */
function expectNoOrphans(history: readonly AgentMessage[]): void {
  const opened = new Set<string>()
  const closed = new Set<string>()
  for (const p of partsOf(history)) {
    if (p.type === 'tool_call') opened.add(p.callId)
    else if (p.type === 'tool_result') closed.add(p.callId)
  }
  expect([...opened].filter((c) => !closed.has(c)), '孤儿 tool_call').toEqual([])
  expect([...closed].filter((c) => !opened.has(c)), '无主 tool_result').toEqual([])
}

// ─────────────────────────── 最简一轮 ───────────────────────────

describe('单轮对话', () => {
  it('说一句话就正常收尾', async () => {
    const { events, history } = await runSession({ upstream: fakeUpstream([says('你好呀')]) })

    expect(runEnd(events).status).toBe('done')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '你好' }] })
    expect(history[1]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: '你好呀' }]
    })
  })

  it('使用 RunRequest 提供的用户消息 ID提交首条输入', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([says('收到')]),
      request: req({ inputMessageId: 'input-message-1' })
    })

    expect(history[0]?.id).toBe('input-message-1')
    expect(commits(events)[0]?.id).toBe('input-message-1')
  })

  it('将 RunRequest 的运行标识原样放在独立上下文中传给上游', async () => {
    const workspaceId = 'ws-opaque-tenant-123'
    const runId = 'run-opaque-456'
    const sessionId = 'session-opaque-789'
    const { upstream } = await runSession({
      upstream: fakeUpstream([says('收到')]),
      request: req({ workspaceId, runId, sessionId })
    })

    expect(upstream.contexts).toEqual([{ workspaceId, runId, sessionId }])
    expect(upstream.requests[0]).not.toHaveProperty('workspaceId')
    expect(upstream.requests[0]).not.toHaveProperty('runId')
    expect(upstream.requests[0]).not.toHaveProperty('sessionId')
  })

  it('每个上游事件都原样转发给 UI', async () => {
    const { events } = await runSession({ upstream: fakeUpstream([says('嗨')]) })
    const streamed = events.flatMap((e) => (e.type === 'stream' ? [e.delta.type] : []))
    expect(streamed).toEqual(['message_start', 'text_delta', 'message_end'])
  })

  /** ★ 压力条要在这一轮真的挤爆**之前**就让用户看见(方案 §4.12) */
  it('context_usage 在第一个 delta 之前发出', async () => {
    const { events } = await runSession({ upstream: fakeUpstream([says('嗨')]) })
    const usage = kinds(events).indexOf('context_usage')
    const firstStream = kinds(events).indexOf('stream')
    expect(usage).toBeGreaterThanOrEqual(0)
    expect(usage).toBeLessThan(firstStream)
  })

  it('context_usage 带上窗口大小与压缩判断', async () => {
    const { events } = await runSession({ upstream: fakeUpstream([says('嗨')]) })
    const u = events.find((e) => e.type === 'context_usage')
    expect(u).toMatchObject({ window: 200_000, shouldCompact: false })
    expect(u?.type === 'context_usage' && u.used).toBeGreaterThan(0)
  })

  /** 空 input = 续跑(排队消息之外的场景) */
  it('空 input 不追加用户消息', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([says('接着说')]),
      request: req({ input: [] }),
      history: [userMessage('old', [{ type: 'text', text: '之前的问题' }], 1)]
    })
    expect(history.map((m) => m.id)).toEqual(['old', expect.any(String)])
  })

  it('已有转录被带进请求', async () => {
    const past = [
      userMessage('u0', [{ type: 'text', text: '第一句' }], 1),
      assistantMessage('a0', [{ type: 'text', text: '第一答' }], 2)
    ]
    const { upstream } = await runSession({
      upstream: fakeUpstream([says('第二答')]),
      history: past
    })
    expect(upstream.requests[0]?.messages.map((m) => m.id)).toEqual([
      'u0',
      'a0',
      expect.any(String)
    ])
  })

  /** ★ session 不持久化,只把结果留在 history 里 —— 但不能改调用方那份数组 */
  it('不修改传入的 history', async () => {
    const past: AgentMessage[] = [userMessage('u0', [{ type: 'text', text: 'x' }], 1)]
    const { history } = await runSession({ upstream: fakeUpstream([says('y')]), history: past })
    expect(past).toHaveLength(1)
    expect(history.length).toBeGreaterThan(1)
  })

  it('一个字都没吐时不提交空消息', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([[{ type: 'message_start', model: 'm' }, END()]])
    })
    expect(runEnd(events).status).toBe('done')
    expect(history).toHaveLength(1) // 只有用户那条
  })
})

// ─────────────────────────── 工具循环 ───────────────────────────

describe('think → tool → observe 循环', () => {
  it('调用工具后带着结果再跑一轮', async () => {
    const { events, history, upstream } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m":"hi"}'), says('工具说了 hi')]),
      tools: registry({ internalId: 'echo' })
    })

    expect(runEnd(events).status).toBe('done')
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[2]?.parts[0]).toMatchObject({
      type: 'tool_result',
      callId: 'c1',
      isError: false
    })
    expect(upstream.requests).toHaveLength(2)
    expectNoOrphans(history)
  })

  it('工具结果回到了第二轮的请求里', async () => {
    const { upstream } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m":"hi"}'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    const second = upstream.requests[1]?.messages ?? []
    expect(
      second.flatMap((m) => m.parts).some((p) => p.type === 'tool_result' && p.callId === 'c1')
    ).toBe(true)
  })

  it('工具拿到解析后的入参', async () => {
    const seen: unknown[] = []
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m":"hi","n":3}'), says('好')]),
      tools: registry({
        internalId: 'echo',
        execute: (input) => {
          seen.push(input)
          return Promise.resolve(toolOk('ok'))
        }
      })
    })
    expect(seen).toEqual([{ m: 'hi', n: 3 }])
  })

  it('多个工具调用并行执行,结果仍按调用顺序合成一条消息', async () => {
    let active = 0
    let maxActive = 0
    const exec =
      (tag: string) =>
      async (): Promise<ReturnType<typeof toolOk>> => {
        active++
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active--
        return toolOk(tag)
      }

    const { history } = await runSession({
      upstream: fakeUpstream([
        [
          { type: 'tool_call_start', index: 0, callId: 'c1', name: 'a' },
          { type: 'tool_call_end', index: 0, callId: 'c1' },
          { type: 'tool_call_start', index: 1, callId: 'c2', name: 'b' },
          { type: 'tool_call_end', index: 1, callId: 'c2' },
          END('tool_use')
        ],
        says('都做完了')
      ]),
      tools: registry(
        { internalId: 'a', execute: exec('a') },
        { internalId: 'b', execute: exec('b') }
      )
    })

    expect(maxActive).toBe(2)
    const results = history[2]?.parts ?? []
    expect(results).toHaveLength(2)
    expect(results.every((p) => p.type === 'tool_result')).toBe(true)
    expectNoOrphans(history)
  })

  it('tool_start / tool_end 事件成对出现', async () => {
    const { events } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    expect(kinds(events).filter((k) => k.startsWith('tool_'))).toEqual(['tool_start', 'tool_end'])
  })

  /** ★ 审批弹窗、工具卡片、转录三条轨道上必须是同一个名字,用户才能把它们对上号 */
  it('tool_start 用的是 externalName,与转录里的名字一致', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    const start = events.find((e) => e.type === 'tool_start')
    const callPart = partsOf(history).find((p) => p.type === 'tool_call')
    expect(start?.type === 'tool_start' && start.toolName).toBe('echo')
    expect(callPart?.type === 'tool_call' && callPart.name).toBe('echo')
  })

  /**
   * ★ 上一条里 internalId 恰好等于 externalName,分不出两者。这条用一个真实的
   * MCP 长名字(`mcp__…__create_pull_request_review_comment` 超 64 字符)把它们拉开:
   * 三条轨道上出现的都必须是**模型看得见的那个名字**,否则审批弹窗显示的工具
   * 和转录里记的工具对不上号。
   */
  it('internalId 与 externalName 不同时,三处用的都是 externalName', async () => {
    const internalId = 'mcp__github-enterprise-internal__create_pull_request_review_comment'
    const tools = registry({ internalId, source: { kind: 'mcp', serverId: 'gh' } })
    const external = tools.snapshot()[0]?.externalName ?? ''
    expect(external).not.toBe(internalId)
    expect(external.length).toBeLessThanOrEqual(64)

    const { events, history, upstream } = await runSession({
      upstream: fakeUpstream([callsTool('c1', external), says('好')]),
      tools
    })

    expect(upstream.requests[0]?.tools[0]?.externalName).toBe(external)
    const start = events.find((e) => e.type === 'tool_start')
    expect(start?.type === 'tool_start' && start.toolName).toBe(external)
    const callPart = partsOf(history).find((p) => p.type === 'tool_call')
    expect(callPart?.type === 'tool_call' && callPart.name).toBe(external)
    expect(history[2]?.parts[0]).toMatchObject({ isError: false })
  })

  it('工具进度经 tool_progress 发出,且不进转录', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'slow'), says('好')]),
      tools: registry({
        internalId: 'slow',
        execute: (_i, ctx) => {
          ctx.emit({ callId: ctx.callId, message: '读取中', fraction: 0.5 })
          return Promise.resolve(toolOk('done'))
        }
      })
    })
    expect(events.some((e) => e.type === 'tool_progress')).toBe(true)
    expect(JSON.stringify(history)).not.toContain('读取中')
  })

  /** ★ ctx.signal 必须真的是 run 的 signal:只断 SSE 不断工具会留下僵尸进程(方案 §4.3) */
  it('工具拿到的是 run 的 signal', async () => {
    let sameSignal = false
    const request = req()
    const handle = new RunHandle(request)
    const session = new AgentSession(
      {
        host: quietHost(),
        upstream: fakeUpstream([callsTool('c1', 'probe'), says('好')]),
        tools: registry({
          internalId: 'probe',
          execute: (_i, ctx) => {
            sameSignal = ctx.signal === handle.signal
            return Promise.resolve(toolOk('ok'))
          }
        }),
        workspaceRoot: '/ws'
      },
      handle,
      request
    )
    await session.run()
    expect(sameSignal).toBe(true)
  })

  it('工具上下文带着权限档位与深度', async () => {
    let ctx: ToolContext | undefined
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'probe'), says('好')]),
      request: req({ permissionMode: 'full', depth: 1 }),
      tools: registry({
        internalId: 'probe',
        execute: (_i, c) => {
          ctx = c
          return Promise.resolve(toolOk('ok'))
        }
      })
    })
    expect(ctx).toMatchObject({ permissionMode: 'full', depth: 1, workspaceRoot: '/ws' })
  })
})

// ─────────────────────────── 工具错误 ───────────────────────────

describe('工具错误进转录并继续循环(方案 §4.11)', () => {
  it('模型编了个不存在的工具名', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'nonexistent'), says('哦')]),
      tools: registry({ internalId: 'echo' })
    })

    expect(runEnd(events).status).toBe('done')
    const result = history[2]?.parts[0]
    expect(result).toMatchObject({ type: 'tool_result', callId: 'c1', isError: true })
    expect(result?.type === 'tool_result' && result.output.content).toContain('nonexistent')
    expectNoOrphans(history)
  })

  /** ★ 只说「参数错了」模型无从下手 —— 得把它自己发出的原文还给它 */
  it('参数不是合法 JSON 时把原文回给模型', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m": '), says('我改一下')]),
      tools: registry({ internalId: 'echo' })
    })

    expect(runEnd(events).status).toBe('done')
    const result = history[2]?.parts[0]
    expect(result?.type === 'tool_result' && result.output.content).toContain('{"m": ')
    expectNoOrphans(history)
  })

  it('工具抛异常时收敛成工具错误,run 不挂', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'boom'), says('那算了')]),
      tools: registry({
        internalId: 'boom',
        execute: () => Promise.reject(new Error('磁盘满了'))
      })
    })

    expect(runEnd(events).status).toBe('done')
    const result = history[2]?.parts[0]
    expect(result).toMatchObject({ isError: true })
    expect(result?.type === 'tool_result' && result.output.content).toContain('磁盘满了')
    expectNoOrphans(history)
  })

  it('工具自己返回 isError 时照样回填并继续', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'fails'), says('知道了')]),
      tools: registry({
        internalId: 'fails',
        execute: () => Promise.resolve({ output: { content: '文件不存在' }, isError: true })
      })
    })
    expect(runEnd(events).status).toBe('done')
    expect(history[2]?.parts[0]).toMatchObject({ isError: true })
  })

  it('将工具调用数和真实失败数回填到产生调用的用量记录', async () => {
    const onToolUsage = vi.fn<NonNullable<SessionDeps['onToolUsage']>>()
    const script: ProviderStreamEvent[] = [
      { type: 'message_start', model: 'claude-sonnet-4' },
      { type: 'tool_call_start', index: 0, callId: 'c1', name: 'ok' },
      { type: 'tool_call_delta', index: 0, callId: 'c1', argsDelta: '{}' },
      { type: 'tool_call_end', index: 0, callId: 'c1' },
      { type: 'tool_call_start', index: 1, callId: 'c2', name: 'fails' },
      { type: 'tool_call_delta', index: 1, callId: 'c2', argsDelta: '{}' },
      { type: 'tool_call_end', index: 1, callId: 'c2' },
      END('tool_use')
    ]

    await runSession({
      upstream: fakeUpstream([script, says('知道了')]),
      tools: registry(
        { internalId: 'ok' },
        {
          internalId: 'fails',
          execute: () => Promise.resolve({ output: { content: '失败' }, isError: true })
        }
      ),
      onToolUsage
    })

    expect(onToolUsage).toHaveBeenCalledTimes(1)
    expect(onToolUsage).toHaveBeenCalledWith({
      runId: 'run-1',
      toolCalls: 2,
      toolErrors: 1
    })
  })

  /** 每一种工具错误都要发 tool_end,否则 UI 上那张卡片会永远转圈 */
  it('工具错误也发 tool_end', async () => {
    for (const script of [
      callsTool('c1', 'nope'),
      callsTool('c1', 'echo', '坏 JSON')
    ]) {
      const { events } = await runSession({
        upstream: fakeUpstream([script, says('好')]),
        tools: registry({ internalId: 'echo' })
      })
      const end = events.find((e) => e.type === 'tool_end')
      expect(end).toMatchObject({ callId: 'c1', isError: true })
    }
  })
})

// ─────────────────────────── 权限审批 ───────────────────────────

describe('审批接缝(方案 §4.5 / §4.6)', () => {
  it('没有 approve 时默认放行', async () => {
    const exec = vi.fn(() => Promise.resolve(toolOk('ran')))
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo', execute: exec })
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  /** ★ 拒绝要让模型**看见** —— 系统提示词里「被拒绝时不要试图绕开」的前提是它知道被拒了 */
  it('拒绝时不执行,理由回给模型', async () => {
    const exec = vi.fn(() => Promise.resolve(toolOk('不该跑')))
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'rm'), says('那我不删了')]),
      tools: registry({ internalId: 'rm', readOnly: false, destructive: true, execute: exec }),
      approve: () => Promise.resolve({ kind: 'deny', reason: '用户不同意删除' })
    })

    expect(exec).not.toHaveBeenCalled()
    expect(runEnd(events).status).toBe('done')
    const result = history[2]?.parts[0]
    expect(result?.type === 'tool_result' && result.output.content).toContain('用户不同意删除')
    expect(result).toMatchObject({ isError: true })
    expectNoOrphans(history)
  })

  it('没给理由时也有一句默认说明', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'rm'), says('好')]),
      tools: registry({ internalId: 'rm' }),
      approve: () => Promise.resolve({ kind: 'deny' })
    })
    const result = history[2]?.parts[0]
    expect(result?.type === 'tool_result' && result.output.content).toContain('denied')
  })

  /** 用原值执行等于无视用户的修改 */
  it('allow_edited 用改过的入参执行', async () => {
    const seen: unknown[] = []
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'bash', '{"cmd":"rm -rf /"}'), says('好')]),
      tools: registry({
        internalId: 'bash',
        execute: (input) => {
          seen.push(input)
          return Promise.resolve(toolOk('ok'))
        }
      }),
      approve: () => Promise.resolve({ kind: 'allow_edited', input: { cmd: 'ls' } })
    })
    expect(seen).toEqual([{ cmd: 'ls' }])
  })

  it('审批请求带齐 runId / callId / 工具与入参', async () => {
    const approve = vi.fn<ApproveFn>(() => Promise.resolve({ kind: 'allow_once' }))
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m":"x"}'), says('好')]),
      tools: registry({ internalId: 'echo' }),
      approve
    })
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        callId: 'c1',
        input: { m: 'x' },
        tool: expect.objectContaining({ externalName: 'echo' })
      })
    )
  })

  /** 审批发生在 tool_start 之后:UI 要先画出卡片,再在上面盖一个待决框 */
  it('tool_start 先于审批发出', async () => {
    const seenAt: string[] = []
    await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({
        internalId: 'echo',
        execute: () => {
          seenAt.push('execute')
          return Promise.resolve(toolOk('ok'))
        }
      }),
      approve: () => {
        seenAt.push('approve')
        return Promise.resolve({ kind: 'allow_once' })
      }
    })
    expect(seenAt).toEqual(['approve', 'execute'])
  })
})

// ─────────────────────────── 会话模式 ───────────────────────────

describe('会话模式落在工具层,不靠提示词祈祷(方案 §4.8)', () => {
  it('plan 模式下写工具不出现在请求里', async () => {
    const { upstream } = await runSession({
      upstream: fakeUpstream([says('这是我的方案')]),
      request: req({ mode: 'plan' }),
      tools: registry(
        { internalId: 'read_file', readOnly: true },
        { internalId: 'write_file', readOnly: false }
      )
    })
    expect(upstream.requests[0]?.tools.map((t) => t.externalName)).toEqual(['read_file'])
  })

  it('normal 模式下写工具在', async () => {
    const { upstream } = await runSession({
      upstream: fakeUpstream([says('好')]),
      tools: registry(
        { internalId: 'read_file', readOnly: true },
        { internalId: 'write_file', readOnly: false }
      )
    })
    expect(upstream.requests[0]?.tools.map((t) => t.externalName)).toEqual([
      'read_file',
      'write_file'
    ])
  })

  /** plan 模式下模型硬要调写工具,得到的是工具错误 —— 因为它根本不在本轮快照里 */
  it('plan 模式下调写工具会被当成未知工具', async () => {
    const exec = vi.fn(() => Promise.resolve(toolOk('不该跑')))
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'write_file'), says('好吧')]),
      request: req({ mode: 'plan' }),
      tools: registry({ internalId: 'write_file', readOnly: false, execute: exec })
    })
    expect(exec).not.toHaveBeenCalled()
    expect(history[2]?.parts[0]).toMatchObject({ isError: true })
  })

  /** ★ execute 是闭包,过不了结构化克隆 —— 请求体里不该带着它 */
  it('请求里的工具不带 execute', async () => {
    const { upstream } = await runSession({
      upstream: fakeUpstream([says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    expect(upstream.requests[0]?.tools[0]).not.toHaveProperty('execute')
    expect(() => structuredClone(upstream.requests[0]?.tools)).not.toThrow()
  })
})

describe('从异常中断的转录恢复', () => {
  it('在继续发送用户消息前补齐历史孤儿 tool_result，并保留可解释的错误原因', async () => {
    const now = 100
    const history = [
      userMessage('u0', [{ type: 'text', text: '执行任务' }], now),
      assistantMessage('a0', [{ type: 'tool_call', callId: 'call-orphan', name: 'read', input: {} }], now + 1)
    ]

    const { events, history: recovered, upstream } = await runSession({
      history,
      upstream: fakeUpstream([says('已恢复')]),
      request: req({ input: [{ type: 'text', text: '继续' }] })
    })

    expect(recovered.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant'])
    expect(recovered[2]?.parts[0]).toMatchObject({
      type: 'tool_result',
      callId: 'call-orphan',
      isError: true
    })
    expect(recovered[2]?.parts[0]?.type === 'tool_result'
      && recovered[2].parts[0].output.content).toContain('previous run ended')
    expect(upstream.requests[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_end', callId: 'call-orphan', isError: true
    }))
    expectNoOrphans(recovered)
  })
})

// ─────────────────────────── 中断:方案 §4.8 第 4 件 ───────────────────────────

describe('中断收尾', () => {
  /** 工具遵守 ctx.signal:一被触发就抛 AbortError(这正是真工具该有的样子) */
  const abortsDuringExecute =
    (handle: () => RunHandle) =>
    (_input: unknown, ctx: ToolContext): Promise<never> => {
      handle().abort({ by: 'user' })
      expect(ctx.signal.aborted).toBe(true)
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }

  async function runWithAbortingTool(o: {
    upstream: FakeUpstream
    tools: (handle: () => RunHandle) => ToolRegistry
    onToolUsage?: SessionDeps['onToolUsage']
  }): Promise<Ran> {
    const request = req()
    const handle = new RunHandle(request)
    const session = new AgentSession(
      {
        host: quietHost(),
        upstream: o.upstream,
        tools: o.tools(() => handle),
        workspaceRoot: '/ws',
        ...(o.onToolUsage !== undefined ? { onToolUsage: o.onToolUsage } : {})
      },
      handle,
      request
    )
    const events = collect(handle)
    await session.run()
    return { events: await events, history: session.history, handle, upstream: o.upstream }
  }

  /**
   * ★★ 本文件的核心断言 —— 方案 §4.8 五件事里的**第 4 件**。
   *
   * 漏掉它下一轮请求就是 400,而报错会指向消息数组,看起来像 adapter 的 bug。
   * 「这是手写 Agent 循环最常见的自伤。」
   */
  it('工具执行途中中断,未闭合的 tool_call 被补上 tool_result', async () => {
    const { events, history } = await runWithAbortingTool({
      upstream: fakeUpstream([callsTool('c1', 'slow')]),
      tools: (h) => registry({ internalId: 'slow', execute: abortsDuringExecute(h) })
    })

    expect(runEnd(events).status).toBe('aborted')
    expectNoOrphans(history)

    /**
     * 形状钉死:**只有一条**助手消息。收尾时若忘了把 `pending` 清空,
     * 半截回复会被提交两次 —— 转录里出现两个同 callId 的 tool_call,
     * 孤儿检查看不出来(它只比对集合),但下一轮上行就是重复的 tool_use。
     */
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])

    const result = partsOf(history).find((p) => p.type === 'tool_result')
    expect(result).toMatchObject({ callId: 'c1', isError: true })
    expect(result?.type === 'tool_result' && result.output.content).toContain('interrupted')
  })

  /** 没有这条,UI 上那张工具卡片会停在「执行中」直到下次重载 */
  it('补的 tool_result 也发 tool_end', async () => {
    const { events } = await runWithAbortingTool({
      upstream: fakeUpstream([callsTool('c1', 'slow')]),
      tools: (h) => registry({ internalId: 'slow', execute: abortsDuringExecute(h) })
    })
    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ callId: 'c1', isError: true })
  })

  /**
   * ★ `executeAll` 用 finally 而不是只在成功路径上提交,测的就是这条:
   * 中断发生在第 2 个工具执行途中时,第 1 个**已经真的做完了** ——
   * 不落进转录,它就会被当成孤儿补上一条「已中断」,做过的事被记成没做,
   * 而模型下一轮会据此重做一遍。
   */
  it('中断时已完成的工具结果保留原值,只有真没跑完的那个被标为中断', async () => {
    const onToolUsage = vi.fn<NonNullable<SessionDeps['onToolUsage']>>()
    const { history } = await runWithAbortingTool({
      upstream: fakeUpstream([
        [
          { type: 'tool_call_start', index: 0, callId: 'c1', name: 'fast' },
          { type: 'tool_call_end', index: 0, callId: 'c1' },
          { type: 'tool_call_start', index: 1, callId: 'c2', name: 'slow' },
          { type: 'tool_call_end', index: 1, callId: 'c2' },
          END('tool_use')
        ]
      ]),
      tools: (h) =>
        registry(
          { internalId: 'fast', execute: () => Promise.resolve(toolOk('第一个工具真的做完了')) },
          { internalId: 'slow', execute: abortsDuringExecute(h) }
        ),
      onToolUsage
    })

    expectNoOrphans(history)
    const results = partsOf(history).filter((p) => p.type === 'tool_result')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ callId: 'c1', isError: false })
    expect(results[0]?.type === 'tool_result' && results[0].output.content).toBe(
      '第一个工具真的做完了'
    )
    expect(results[1]).toMatchObject({ callId: 'c2', isError: true })
    expect(onToolUsage).toHaveBeenCalledWith({
      runId: 'run-1',
      toolCalls: 2,
      toolErrors: 1
    })
  })

  /** 用户已经在屏幕上读到的字,不能因为他点了停止就凭空消失 */
  it('流中途中断时半截回复仍进转录', async () => {
    const request = req()
    const handle = new RunHandle(request)
    const upstream: SessionUpstream = {
      listModels: () => [ALIAS],
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: 'message_start', model: 'm' }
        yield { type: 'text_delta', index: 0, text: '我正在写一段' }
        yield { type: 'text_delta', index: 0, text: '很长的回复' }
        handle.abort({ by: 'user' })
        throw new DOMException('aborted', 'AbortError')
      }
    }
    const session = new AgentSession(
      { host: quietHost(), upstream, tools: registry(), workspaceRoot: '/ws' },
      handle,
      request
    )
    const events = collect(handle)
    await session.run()

    expect(runEnd(await events).status).toBe('aborted')
    expect(session.history.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: '我正在写一段很长的回复' }]
    })
  })

  /**
   * ★ BlockAccumulator 丢掉未闭合的 tool_call,所以中断收尾**不会制造新的孤儿** ——
   * 半截参数的调用既不该执行(等于按模型没写完的意图动手),也不该留在转录里。
   */
  it('中断时半截的 tool_call 不进转录,也不产生孤儿', async () => {
    const request = req()
    const handle = new RunHandle(request)
    const upstream: SessionUpstream = {
      listModels: () => [ALIAS],
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: 'text_delta', index: 0, text: '我来删掉它' }
        yield { type: 'tool_call_start', index: 1, callId: 'c1', name: 'rm' }
        yield { type: 'tool_call_delta', index: 1, callId: 'c1', argsDelta: '{"path":"/et' }
        handle.abort({ by: 'user' })
        throw new DOMException('aborted', 'AbortError')
      }
    }
    const session = new AgentSession(
      { host: quietHost(), upstream, tools: registry({ internalId: 'rm' }), workspaceRoot: '/ws' },
      handle,
      request
    )
    const events = collect(handle)
    await session.run()

    expect(runEnd(await events).status).toBe('aborted')
    expectNoOrphans(session.history)
    expect(partsOf(session.history).some((p) => p.type === 'tool_call')).toBe(false)
    expect(partsOf(session.history).some((p) => p.type === 'text')).toBe(true)
  })

  /** 用户点了停止,就不该看到一个错误弹窗 —— 哪怕上游抛的不像 AbortError */
  it('中断时上游抛出不像 AbortError 的错误,仍算 aborted', async () => {
    const request = req()
    const handle = new RunHandle(request)
    const upstream: SessionUpstream = {
      listModels: () => [ALIAS],
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: 'text_delta', index: 0, text: 'x' }
        handle.abort({ by: 'user' })
        // undici 把中断包成这个样子
        throw new TypeError('fetch failed')
      }
    }
    const session = new AgentSession(
      { host: quietHost(), upstream, tools: registry(), workspaceRoot: '/ws' },
      handle,
      request
    )
    const events = collect(handle)
    await session.run()
    expect(runEnd(await events).status).toBe('aborted')
  })

  it('已经收尾的 run 不会被再收一次', async () => {
    const { events } = await runWithAbortingTool({
      upstream: fakeUpstream([callsTool('c1', 'slow')]),
      tools: (h) => registry({ internalId: 'slow', execute: abortsDuringExecute(h) })
    })
    expect(kinds(events).filter((k) => k === 'run_end')).toHaveLength(1)
  })
})

// ─────────────────────────── 流式错误与边界 ───────────────────────────

describe('错误与边界', () => {
  /**
   * 路由器把总失败表达成一个**终止事件**而不是异常(重试与故障切换都在它里面,
   * 方案 §5.3)—— 所以 session 收到 error 事件就直接收尾,不自己重试。
   */
  it('上游 error 事件让 run 以 error 收尾', async () => {
    const { events } = await runSession({
      upstream: fakeUpstream([
        [
          { type: 'text_delta', index: 0, text: '开了个头' },
          {
            type: 'error',
            error: { code: 'rate_limit', message: '429', retryable: true, status: 429 }
          }
        ]
      ])
    })
    const end = runEnd(events)
    expect(end.status).toBe('error')
    expect(end.error).toMatchObject({ code: 'rate_limit' })
  })

  /**
   * ★ error part 进转录,但它只属于 UI 那一轨 —— 编码器对它返回 null,
   * 下一轮上行时会被丢掉。重载后 attach 回来的转录里失败仍然看得见,
   * 不是一个消失了的 toast。
   */
  it('失败时半截回复与错误都进转录', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([
        [
          { type: 'text_delta', index: 0, text: '开了个头' },
          { type: 'error', error: { code: 'network', message: '断了', retryable: true } }
        ]
      ])
    })
    expect(history.at(-1)?.parts).toEqual([
      { type: 'text', text: '开了个头' },
      { type: 'error', error: { code: 'network', message: '断了', retryable: true } }
    ])
  })

  it('上游直接抛异常时 run 以 error 收尾,不逃出 run()', async () => {
    const upstream: SessionUpstream = {
      listModels: () => [ALIAS],
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        throw new Error('上游炸了')
      }
    }
    const request = req()
    const handle = new RunHandle(request)
    const session = new AgentSession(
      { host: quietHost(), upstream, tools: registry(), workspaceRoot: '/ws' },
      handle,
      request
    )
    const events = collect(handle)
    await expect(session.run()).resolves.toBeUndefined()
    const end = runEnd(await events)
    expect(end.status).toBe('error')
    expect(end.error?.message).toContain('上游炸了')
  })

  /** 继续循环会原样重发一次同样的请求 —— 收尾比空转诚实 */
  it('stopReason 是 tool_use 却没有已闭合的调用时正常收尾', async () => {
    const { events, upstream } = await runSession({
      upstream: fakeUpstream([
        [
          { type: 'text_delta', index: 0, text: '我要调用工具' },
          { type: 'tool_call_start', index: 1, callId: 'c1', name: 'echo' },
          END('tool_use')
        ],
        says('不该有第二轮')
      ]),
      tools: registry({ internalId: 'echo' })
    })
    expect(runEnd(events).status).toBe('done')
    expect(upstream.requests).toHaveLength(1)
  })

  /**
   * ★ 轮次耗尽时**不伪造一条「我做完了」的助手消息** ——
   * 那会让用户以为模型给出了结论,而实际上它只是被我们掐断了。
   */
  it('轮次耗尽时以 error 收尾,不伪造模型输出', async () => {
    const { events, upstream, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo')]),
      tools: registry({ internalId: 'echo' })
    })

    const end = runEnd(events)
    expect(end.status).toBe('error')
    expect(end.error?.message).toContain('最大轮次')
    expect(upstream.requests).toHaveLength(MAX_TURNS)
    expect(history.at(-1)?.role).toBe('user') // 停在最后一条工具结果上
    expectNoOrphans(history)
  })

  /** goal 模式「持续推进直到目标完成」= 更高的轮次上限 */
  it('goal 模式的轮次上限更高', async () => {
    const { upstream } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo')]),
      request: req({ mode: 'goal' }),
      tools: registry({ internalId: 'echo' })
    })
    expect(upstream.requests.length).toBeGreaterThan(MAX_TURNS)
  })

  /**
   * ★ 查不到别名时**不在这里报错**:让路由器的 noCandidateError 成为唯一的权威错误。
   * 两处都报的话,用户会随机收到信息量少的那一条。
   */
  it('模型别名查不到时照常发请求,由路由器去报错', async () => {
    const { events, upstream } = await runSession({
      upstream: fakeUpstream([says('好')], { models: [] }),
      request: req({ model: '不存在的别名' })
    })
    expect(runEnd(events).status).toBe('done')
    expect(upstream.requests[0]?.model).toBe('不存在的别名')
    expect(upstream.requests[0]?.maxOutputTokens).toBeGreaterThan(0)
  })

  /**
   * ★ 不能无条件调 truncateToolOutput:内容没超限时它返回一个干净的 { content },
   * 会把工具自己标好的 truncated / originalBytes 抹掉(工具在更靠近数据的地方截断,标记更准)。
   */
  it('未超限的工具输出原样保留自己的截断标记', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'reader'), says('好')]),
      tools: registry({
        internalId: 'reader',
        execute: () =>
          Promise.resolve(toolOk('前 100 行', { truncated: true, originalBytes: 999_999 }))
      })
    })
    expect(history[2]?.parts[0]).toMatchObject({
      output: { content: '前 100 行', truncated: true, originalBytes: 999_999 }
    })
  })

  /** 不要让一个返回 40MB 文件的工具冲垮 IPC 队列(方案 §4.3) */
  it('超限的工具输出被截断并标记', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'huge'), says('好')]),
      tools: registry({
        internalId: 'huge',
        execute: () => Promise.resolve(toolOk('x'.repeat(200_000)))
      })
    })
    const p = history[2]?.parts[0]
    expect(p?.type === 'tool_result' && p.output.content.length).toBeLessThan(200_000)
    expect(p).toMatchObject({ output: { truncated: true } })
  })
})

// ─────────────────────────── 工具快照的时点 ───────────────────────────

describe('每轮取一次工具快照(方案 §4.4)', () => {
  const MCP: ToolSource = { kind: 'mcp', serverId: 's1' }

  /**
   * ★ 名字按**本轮下发的那份快照**解析,不按实时注册表。
   *
   * 具体后果就是方案 §4.4 那条:「若该源某个工具**正在执行**,不能打断它」——
   * MCP server 在本轮进行中断开,已经下发过的调用照样跑得完。
   */
  it('本轮进行中来源断开,已下发的调用照样跑得完', async () => {
    const ran = vi.fn(() => Promise.resolve(toolOk('第二个工具还是跑了')))
    let tools: ToolRegistry
    // eslint-disable-next-line prefer-const
    tools = registry(
      {
        internalId: 'disconnect',
        source: MCP,
        // 第一个工具执行时,整个 MCP server 断开
        execute: () => {
          expect(tools.unregisterBySource(MCP)).toBe(2)
          return Promise.resolve(toolOk('server 断了'))
        }
      },
      { internalId: 'after', source: MCP, execute: ran }
    )

    const { history } = await runSession({
      upstream: fakeUpstream([
        [
          { type: 'tool_call_start', index: 0, callId: 'c1', name: 'disconnect' },
          { type: 'tool_call_end', index: 0, callId: 'c1' },
          { type: 'tool_call_start', index: 1, callId: 'c2', name: 'after' },
          { type: 'tool_call_end', index: 1, callId: 'c2' },
          END('tool_use')
        ],
        says('好')
      ]),
      tools
    })

    expect(ran).toHaveBeenCalledTimes(1)
    expect(tools.size).toBe(0)
    expectNoOrphans(history)
  })

  /** 下一轮重新取快照,所以断开的 server 到下一轮就真的不见了(§4.4) */
  it('下一轮重新取快照,下线的工具不再下发', async () => {
    let tools: ToolRegistry
    // eslint-disable-next-line prefer-const
    tools = registry(
      { internalId: 'local' },
      {
        internalId: 'remote',
        source: MCP,
        execute: () => {
          tools.unregisterBySource(MCP)
          return Promise.resolve(toolOk('ok'))
        }
      }
    )

    const { upstream } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'remote'), says('好')]),
      tools
    })

    expect(upstream.requests[0]?.tools.map((t) => t.externalName)).toEqual(['local', 'remote'])
    expect(upstream.requests[1]?.tools.map((t) => t.externalName)).toEqual(['local'])
  })

  /** 下一轮它就不在列表里了,模型再调就是一个**工具错误**,不是崩溃 */
  it('下线之后模型仍去调它,得到的是工具错误', async () => {
    let tools: ToolRegistry
    // eslint-disable-next-line prefer-const
    tools = registry({
      internalId: 'remote',
      source: MCP,
      execute: () => {
        tools.unregisterBySource(MCP)
        return Promise.resolve(toolOk('ok'))
      }
    })

    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'remote'), callsTool('c2', 'remote'), says('哦')]),
      tools
    })

    expect(runEnd(events).status).toBe('done')
    expect(history[2]?.parts[0]).toMatchObject({ callId: 'c1', isError: false })
    expect(history[4]?.parts[0]).toMatchObject({ callId: 'c2', isError: true })
    expectNoOrphans(history)
  })
})

// ─────────────────────────── 模型声明运行时约束 ───────────────────────────

describe('模型声明运行时约束', () => {
  it('不支持工具的模型不会收到注册表工具定义', async () => {
    const model: ModelAlias = {
      ...ALIAS,
      capabilities: { ...ALIAS.capabilities, tools: false }
    }
    const upstream = fakeUpstream([says('纯文本回答')], { models: [model] })
    const result = await runSession({
      upstream,
      tools: registry({ internalId: 'echo' })
    })
    expect(runEnd(result.events).status).toBe('done')
    expect(upstream.requests[0]?.tools).toEqual([])
  })

  it('图片输入在 HTTP 前按 Vision 能力拒绝', async () => {
    const model: ModelAlias = {
      ...ALIAS,
      capabilities: { ...ALIAS.capabilities, vision: false, visionInput: false }
    }
    const upstream = fakeUpstream([says('不应请求')], { models: [model] })
    const result = await runSession({
      upstream,
      request: req({ input: [{ type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/themes/a.png' }] })
    })
    expect(runEnd(result.events)).toMatchObject({
      status: 'error',
      error: { code: 'provider', retryable: false }
    })
    expect(runEnd(result.events).error?.message).toContain('Vision')
    expect(upstream.requests).toEqual([])
  })

  it('ThinkConfig 把 higher 解析为可移植的 xhigh', async () => {
    const model: ModelAlias = {
      ...ALIAS,
      thinkingConfig: {
        mode: 'effort',
        defaultEnabled: true,
        defaultEffort: 'medium',
        parameterPath: 'reasoning_effort'
      }
    }
    const upstream = fakeUpstream([says('好')], { models: [model] })
    await runSession({ upstream, request: req({ thinking: 'higher' }) })
    expect(upstream.requests[0]?.reasoning).toMatchObject({
      mode: 'effort', enabled: true, explicit: true, effort: 'xhigh'
    })
    expect(upstream.requests[0]).not.toHaveProperty('thinkingBudget')
  })

  it('输入加预留输出超过上下文窗口时不调用上游', async () => {
    const model: ModelAlias = { ...ALIAS, contextWindow: 1_200, maxOutputTokens: 1_000 }
    const upstream = fakeUpstream([says('不应请求')], { models: [model] })
    const result = await runSession({ upstream })
    expect(runEnd(result.events)).toMatchObject({ status: 'error', error: { code: 'context_length' } })
    expect(upstream.requests).toEqual([])
  })

  it('开启 Web Search 但模型既无内置搜索也无工具能力时明确失败', async () => {
    const model: ModelAlias = {
      ...ALIAS,
      capabilities: { ...ALIAS.capabilities, tools: false, webSearch: false }
    }
    const upstream = fakeUpstream([says('不应请求')], { models: [model] })
    const result = await runSession({ upstream, request: req({ webSearch: true }) })
    expect(runEnd(result.events).error?.message).toContain('Web Search')
    expect(upstream.requests).toEqual([])
  })
})

// ─────────────────────────── 转录不变式 ───────────────────────────

describe('转录不变式', () => {
  /** message_commit 是落盘边界(方案 §4.2),而 history 是同一份东西 */
  it('history 与 message_commit 事件一一对应', async () => {
    const { events, history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    // ★ 一一对应,**包括首条用户输入** —— 它也走 commit。渲染层的转录是
    // 事件流的投影,漏掉它用户就看不见自己刚发的那句话。
    expect(commits(events).map((m) => m.id)).toEqual(history.map((m) => m.id))
  })

  /** 转录要过 IPC 的结构化克隆 —— 带闭包就在那里炸,而那时离这里很远 */
  it('转录可结构化克隆', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo', '{"m":"hi"}'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    expect(() => structuredClone(history)).not.toThrow()
  })

  it('每条消息都有非空 parts', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    for (const m of history) expect(m.parts.length, m.id).toBeGreaterThan(0)
  })

  it('消息 id 互不相同', async () => {
    const { history } = await runSession({
      upstream: fakeUpstream([callsTool('c1', 'echo'), says('好')]),
      tools: registry({ internalId: 'echo' })
    })
    expect(new Set(history.map((m) => m.id)).size).toBe(history.length)
  })
})
