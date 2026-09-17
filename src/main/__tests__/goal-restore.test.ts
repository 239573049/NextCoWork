import { describe, expect, it } from 'vitest'
import { assistantMessage, userMessage, type AgentMessage, type ContentPart } from '../../shared/agent/message'
import { lastGoalStatus, restorableGoalCondition } from '../goal/restore'

const status = (over: Partial<Extract<ContentPart, { type: 'goal_status' }>>): ContentPart => ({
  type: 'goal_status',
  met: false,
  condition: '让 bun test 全绿',
  ...over
})

const withStatus = (...parts: ContentPart[]): AgentMessage =>
  assistantMessage('m1', [{ type: 'text', text: '好的' }, ...parts], 1)

describe('restorableGoalCondition', () => {
  it('一条标记都没有 → 从来没设过目标', () => {
    expect(restorableGoalCondition([userMessage('u', [{ type: 'text', text: '你好' }], 1)])).toBeNull()
  })

  it('最后一条是未达成 → 目标当时还活着，恢复它', () => {
    expect(restorableGoalCondition([withStatus(status({ met: false, reason: '还红着' }))]))
      .toBe('让 bun test 全绿')
  })

  it('最后一条是已达成 → 那个目标已经结束，不恢复', () => {
    expect(restorableGoalCondition([withStatus(status({ met: true }))])).toBeNull()
  })

  it('★ 判为不可能也不恢复 —— 它同样是终态', () => {
    expect(restorableGoalCondition([withStatus(status({ met: false, failed: true }))])).toBeNull()
  })

  it('★ 用户亲手清掉的不恢复 —— 他清它正是因为不想再跑了', () => {
    expect(restorableGoalCondition([withStatus(status({ met: false, cleared: true }))])).toBeNull()
  })

  it('★ 多条标记只认最后一条：先后设了三个目标，恢复的是第三个', () => {
    const history = [
      withStatus(status({ condition: '第一个', met: true })),
      withStatus(status({ condition: '第二个', cleared: true })),
      withStatus(status({ condition: '第三个', met: false }))
    ]
    expect(restorableGoalCondition(history)).toBe('第三个')
  })

  it('最后一条是终态时，前面那条活着的**不**被翻出来', () => {
    const history = [
      withStatus(status({ condition: '旧的', met: false })),
      withStatus(status({ condition: '旧的', met: true }))
    ]
    expect(restorableGoalCondition(history)).toBeNull()
  })

  it('同一条消息里有两条标记时取靠后的那一条', () => {
    const message = withStatus(
      status({ condition: '先', met: false }),
      status({ condition: '后', met: true })
    )
    expect(lastGoalStatus([message])?.condition).toBe('后')
    expect(restorableGoalCondition([message])).toBeNull()
  })

  it('条件为空的标记不恢复 —— 空条件的判定器稳定地判未达成', () => {
    expect(restorableGoalCondition([withStatus(status({ condition: '', met: false }))])).toBeNull()
  })
})
