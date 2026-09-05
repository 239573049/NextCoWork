import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../agent/event'
import { assistantMessage, toolResultMessage, userMessage } from '../agent/message'
import { applyChildEvent, applyEvent, applyEvents, emptyTranscript, hasRun, liveText, subagentsFromMessages } from '../agent/transcript'

/**
 * 转录投影的 bug 有个共同特征:**在界面上是间歇性的**。
 * 块按 index 错位要两个并行工具调用才现形,提交后残留活跃块要
 * 恰好在那一帧截图才看得见。所以这一组测的都是「肉眼查不出来」的东西。
 */

const t = (index: number, text: string): AgentEvent => ({
  type: 'stream',
  delta: { type: 'text_delta', index, text }
})

describe('applyEvent · 内容块', () => {
  it('同一 index 的 delta 累积成一段', () => {
    const s = applyEvents(emptyTranscript(), [t(0, '你'), t(0, '好'), t(0, '世界')])
    expect(s.live).toHaveLength(1)
    expect(s.live[0]?.text).toBe('你好世界')
  })

  it('不同 index 分成不同的块 —— 「文本 → 工具 → 文本」不能糊成一段', () => {
    const s = applyEvents(emptyTranscript(), [t(0, '前'), t(2, '后')])
    expect(s.live.map((b) => b.text)).toEqual(['前', '后'])
  })

  it('★ 块按 index 排序,与到达顺序无关', () => {
    // 并行工具调用时,两个块的首个 delta 可能乱序到达。
    // 不排序的话,UI 上就是「结论出现在前言之前」——
    // 一个只在并发时出现、截图都难抓的错乱。
    const s = applyEvents(emptyTranscript(), [t(2, '第三'), t(0, '第一'), t(1, '第二')])
    expect(s.live.map((b) => b.index)).toEqual([0, 1, 2])
    expect(s.live.map((b) => b.text)).toEqual(['第一', '第二', '第三'])
  })

  it('thinking 与 text 是不同 kind,不混进正文', () => {
    const s = applyEvents(emptyTranscript(), [
      { type: 'stream', delta: { type: 'thinking_delta', index: 0, text: '内心戏' } },
      t(1, '正文')
    ])
    expect(s.live.map((b) => b.kind)).toEqual(['thinking', 'text'])
    // ★ liveText 只取 text —— 把思考内容漏进正文是**用户可见的**信息泄漏
    expect(liveText(s)).toBe('正文')
  })

  it('工具调用参数按 index 累积,不落进 text 块', () => {
    const s = applyEvents(emptyTranscript(), [
      { type: 'stream', delta: { type: 'tool_call_start', index: 1, callId: 'c1', name: 'read' } },
      { type: 'stream', delta: { type: 'tool_call_delta', index: 1, callId: 'c1', argsDelta: '{"p"' } },
      { type: 'stream', delta: { type: 'tool_call_delta', index: 1, callId: 'c1', argsDelta: ':1}' } },
      { type: 'stream', delta: { type: 'tool_call_end', index: 1, callId: 'c1' } }
    ])
    expect(s.live).toHaveLength(1)
    expect(s.live[0]).toMatchObject({ kind: 'tool_use', callId: 'c1', name: 'read', text: '{"p":1}' })
    expect(liveText(s)).toBe('')
  })
})

describe('applyEvent · 提交边界', () => {
  it('★ 提交后活跃块必须清空 —— 否则全文重影', () => {
    let s = applyEvents(emptyTranscript(), [t(0, '你好')])
    expect(s.live).toHaveLength(1)

    s = applyEvent(s, {
      type: 'message_commit',
      message: assistantMessage('m1', [{ type: 'text', text: '你好' }], 1)
    })
    expect(s.live).toEqual([])
    expect(s.messages).toHaveLength(1)
  })

  it('提交之后新的 delta 起一段新的活跃块', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'message_commit',
      message: assistantMessage('m1', [{ type: 'text', text: '第一条' }], 1)
    })
    s = applyEvent(s, t(0, '第二条'))
    expect(s.messages).toHaveLength(1)
    expect(liveText(s)).toBe('第二条')
  })

  it('同一个消息 ID 的确认提交替换乐观消息,不会产生重复气泡', () => {
    const optimistic = userMessage('u1', [{ type: 'text', text: '发送中' }], 1)
    const confirmed = userMessage('u1', [{ type: 'text', text: '发送中' }], 2)
    const s = applyEvent({ ...emptyTranscript(), messages: [optimistic] }, {
      type: 'message_commit',
      message: confirmed
    })

    expect(s.messages).toEqual([confirmed])
  })
})

describe('applyEvent · 工具状态', () => {
  const start: AgentEvent = {
    type: 'tool_start',
    callId: 'c1',
    toolName: 'read_file',
    input: { path: 'a.ts' }
  }

  it('start → progress → end 的状态流转', () => {
    let s = applyEvent(emptyTranscript(), start)
    expect(s.tools['c1']?.status).toBe('running')

    s = applyEvent(s, {
      type: 'tool_progress',
      callId: 'c1',
      progress: { callId: 'c1', message: '读取中' }
    })
    expect(s.tools['c1']?.progress).toBe('读取中')

    s = applyEvent(s, {
      type: 'tool_end',
      callId: 'c1',
      output: { content: 'ok' },
      isError: false
    })
    expect(s.tools['c1']?.status).toBe('ok')
    expect(s.tools['c1']?.output?.content).toBe('ok')
    // 结束后进度必须清掉,否则卡片上一直挂着「读取中」
    expect(s.tools['c1']?.progress).toBeUndefined()
  })

  it('isError 映射成 error 状态', () => {
    let s = applyEvent(emptyTranscript(), start)
    s = applyEvent(s, { type: 'tool_end', callId: 'c1', output: { content: '炸了' }, isError: true })
    expect(s.tools['c1']?.status).toBe('error')
  })

  it('★ 没见过 start 的 tool_end 不能丢 —— 重放裁剪后可能真的只剩 end', () => {
    const s = applyEvent(emptyTranscript(), {
      type: 'tool_end',
      callId: 'ghost',
      output: { content: 'x' },
      isError: false
    })
    expect(s.tools['ghost']?.status).toBe('ok')
  })

  it('没见过 start 的 progress 被忽略,不凭空造一条工具记录', () => {
    const s = applyEvent(emptyTranscript(), {
      type: 'tool_progress',
      callId: 'ghost',
      progress: { callId: 'ghost', message: 'x' }
    })
    expect(s.tools).toEqual({})
  })
})

describe('applyEvent · 终局与元信息', () => {
  it('run_end 带过来的状态与错误都落到 state 上', () => {
    const s = applyEvent(emptyTranscript(), {
      type: 'run_end',
      status: 'error',
      error: { code: 'rate_limit', message: '太快了', retryable: true }
    })
    expect(s.status).toBe('error')
    expect(s.error?.code).toBe('rate_limit')
  })

  it('run_end 保存结束时间，供回合级耗时展示', () => {
    const s = applyEvent(emptyTranscript(), { type: 'run_end', status: 'done', at: 4_200 })
    expect(s.runEndedAt).toBe(4_200)
  })

  it('中断是终局状态之一,且不算 error', () => {
    const s = applyEvent(emptyTranscript(), { type: 'run_end', status: 'aborted' })
    expect(s.status).toBe('aborted')
    expect(s.error).toBeUndefined()
  })

  it('message_start / message_end / context_usage 填元信息', () => {
    const s = applyEvents(emptyTranscript(), [
      { type: 'stream', delta: { type: 'message_start', model: 'claude-fable-5-1' } },
      {
        type: 'stream',
        delta: {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 20 }
        }
      },
      { type: 'context_usage', used: 30, window: 200_000, shouldCompact: false }
    ])
    expect(s.model).toBe('claude-fable-5-1')
    expect(s.usage?.outputTokens).toBe(20)
    expect(s.contextUsage?.used).toBe(30)
  })

  it('累加本次运行的 API 用量，流式文本与上下文估算不改变 token 数', () => {
    const first: AgentEvent = { type: 'stream', delta: { type: 'message_end', stopReason: 'tool_use',
      usage: { inputTokens: 1135, outputTokens: 144, cacheReadInputTokens: 500, reasoningTokens: 100 } } }
    const before = applyEvent(emptyTranscript(), first)
    const streaming = applyEvents(before, [
      { type: 'stream', delta: { type: 'message_start', model: 'model' } },
      t(0, '很长的输出'.repeat(100)),
      { type: 'context_usage', used: 9999, window: 100000, shouldCompact: false }
    ])
    expect(streaming.usage).toEqual(before.usage)
    const after = applyEvent(streaming, { type: 'stream', delta: { type: 'message_end', stopReason: 'end_turn',
      usage: { inputTokens: 2000, outputTokens: 256, cacheCreationInputTokens: 50 } } })
    expect(after.usage).toEqual({ inputTokens: 3135, outputTokens: 400, cacheReadInputTokens: 500,
      cacheCreationInputTokens: 50, reasoningTokens: 100 })
    expect(before.usage?.outputTokens).toBe(144)
    expect(applyEvent(after, { type: 'run_end', status: 'done' }).usage).toEqual(after.usage)
    expect(applyEvent(emptyTranscript(), first).usage?.outputTokens).toBe(144)
  })

  it('未知/未接管的事件原样返回,不炸也不吞状态', () => {
    const before = applyEvents(emptyTranscript(), [t(0, 'x')])
    const after = applyEvent(before, {
      type: 'interaction_resolved',
      id: 'ghost',
      outcome: { status: 'aborted' }
    })
    expect(after).toEqual(before)
  })

  it('subagent_start 建立可观测状态', () => {
    const s = applyEvent(emptyTranscript(), {
      type: 'subagent_start',
      callId: 'c1',
      childRunId: 'r2',
      description: '查找配置读取处',
      subagentType: 'researcher',
      model: 'model-a',
      background: true,
      at: 100
    })

    expect(s.subagents.c1).toEqual({
      callId: 'c1',
      childRunId: 'r2',
      status: 'running',
      description: '查找配置读取处',
      subagentType: 'researcher',
      model: 'model-a',
      background: true,
      phase: 'background',
      toolCalls: 0,
      toolErrors: 0,
      startedAt: 100
    })
  })

  it('subagent_update 累积工具、上下文和 token 用量', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'subagent_start', callId: 'c1', childRunId: 'r2'
    })
    s = applyEvent(s, {
      type: 'subagent_update',
      callId: 'c1',
      childRunId: 'r2',
      phase: 'tool',
      currentTool: 'read_file',
      toolCalls: 2,
      toolErrors: 1,
      usage: { inputTokens: 10, outputTokens: 4 },
      contextUsage: { used: 100, window: 1000, shouldCompact: false }
    })
    s = applyEvent(s, {
      type: 'subagent_update',
      callId: 'c1',
      childRunId: 'r2',
      usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 }
    })

    expect(s.subagents.c1).toMatchObject({
      phase: 'tool', currentTool: 'read_file', toolCalls: 2, toolErrors: 1,
      contextUsage: { used: 100, window: 1000, shouldCompact: false },
      usage: { inputTokens: 13, outputTokens: 6, reasoningTokens: 1 }
    })

    s = applyEvent(s, {
      type: 'subagent_update',
      callId: 'c1',
      childRunId: 'r2',
      phase: 'thinking',
      currentTool: undefined,
      toolCalls: 2,
      toolErrors: 1
    })
    expect(s.subagents.c1?.currentTool).toBeUndefined()
  })

  it('subagent_end 保存终态、摘要和结束时间', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'subagent_start', callId: 'c1', childRunId: 'r2', at: 100
    })
    s = applyEvent(s, {
      type: 'subagent_end', callId: 'c1', childRunId: 'r2', status: 'done',
      summary: '配置在 src/config.ts', at: 250
    })

    expect(s.subagents.c1).toMatchObject({
      status: 'done', phase: 'finishing', summary: '配置在 src/config.ts', endedAt: 250
    })
    expect(s.subagents.c1?.currentTool).toBeUndefined()
  })

  it('applyChildEvent 把子 run 的工具和 run_end 投影到 Task 卡片', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'subagent_start', callId: 'c1', childRunId: 'r2'
    })
    s = applyChildEvent(s, 'r2', {
      type: 'tool_start', callId: 'tc1', toolName: 'read_file', input: {}
    })
    s = applyChildEvent(s, 'r2', {
      type: 'tool_end', callId: 'tc1', output: { content: 'ok' }, isError: true
    })
    s = applyChildEvent(s, 'r2', {
      type: 'run_end', status: 'error', at: 500
    })

    expect(s.subagents.c1).toMatchObject({
      toolCalls: 1, toolErrors: 1, status: 'error', endedAt: 500
    })
  })

  it('后台子 run 父回合已结束时，从子消息提交补出最终摘要', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'subagent_start', callId: 'c1', childRunId: 'r2', background: true
    })
    s = applyChildEvent(s, 'r2', {
      type: 'message_commit',
      message: assistantMessage('child-m1', [{ type: 'text', text: '后台调查完成' }], 1)
    })

    expect(s.subagents.c1?.summary).toBe('后台调查完成')
  })

  it('父汇总遥测与继承的同一子事件只计算一次', () => {
    let s = applyEvent(emptyTranscript(), {
      type: 'subagent_start', callId: 'c1', childRunId: 'r2'
    })
    // Parent monitor sees child seq=1 first.
    s = applyEvent(s, {
      type: 'subagent_update', callId: 'c1', childRunId: 'r2',
      phase: 'tool', currentTool: 'read_file', toolCalls: 1, childSeq: 1,
      usage: { inputTokens: 10, outputTokens: 2 }
    })
    // The inherited raw child event is the same seq and must be ignored.
    s = applyChildEvent(s, 'r2', {
      type: 'tool_start', callId: 'tc1', toolName: 'read_file', input: {}
    }, 1)
    expect(s.subagents.c1).toMatchObject({ toolCalls: 1, usage: { inputTokens: 10, outputTokens: 2 } })
  })

  it('从已保存的 Task 工具回执重建子 Agent 卡片和入参信息', () => {
    const task = assistantMessage('task-message', [{
      type: 'tool_call',
      callId: 'c1',
      name: 'Task',
      input: { description: '查配置', subagent_type: 'researcher' }
    }], 1)
    const result = toolResultMessage('task-result', [{
      type: 'tool_result',
      callId: 'c1',
      output: { content: '后台已启动' },
      isError: false,
      subagent: { childRunId: 'r2', status: 'done', summary: '后台结果', background: true }
    }], 2)

    expect(subagentsFromMessages([task, result]).c1).toMatchObject({
      childRunId: 'r2', status: 'done', description: '查配置', subagentType: 'researcher',
      summary: '后台结果', background: true
    })
  })

  it('★ 永不原地修改入参 —— zustand 靠引用变化决定重渲染', () => {
    const before = emptyTranscript()
    const after = applyEvent(before, t(0, 'x'))
    expect(before.live).toEqual([])
    expect(after).not.toBe(before)
    expect(after.live).not.toBe(before.live)
  })
})

/**
 * ★ 这一组守的是一个**只在空会话首屏出现**的错:状态行写着「生成中」,
 * 而用户还一个字都没发。
 *
 * 根因是 `emptyTranscript().status === 'running'` 被两种完全不同的处境共用 ——
 * 「run 起来了但第一个事件还没到」和「全新会话」。前者显示生成中是对的,
 * 后者是假的。所以这里每一条都成对出现:同一个转录,`running` 不同,答案就不同。
 */
describe('hasRun · 空会话首屏不该写着「生成中」', () => {
  it('★ 全新会话:status 虽然是 running,但没有 run', () => {
    const s = emptyTranscript()
    expect(s.status).toBe('running') // 前提:初值确实是 running,不然这组测试没意义
    expect(hasRun(s, false)).toBe(false)
  })

  it('★ 同一个空转录,activeRunId 在就是有 run —— attach 上去的那一瞬', () => {
    expect(hasRun(emptyTranscript(), true)).toBe(true)
  })

  it('第一个 delta 一到就有 run,即使此刻 running 还没翻过来', () => {
    const s = applyEvents(emptyTranscript(), [t(0, '你')])
    expect(hasRun(s, false)).toBe(true)
  })

  it('run 结束后转录留着消息,状态行要继续显示「已完成」', () => {
    const s = applyEvent(applyEvents(emptyTranscript(), [t(0, '你好')]), {
      type: 'message_commit',
      message: assistantMessage('m1', [{ type: 'text', text: '你好' }], 1)
    })
    expect(s.live).toEqual([])
    expect(s.messages).toHaveLength(1)
    expect(hasRun(s, false)).toBe(true)
  })
})
