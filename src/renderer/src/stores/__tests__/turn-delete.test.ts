/**
 * 「删除这一轮」的跨度语义。
 *
 * ★ 这里量的是一件在界面上**看不出来**的事:一轮问答在存储里不是两条消息,
 * 而是 `user → assistant(tool_call) → user(tool_result 回执) → assistant …`
 * 这样一长串。删除只砍掉可见的那两条,留下来的 tool_result 就失去了配对的
 * tool_call —— 那对 Anthropic 形状是非法请求,而它要等到**下一次发消息**
 * 才炸,那时早已看不出是这次删除干的。所以每个用例都断言残留消息的完整 id 序列。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../shared/agent/message'

vi.mock('../../services/agent', () => ({
  startRun: vi.fn(),
  attachRun: vi.fn(),
  abortRun: vi.fn(),
  onAgentEvent: vi.fn(() => () => {})
}))

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(async () => ({ tabs: [], activeTabId: null })),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn(),
  getSessionInput: vi.fn(async () => null),
  persistSessionInput: vi.fn()
}))

vi.mock('../../services/sessions', () => ({
  replaceHistory: vi.fn(async () => undefined),
  getSession: vi.fn(async () => null)
}))

import { replaceHistory } from '../../services/sessions'
import { releaseSession, sessionStore } from '../session'

const mockReplaceHistory = vi.mocked(replaceHistory)

/** 一轮带工具调用的问答:提问 → 调工具 → 回执 → 收尾发言。 */
const turn = (n: string) => [
  userMessage(`u${n}`, [{ type: 'text', text: `问题 ${n}` }], 1),
  assistantMessage(`a${n}`, [{ type: 'tool_call', callId: `c${n}`, name: 'Read', input: {} }], 2),
  toolResultMessage(`r${n}`, [{ type: 'tool_result', callId: `c${n}`, output: { content: 'ok' }, isError: false }], 3),
  assistantMessage(`b${n}`, [{ type: 'text', text: `回答 ${n}` }], 4)
]

const created: string[] = []
function seeded(id: string, messages: ReturnType<typeof turn>): ReturnType<typeof sessionStore> {
  created.push(id)
  const store = sessionStore(id)
  store.setState((s) => ({ transcript: { ...s.transcript, messages } }))
  return store
}

beforeEach(() => { vi.clearAllMocks() })

afterEach(() => {
  for (const id of created) {
    sessionStore(id).setState({ activeRunId: null })
    releaseSession(id)
  }
  created.length = 0
})

describe('删除一整轮', () => {
  it('连同工具回执一起删,不留下失去配对的 tool_result', async () => {
    const s = seeded('d-mid', [...turn('1'), ...turn('2')])

    await s.getState().deleteTurn('u1')

    expect(s.getState().transcript.messages.map((m) => m.id))
      .toEqual(['u2', 'a2', 'r2', 'b2'])
  })

  it('删中间一轮时保留它后面的对话 —— 删除不是截断', async () => {
    const s = seeded('d-keep-tail', [...turn('1'), ...turn('2'), ...turn('3')])

    await s.getState().deleteTurn('u2')

    expect(s.getState().transcript.messages.map((m) => m.id))
      .toEqual(['u1', 'a1', 'r1', 'b1', 'u3', 'a3', 'r3', 'b3'])
  })

  it('删末轮时清掉 usage/error —— 它们说的是一个已经不存在的回合', async () => {
    const s = seeded('d-tail', [...turn('1'), ...turn('2')])
    s.setState((state) => ({
      transcript: {
        ...state.transcript,
        usage: { inputTokens: 10, outputTokens: 20 },
        error: { code: 'unknown', message: '炸了', retryable: false }
      }
    }))

    await s.getState().deleteTurn('u2')

    expect(s.getState().transcript.usage).toBeUndefined()
    expect(s.getState().transcript.error).toBeUndefined()
  })

  it('删非末轮时不动 usage —— 那是最后一轮的读数,与被删的这轮无关', async () => {
    const s = seeded('d-mid-usage', [...turn('1'), ...turn('2')])
    s.setState((state) => ({
      transcript: { ...state.transcript, usage: { inputTokens: 10, outputTokens: 20 } }
    }))

    await s.getState().deleteTurn('u1')

    expect(s.getState().transcript.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('把删除结果落盘 —— 只改内存的话,重开会话删掉的内容会原样回来', async () => {
    const s = seeded('d-persist', [...turn('1'), ...turn('2')])

    await s.getState().deleteTurn('u1')

    expect(mockReplaceHistory).toHaveBeenCalledTimes(1)
    expect(mockReplaceHistory.mock.calls[0]?.[1].map((m) => m.id))
      .toEqual(['u2', 'a2', 'r2', 'b2'])
  })

  it('运行中拒绝删除 —— 主进程正往这段历史里追加消息', async () => {
    const s = seeded('d-running', [...turn('1')])
    s.setState({ activeRunId: 'run-1' })

    await s.getState().deleteTurn('u1')

    expect(s.getState().transcript.messages).toHaveLength(4)
    expect(mockReplaceHistory).not.toHaveBeenCalled()
  })

  it('id 对不上时是空操作,不会误删别的东西', async () => {
    const s = seeded('d-missing', [...turn('1')])

    await s.getState().deleteTurn('u-nope')

    expect(s.getState().transcript.messages).toHaveLength(4)
    expect(mockReplaceHistory).not.toHaveBeenCalled()
  })

  it('传的是助手消息 id 时也是空操作 —— 锚点只能是提问', async () => {
    const s = seeded('d-assistant-anchor', [...turn('1')])

    await s.getState().deleteTurn('b1')

    expect(s.getState().transcript.messages).toHaveLength(4)
    expect(mockReplaceHistory).not.toHaveBeenCalled()
  })
})
