import { describe, expect, it } from 'vitest'
import { InteractionGate } from '../interaction-gate'
import { RunHandle } from '../run-registry'
import type { RunRequest } from '../../../shared/agent/run-request'
import type { InteractionResponse } from '../../../shared/agent/interaction'

const req: RunRequest = {
  runId: 'r', sessionId: 's', workspaceId: 'w', depth: 0, input: [], mode: 'normal', thinking: 'off',
  webSearch: false, permissionMode: 'ask', model: 'm', skillIds: []
}

describe('InteractionGate', () => {
  it('records approval in attach state, accepts edited input once and clears pending state', async () => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'tool_permission', callId: 'c', toolName: 'Write',
      input: { path: 'a' }, destructive: true, readOnly: false }, 100)
    const pending = gate.list()[0]!
    expect(handle.snapshot(0).pendingInteractions).toEqual([pending])
    const response: InteractionResponse = { id: pending.id, kind: 'tool_permission', decision: { kind: 'allow_edited', input: { path: 'b' } } }
    gate.respond(response)
    expect(await result).toEqual(response)
    expect(handle.snapshot(0).pendingInteractions).toEqual([])
    expect(gate.list()).toEqual([])
    expect(() => gate.respond(response)).toThrow('no longer pending')
  })

  it('rejects mismatched kinds, invalid answers and unsupported persistent grants', async () => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'ask_user', questions: [{ header: 'Pick', question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeform: false }] }, 100)
    const id = gate.list()[0]!.id
    expect(() => gate.respond({ id, kind: 'plan_approval', approved: true })).toThrow('Invalid')
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['C']] })).toThrow('Invalid')
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['A', 'B']] })).toThrow('Invalid')
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [] })).toThrow('Invalid')
    expect(gate.list()).toHaveLength(1)
    gate.respond({ id, kind: 'ask_user', answers: [['B']] })
    expect(await result).toMatchObject({ answers: [['B']] })
    const approval = gate.request(handle, { kind: 'tool_permission', callId: 'c', toolName: 'Write', input: {}, readOnly: false, destructive: true }, 101)
    const permissionId = gate.list()[0]!.id
    expect(() => gate.respond({ id: permissionId, kind: 'tool_permission', decision: { kind: 'allow_always', scope: 'workspace' } })).toThrow('Invalid')
    gate.respond({ id: permissionId, kind: 'tool_permission', decision: { kind: 'deny' } })
    expect(await approval).toMatchObject({ decision: { kind: 'deny' } })
  })

  /**
   * ★ 多道题时,答案是**按下标**对到题上的。所以长度不等必须整份退回 ——
   * 窗口重载后拿着旧题面抢答的话,按下标对齐会把「要不要加测试」的回答
   * 安到「改哪个模块」上,而两边都不会报错。
   */
  it('★ 多题多选:逐题校验,长度不等整份退回', async () => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'ask_user', questions: [
      { header: '范围', question: '改哪里?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, allowFreeform: false },
      { header: '细节', question: '还有什么?', options: [], multiSelect: false, allowFreeform: true }
    ] }, 100)
    const id = gate.list()[0]!.id

    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['A']] })).toThrow('Invalid')
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['A'], []] })).toThrow('Invalid')
    // 第一题不许自由作答,写的字不在选项里
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['自己写的'], ['随便']] })).toThrow('Invalid')
    // 同一项勾两次(界面做不到,但 IPC 那侧递得进来)
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['A', 'A'], ['随便']] })).toThrow('Invalid')
    // 第二题是纯问答,自由作答放行
    gate.respond({ id, kind: 'ask_user', answers: [['A', 'B'], ['随便写的']] })
    expect(await result).toMatchObject({ answers: [['A', 'B'], ['随便写的']] })
  })

  it('单选题不接受多个答案,dismiss 一律放行', async () => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'ask_user', questions: [
      { header: '范围', question: '改哪里?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeform: true }
    ] }, 100)
    const id = gate.list()[0]!.id
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['A', 'B']] })).toThrow('Invalid')
    gate.respond({ id, kind: 'ask_user', answers: null })
    expect(await result).toMatchObject({ answers: null })
  })

  it.each(['abort', 'finish'] as const)('settles the blocked call on run %s and rejects late approvals', async (action) => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'ask_user', questions: [{ header: 'Continue', question: 'Continue?',
      options: [], multiSelect: false, allowFreeform: true }] }, 100)
    const id = gate.list()[0]!.id
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    if (action === 'abort') handle.abort({ by: 'user' })
    else handle.finish('error')
    await rejected
    expect(gate.list()).toEqual([])
    expect(handle.pendingInteractions).toEqual([])
    expect(() => gate.respond({ id, kind: 'ask_user', answers: [['late']] })).toThrow()
  })
})
