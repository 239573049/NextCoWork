import { describe, expect, it } from 'vitest'
import type { AgentMessage, ContentPart } from '../../../../../shared/agent/message'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../../shared/agent/message'
import { compactMessages } from '../../../context-assembler'
import { MARK, TODO_LIMITS, latestTodosFrom } from '../todo'

/**
 * `latestTodosFrom` 的测试 —— 从**转录**反推当前 todo 列表。
 *
 * 这个函数存在的前提是 `todo.ts` 文件头那条设计:**不持久化任何一份 todo**。
 * 唯一真相源就是最近一次成功的 `TodoWrite` 调用,它已经躺在转录里了。
 * 所以这里钉的每一条,本质都是「怎样才算『最近一次成功』」。
 */

const TOOL = 'TodoWrite'

const todos = (...items: Array<[string, 'pending' | 'in_progress' | 'completed']>): unknown => ({
  todos: items.map(([content, status]) => ({ content, status, activeForm: `正在${content}` }))
})

let n = 0
/** 一对「模型发起调用」+「工具回执」。`isError` 决定这次调用算不算数。 */
function call(input: unknown, isError = false): AgentMessage[] {
  const callId = `c${String(++n)}`
  return [
    assistantMessage(`a${callId}`, [{ type: 'tool_call', callId, name: TOOL, input }], 0),
    toolResultMessage(
      `r${callId}`,
      [{ type: 'tool_result', callId, output: { content: 'ok' }, isError }],
      0
    )
  ]
}

const START = userMessage('u0', [{ type: 'text', text: '开始干活' }], 0)

describe('取最近一次', () => {
  it('后写的那份覆盖先写的', () => {
    const messages = [
      START,
      ...call(todos(['读代码', 'completed'])),
      ...call(todos(['读代码', 'completed'], ['写代码', 'in_progress']))
    ]

    expect(latestTodosFrom(messages, TOOL)?.length).toBe(2)
  })

  it('渲染标记和工具自己的回显是同一份 —— MARK 已导出', () => {
    expect(MARK.completed).toBe('[x]')
    expect(MARK.in_progress).toBe('[~]')
    expect(MARK.pending).toBe('[ ]')
  })
})

describe('★ 什么样的调用不算数', () => {
  it('被工具拒绝的那次不算 —— 取更早那条成功的', () => {
    /*
      `turn()` 先 `commitAssistant(parts)` 提交 tool_call,校验发生在**之后**的
      `executeAll` → `schema.safeParse`。所以「两个 in_progress」这种被明确
      拒绝的列表**原样躺在转录里**。盲取最近一条 = 把工具拒绝过的东西
      当成当前进度渲染给模型看。
    */
    const messages = [
      START,
      ...call(todos(['读代码', 'in_progress'])),
      ...call(todos(['A', 'in_progress'], ['B', 'in_progress'], ['C', 'in_progress']), true)
    ]

    expect(latestTodosFrom(messages, TOOL)).toEqual([
      { content: '读代码', status: 'in_progress', activeForm: '正在读代码' }
    ])
  })

  it('还没有回执的那次不算 —— 中断时最后一条 tool_call 就是孤儿', () => {
    const callId = 'orphan'
    const messages = [
      START,
      ...call(todos(['读代码', 'completed'])),
      assistantMessage('a-orphan', [{ type: 'tool_call', callId, name: TOOL, input: todos(['新的', 'pending']) }], 0)
    ]

    expect(latestTodosFrom(messages, TOOL)?.[0]?.content).toBe('读代码')
  })

  it('★ 工具名对不上 → 静默地什么都没有', () => {
    /*
      转录里存的是 `ToolNamer` 分配的**外部名**。撞名时它带 8 位哈希后缀,
      那时字面匹配 'TodoWrite' 会永远返回 undefined,而且**不报任何错**。
      所以调用方必须走 `tools.byInternalId('TodoWrite')?.externalName`。
      这条用例把这个失败模式本身写下来。
    */
    const messages = [START, ...call(todos(['读代码', 'completed']))]

    expect(latestTodosFrom(messages, 'TodoWrite_a1b2c3d4')).toBeUndefined()
  })

  it('空数组 / 没有任何 TodoWrite → undefined', () => {
    expect(latestTodosFrom([], TOOL)).toBeUndefined()
    expect(latestTodosFrom([START], TOOL)).toBeUndefined()
  })
})

describe('★ 压缩之后还取得到', () => {
  it('compactMessages 只清空 tool_result 的内容,tool_call 原样保留', () => {
    const messages = [
      START,
      ...call(todos(['读代码', 'completed'], ['写代码', 'in_progress'])),
      ...Array.from({ length: 10 }, (_, i) =>
        userMessage(`f${String(i)}`, [{ type: 'text', text: '换个话题' }], 0)
      )
    ]

    const compacted = compactMessages(messages)

    expect(latestTodosFrom(compacted, TOOL)?.length).toBe(2)
  })
})

describe('入参来自模型,一律当 unknown 处理', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'hi',
    { todos: 'hi' },
    { todos: [] },
    { todos: [null] },
    { todos: [{ content: '缺 activeForm', status: 'pending' }] },
    { todos: [{ content: 'x', status: '进行中', activeForm: 'x' }] }
  ]

  it.each(bad.map((v, i) => [i, v] as const))('坏形状 #%i → undefined,不抛', (_i, input) => {
    expect(latestTodosFrom([START, ...call(input)], TOOL)).toBeUndefined()
  })

  it('好项留下、坏项跳过 —— 半份列表好过没有', () => {
    const r = latestTodosFrom(
      [START, ...call({ todos: [{ content: 'A', status: 'pending', activeForm: '正在 A' }, 42] })],
      TOOL
    )

    expect(r).toEqual([{ content: 'A', status: 'pending', activeForm: '正在 A' }])
  })

  it('超过上限的部分截掉 —— 模型能绕过 schema 的那条 .max()', () => {
    const many = Array.from({ length: TODO_LIMITS.MAX_TODOS + 20 }, (_, i) => ({
      content: `t${String(i)}`,
      status: 'pending',
      activeForm: `正在 t${String(i)}`
    }))

    const r = latestTodosFrom([START, ...call({ todos: many })], TOOL)

    expect(r?.length).toBe(TODO_LIMITS.MAX_TODOS)
  })
})

describe('只认 tool_call,不认别的块', () => {
  it('一条 text part 里写着 todos 不算', () => {
    const parts: ContentPart[] = [{ type: 'text', text: JSON.stringify(todos(['假的', 'pending'])) }]

    expect(latestTodosFrom([START, assistantMessage('a1', parts, 0)], TOOL)).toBeUndefined()
  })
})
