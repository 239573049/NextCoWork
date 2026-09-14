import { describe, expect, it } from 'vitest'
import { emptyTranscript, type LiveBlock, type ToolCallState, type TranscriptState } from '../agent/transcript'
import { activityOf } from '../domain/activity'

/**
 * 相位选错了的表现全都很轻:那句装饰文案说的事和眼前的工具对不上。
 * 没有崩溃、没有报错,而且要特定的工具到达顺序才现形 —— 正好是肉眼盯不出来的那一类。
 */

function tool(name: string, status: ToolCallState['status'], startedAt?: number): ToolCallState {
  return { callId: name, name, input: {}, status, ...(startedAt === undefined ? {} : { startedAt }) }
}

function transcript(patch: Partial<TranscriptState>): TranscriptState {
  return { ...emptyTranscript(), ...patch }
}

function live(kind: LiveBlock['kind']): LiveBlock[] {
  return [{ index: 0, kind, text: '' }]
}

describe('activityOf', () => {
  it('工具在跑时用它的展示形态 —— 和时间线的分组是同一套', () => {
    for (const [name, phase] of [
      ['Read', 'read'], ['Grep', 'search'], ['Edit', 'mutate'],
      ['Bash', 'command'], ['WebFetch', 'network'], ['Task', 'orchestration']
    ] as const) {
      expect(activityOf(transcript({ tools: { [name]: tool(name, 'running') } }), false)).toBe(phase)
    }
  })

  it('★ 并行多个工具取最新开跑的那个 —— 而不是卡在第一个慢工具上', () => {
    const state = transcript({
      tools: {
        a: tool('Bash', 'running', 1000),
        b: tool('Read', 'running', 3000),
        c: tool('Grep', 'running', 2000)
      }
    })
    expect(activityOf(state, false)).toBe('read')
  })

  it('没有 startedAt 的旧转录退化成插入序的最后一个,而不是崩', () => {
    const state = transcript({ tools: { a: tool('Bash', 'running'), b: tool('Grep', 'running') } })
    expect(activityOf(state, false)).toBe('search')
  })

  it('只有跑着的算数 —— 已结束和还没开跑的工具都不参与', () => {
    const state = transcript({
      tools: { a: tool('Read', 'ok', 3000), b: tool('Bash', 'pending', 4000), c: tool('Grep', 'running', 1000) },
      live: []
    })
    expect(activityOf(state, false)).toBe('search')
  })

  it('没有工具在跑时看最后一个 live 块:思考 / 正文', () => {
    expect(activityOf(transcript({ live: live('thinking') }), false)).toBe('reasoning')
    expect(activityOf(transcript({ live: live('text') }), false)).toBe('writing')
  })

  it('★ 参数还在流(tool_use)时归通用档 —— 别抢在工具开跑之前描述它', () => {
    expect(activityOf(transcript({ live: live('tool_use') }), false)).toBe('working')
  })

  it('★ 前面的块流完了就不算数 —— 只看最后一个', () => {
    const state = transcript({
      live: [{ index: 0, kind: 'thinking', text: '想完了' }, { index: 1, kind: 'text', text: '在写' }]
    })
    expect(activityOf(state, false)).toBe('writing')
  })

  it('什么都没有时由 waitingForResponse 决定等待还是通用', () => {
    expect(activityOf(emptyTranscript(), true)).toBe('waiting')
    expect(activityOf(emptyTranscript(), false)).toBe('working')
  })
})
