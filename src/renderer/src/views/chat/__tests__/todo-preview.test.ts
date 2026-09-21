import { describe, expect, it } from 'vitest'
import { previewTodos } from '../todo-preview'

/**
 * 工具卡片里的清单与输入框上方那张是同一个组件,所以这一层的错法只有一种形态:
 * 半截入参被原样塞给 `TaskChecklist`,画出一行空白或一个不存在的状态 ——
 * 两者都不报错,靠盯着流式过程才可能撞见。
 */
describe('TodoWrite · 清单投影', () => {
  it('缺 activeForm 时退回 content —— 「进行中」那一行显示的正是它', () => {
    expect(previewTodos({ todos: [{ content: '读代码', status: 'in_progress' }] })).toEqual([
      { content: '读代码', activeForm: '读代码', status: 'in_progress' }
    ])
  })

  it('★ content 还没流出来的条目直接丢掉,不画一行空白', () => {
    expect(previewTodos({ todos: [{}, { activeForm: '正在读' }, 'x'] })).toEqual([])
  })

  it('认不出的状态按 pending 算,与内核 schema 的默认值一致', () => {
    expect(previewTodos({ todos: [{ content: 'a', status: 'halfway' }, { content: 'b' }] })).toEqual([
      { content: 'a', activeForm: 'a', status: 'pending' },
      { content: 'b', activeForm: 'b', status: 'pending' }
    ])
  })

  it('三档状态原样保留 —— 清单的进度环靠它算', () => {
    const todos = previewTodos({
      todos: [
        { content: 'a', activeForm: 'A', status: 'completed' },
        { content: 'b', activeForm: 'B', status: 'in_progress' },
        { content: 'c', activeForm: 'C', status: 'pending' }
      ]
    })
    expect(todos.map((todo) => todo.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('入参还是无法解析的 JSON 前缀或根本没有 todos 时,返回空清单', () => {
    expect(previewTodos('{"todos":[{"cont')).toEqual([])
    expect(previewTodos({ todos: 'soon' })).toEqual([])
    expect(previewTodos(undefined)).toEqual([])
  })
})
