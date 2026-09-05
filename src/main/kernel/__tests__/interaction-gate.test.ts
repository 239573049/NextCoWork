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
    const result = gate.request(handle, { kind: 'ask_user', question: 'Pick', choices: ['A', 'B'], allowFreeform: false }, 100)
    const id = gate.list()[0]!.id
    expect(() => gate.respond({ id, kind: 'plan_approval', approved: true })).toThrow('Invalid')
    expect(() => gate.respond({ id, kind: 'ask_user', answer: 'C' })).toThrow('Invalid')
    expect(gate.list()).toHaveLength(1)
    gate.respond({ id, kind: 'ask_user', answer: 'B' })
    expect(await result).toMatchObject({ answer: 'B' })
    const approval = gate.request(handle, { kind: 'tool_permission', callId: 'c', toolName: 'Write', input: {}, readOnly: false, destructive: true }, 101)
    const permissionId = gate.list()[0]!.id
    expect(() => gate.respond({ id: permissionId, kind: 'tool_permission', decision: { kind: 'allow_always', scope: 'workspace' } })).toThrow('Invalid')
    gate.respond({ id: permissionId, kind: 'tool_permission', decision: { kind: 'deny' } })
    expect(await approval).toMatchObject({ decision: { kind: 'deny' } })
  })

  it.each(['abort', 'finish'] as const)('settles the blocked call on run %s and rejects late approvals', async (action) => {
    const gate = new InteractionGate()
    const handle = new RunHandle(req)
    const result = gate.request(handle, { kind: 'ask_user', question: 'Continue?', allowFreeform: true }, 100)
    const id = gate.list()[0]!.id
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    if (action === 'abort') handle.abort({ by: 'user' })
    else handle.finish('error')
    await rejected
    expect(gate.list()).toEqual([])
    expect(handle.pendingInteractions).toEqual([])
    expect(() => gate.respond({ id, kind: 'ask_user', answer: 'late' })).toThrow()
  })
})
