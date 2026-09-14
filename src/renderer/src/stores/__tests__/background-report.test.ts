/**
 * 后台子代理的结果回传 —— 钉的是**跨重启那一条路**。
 *
 * `lastOptions` 只活在内存里(只有 `send` 写它,不落盘)。所以一个后台子代理
 * 跑完、用户关掉应用、再打开 —— 卡片、待办圆点、后台任务中心里那颗「处理」
 * 按钮全都从库里恢复出来了,唯独发消息要用的那份档位没有。
 *
 * 钉住的是修好之后的两种结局:
 * 1. 谁都没有档位 → 置 `blocked`,**不能静默 return** —— 那样界面还挂着
 *    「结果待汇报给主代理」,而那颗「处理」按钮是个死键,按下去无事发生也不报错;
 * 2. 调用方补上 fallback(React 那一侧按工作区默认值拼的那份)→ 照发,
 *    而且 internal 标记要一路活到主进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../shared/agent/event'
import type { SendOptions } from '../../../../shared/agent/run-request'

vi.mock('../../services/agent', () => ({
  startRun: vi.fn(async () => {}), attachRun: vi.fn(), abortRun: vi.fn(),
  interjectRun: vi.fn(async () => {}), onAgentEvent: vi.fn(() => () => {})
}))
vi.mock('../../services/app', () => ({
  getSessionInput: vi.fn(async () => null), persistSessionInput: vi.fn()
}))
vi.mock('../../services/sessions', () => ({
  getSession: vi.fn(), replaceHistory: vi.fn(async () => {})
}))

import { startRun } from '../../services/agent'
import { releaseSession, reportBackgroundChild, sessionStore } from '../session'

const CALL_ID = 'task-bg'
const CHILD_RUN = 'parent-run:sub:1'

const options = (): SendOptions => ({
  workspaceId: 'workspace', depth: 0, mode: 'normal', thinking: 'auto',
  webSearch: false, maxContext: false, permissionMode: 'ask',
  model: 'deepseek-test', modelProviderId: 'deepseek', skillIds: []
})

/** 一个「跑完了、还没汇报」的后台子代理 —— 重启后恢复出来就是这个形状。 */
const restored: AgentEvent[] = [
  { type: 'subagent_start', callId: CALL_ID, childRunId: CHILD_RUN,
    childSessionId: `s:sub:${CHILD_RUN}`, description: '查配置读取处',
    subagentType: 'general-purpose', background: true },
  { type: 'subagent_end', callId: CALL_ID, childRunId: CHILD_RUN,
    status: 'done', summary: '三处读取,都在 config.ts' }
]

let sessions: string[] = []

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  for (const id of sessions) releaseSession(id)
  sessions = []
})

/**
 * 摆出「档位不在」时子代理跑完的局面,并顺带钉住自动那一趟的结局。
 *
 * ★ 每条用例用**各自的 sessionId** —— 「只汇报一次」那个去重集合是模块级的。
 */
function restart(name: string): string {
  const sessionId = `session-${name}`
  sessions.push(sessionId)
  const store = sessionStore(sessionId)
  store.getState().applyEvents(restored)
  // 这一段里没人发过消息,所以发消息要用的那份档位是 null —— 重启后就是这样
  expect(store.getState().lastOptions).toBeNull()
  // ★★ 自动那一趟因此发不出去。关键是它**留下了话**:置 blocked,
  //    而不是静默 return 把界面晾在「待汇报」上、按钮按下去没反应。
  expect(startRun).not.toHaveBeenCalled()
  expect(store.getState().transcript.subagents[CALL_ID]?.reportStatus).toBe('blocked')
  return sessionId
}

describe('后台子代理回传 · 重启之后', () => {
  it('★★ 调用方给了 fallback 档位,汇报照发,并且是 internal', async () => {
    const sessionId = restart('fallback')
    await reportBackgroundChild(sessionId, CALL_ID, options())

    expect(startRun).toHaveBeenCalledTimes(1)
    const req = vi.mocked(startRun).mock.calls[0]?.[0]
    // ★ internal 要一路活到主进程 —— 丢了它,这条给模型看的指令会出现在聊天里
    expect(req?.inputInternal).toBe(true)
    expect(req?.model).toBe('deepseek-test')
    expect(sessionStore(sessionId).getState().transcript.subagents[CALL_ID]?.reportStatus).toBe('reported')
  })

  it('★★ 还是没有档位 → 停在 blocked,一个字也不发', async () => {
    const sessionId = restart('blocked')
    await reportBackgroundChild(sessionId, CALL_ID)

    expect(startRun).not.toHaveBeenCalled()
    expect(sessionStore(sessionId).getState().transcript.subagents[CALL_ID]?.reportStatus).toBe('blocked')
  })

  it('汇报正文里带着子代理的结论,界面那一轨的 subagent part 也在', async () => {
    const sessionId = restart('parts')
    await reportBackgroundChild(sessionId, CALL_ID, options())

    const input = vi.mocked(startRun).mock.calls[0]?.[0]?.input ?? []
    const text = input.find((p) => p.type === 'text')
    expect(text?.type === 'text' && text.text).toContain('三处读取,都在 config.ts')
    // ★ 这个 part 只给界面看(两个编码器都丢弃它),`threadRows` 靠它认出汇报行
    const marker = input.find((p) => p.type === 'subagent')
    expect(marker?.type === 'subagent' && marker.callId).toBe(CALL_ID)
  })
})
