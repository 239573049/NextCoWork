import { describe, expect, it, vi } from 'vitest'
import type { InteractionResponse } from '../../../../../shared/agent/interaction'
import type { InteractionDraft } from '../../../interaction-gate'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { askUserTool } from '../interaction'

function ctx(interact?: (draft: InteractionDraft) => Promise<InteractionResponse>): ToolContext {
  return {
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {},
    interact
  }
}

const question = {
  header: '范围',
  question: '改哪个模块?',
  options: [{ label: '主进程' }, { label: '渲染层', description: '界面那侧' }]
}

describe('AskUserQuestion · 工具', () => {
  it('把多道题原样挂起,并按 header 把回答交回模型', async () => {
    const interact = vi.fn(async (_draft: InteractionDraft): Promise<InteractionResponse> => ({
      id: 'i1', kind: 'ask_user', answers: [['主进程'], ['要', '顺带跑一遍']]
    }))
    const result = await askUserTool.execute({
      questions: [question, { header: '测试', question: '要加测试吗?', multiSelect: true, options: [{ label: '要' }] }]
    }, ctx(interact))

    expect(interact.mock.calls[0]?.[0]).toMatchObject({
      kind: 'ask_user',
      questions: [
        { header: '范围', multiSelect: false, allowFreeform: true },
        { header: '测试', multiSelect: true }
      ]
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.output.content)).toEqual({
      answers: [
        { header: '范围', question: '改哪个模块?', answer: ['主进程'] },
        { header: '测试', question: '要加测试吗?', answer: ['要', '顺带跑一遍'] }
      ]
    })
  })

  it('没有选项的题默认允许自由作答 —— 这是「纯问答」那一档', async () => {
    const interact = vi.fn(async (_draft: InteractionDraft): Promise<InteractionResponse> => ({ id: 'i1', kind: 'ask_user', answers: [['随便写的']] }))
    const result = await askUserTool.execute({ questions: [{ header: '细节', question: '具体是什么现象?' }] }, ctx(interact))
    expect(interact.mock.calls[0]?.[0]).toMatchObject({ questions: [{ options: [], allowFreeform: true }] })
    expect(JSON.parse(result.output.content).answers[0].answer).toEqual(['随便写的'])
  })

  /**
   * ★ 既没选项、又不许自由作答的题在界面上点不动。必须**在挂起之前**失败:
   * 挂起之后模型就在等一个永远不会来的回答,而用户看到的是一道无法回答的题。
   */
  it('★ 无从作答的题在挂起之前就被拦下', async () => {
    const interact = vi.fn()
    const result = await askUserTool.execute({
      questions: [question, { header: '死题', question: '?', options: [], allowFreeform: false }]
    }, ctx(interact))
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('Question 2')
    expect(interact).not.toHaveBeenCalled()
  })

  it('用户关掉问题时明确告诉模型「没有答案」,而不是给一个空答案', async () => {
    const result = await askUserTool.execute({ questions: [question] },
      ctx(async () => ({ id: 'i1', kind: 'ask_user', answers: null })))
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('Do not assume an answer')
  })

  it('题数越界与缺字段由 schema 挡下', async () => {
    const many = { questions: Array.from({ length: 5 }, () => question) }
    expect((await askUserTool.execute(many, ctx(vi.fn()))).isError).toBe(true)
    expect((await askUserTool.execute({ questions: [] }, ctx(vi.fn()))).isError).toBe(true)
    expect((await askUserTool.execute({ question: '老写法' }, ctx(vi.fn()))).isError).toBe(true)
  })
})
