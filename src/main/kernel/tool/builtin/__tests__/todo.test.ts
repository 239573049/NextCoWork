import { describe, expect, it } from 'vitest'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { TODO_LIMITS, todoWriteTool } from '../todo'

/**
 * `TodoWrite` 的测试。
 *
 * ★ 这个文件里最重要的一条是**反向断言**:调用两次之后,第二次的结果里
 * 不含第一次的任何内容。它钉的是文件头那段「完全无状态」——
 * 谁哪天顺手在这里加一个 module 级的 `let current`,这条会立刻红。
 */

function ctx(): ToolContext {
  return {
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {}
  }
}

type Status = 'pending' | 'in_progress' | 'completed'
const todo = (content: string, status: Status): object => ({
  content,
  status,
  activeForm: `正在${content}`
})

describe('TodoWrite · 标记', () => {
  /**
   * ★ 这不是「填对一个字段」,而是一个功能开关:
   * `snapshot({ readOnlyOnly: true })` 只留只读工具,而计划模式恰恰是最需要
   * 列清单的时候。标成非只读的话,plan 模式下模型连计划都写不了。
   */
  it('★ readOnly —— plan 模式的快照必须留住它', () => {
    expect(todoWriteTool.readOnly).toBe(true)
    expect(todoWriteTool.destructive).toBe(false)
    expect(todoWriteTool.needsNetwork).toBe(false)
  })
})

describe('TodoWrite · 校验', () => {
  it('★ 空清单被拒,并说清为什么(它会抹掉界面上已有的计划)', async () => {
    const r = await todoWriteTool.execute({ todos: [] }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('empty')
    expect(r.output.content).toContain('wipes out')
  })

  it('一项 in_progress 是合法的', async () => {
    const r = await todoWriteTool.execute({ todos: [todo('跑测试', 'in_progress')] }, ctx())
    expect(r.isError).toBeFalsy()
  })

  it('零项 in_progress 也是合法的(全 pending 或全 completed)', async () => {
    const a = await todoWriteTool.execute({ todos: [todo('跑测试', 'pending')] }, ctx())
    expect(a.isError).toBeFalsy()
    const b = await todoWriteTool.execute({ todos: [todo('跑测试', 'completed')] }, ctx())
    expect(b.isError).toBeFalsy()
  })

  it('★ 两项 in_progress 被拒,且拒绝信息里点名是哪几项', async () => {
    const r = await todoWriteTool.execute(
      {
        todos: [
          todo('改代码', 'in_progress'),
          todo('跑测试', 'in_progress'),
          todo('提交', 'pending')
        ]
      },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('you sent 2')
    // ★ 点名 —— 只说「有多个」的话模型得自己回去数,而它多半会重发一份同样的清单
    expect(r.output.content).toContain('改代码')
    expect(r.output.content).toContain('跑测试')
    expect(r.output.content).not.toContain('提交')
    // 给出改法,不是只说不行
    expect(r.output.content).toContain('pending')
  })
})

describe('TodoWrite · schema', () => {
  it(`超过 ${String(TODO_LIMITS.MAX_TODOS)} 项被 schema 挡回`, async () => {
    const todos = Array.from({ length: TODO_LIMITS.MAX_TODOS + 1 }, (_, i) =>
      todo(`第 ${String(i)} 步`, 'pending')
    )
    const r = await todoWriteTool.execute({ todos }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })

  it(`正好 ${String(TODO_LIMITS.MAX_TODOS)} 项可以过`, async () => {
    const todos = Array.from({ length: TODO_LIMITS.MAX_TODOS }, (_, i) =>
      todo(`第 ${String(i)} 步`, 'pending')
    )
    const r = await todoWriteTool.execute({ todos }, ctx())
    expect(r.isError).toBeFalsy()
  })

  it('认不出的 status 被挡回', async () => {
    const r = await todoWriteTool.execute(
      { todos: [{ content: 'x', status: 'doing', activeForm: 'y' }] },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })

  it('★ activeForm 是必填 —— 缺了界面上那行「正在……」就没东西可显示', async () => {
    const r = await todoWriteTool.execute(
      { todos: [{ content: 'x', status: 'pending' }] },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })

  it('空的 content 被挡回', async () => {
    const r = await todoWriteTool.execute(
      { todos: [{ content: '', status: 'pending', activeForm: 'x' }] },
      ctx()
    )
    expect(r.isError).toBe(true)
  })

  it('todos 完全缺失时被挡回,不是当成空清单', async () => {
    const r = await todoWriteTool.execute({}, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })
})

describe('TodoWrite · 回显', () => {
  it('三种状态各有各的记号,顺序按模型给的来', async () => {
    const r = await todoWriteTool.execute(
      {
        todos: [
          todo('读代码', 'completed'),
          todo('改代码', 'in_progress'),
          todo('跑测试', 'pending')
        ]
      },
      ctx()
    )
    const lines = r.output.content.split('\n')
    expect(lines).toContain('[x] 读代码')
    expect(lines).toContain('[~] 改代码')
    expect(lines).toContain('[ ] 跑测试')
    expect(lines.indexOf('[x] 读代码')).toBeLessThan(lines.indexOf('[~] 改代码'))
  })

  it('完成计数是 完成数/总数', async () => {
    const r = await todoWriteTool.execute(
      {
        todos: [
          todo('a', 'completed'),
          todo('b', 'completed'),
          todo('c', 'in_progress'),
          todo('d', 'pending')
        ]
      },
      ctx()
    )
    expect(r.output.content).toContain('2/4 completed')
  })

  /** ★ 不催一句的话,模型会把一整轮的事做完再一次性全标 completed —— 界面上就是长时间没动静 */
  it('★ 成功回显里催一句「做完一项就立刻标掉」', async () => {
    const r = await todoWriteTool.execute({ todos: [todo('a', 'pending')] }, ctx())
    expect(r.output.content).toContain('As soon as an item is done')
  })

  it('activeForm 不进回显 —— 它是给界面用的,不是给模型看的', async () => {
    const r = await todoWriteTool.execute({ todos: [todo('跑测试', 'pending')] }, ctx())
    expect(r.output.content).toContain('跑测试')
    expect(r.output.content).not.toContain('正在跑测试')
  })
})

describe('TodoWrite · 无状态', () => {
  /**
   * ★ 这一条钉的是文件头那段设计说明。
   *
   * 转录本身就是那份状态:每一轮都会把这次调用的 `tool_use`(连同 `todos` 入参)
   * 重放给模型。这里再存一份的话,那一份会在中断/重试/编辑历史之后和转录分叉,
   * 于是就有了一份谁也不看、却会显示在界面上的「幽灵清单」。
   */
  it('★ 第二次调用完全不知道第一次发生过', async () => {
    await todoWriteTool.execute({ todos: [todo('第一批', 'completed')] }, ctx())
    const r = await todoWriteTool.execute({ todos: [todo('第二批', 'pending')] }, ctx())
    expect(r.output.content).toContain('第二批')
    expect(r.output.content).not.toContain('第一批')
    expect(r.output.content).toContain('0/1 completed')
  })
})

describe('TodoWrite · 描述里那三条硬规则', () => {
  const d = todoWriteTool.description

  it('★ 说清了要发全量 —— 不说的话模型会发增量,清单每轮都被截短', () => {
    expect(d).toContain('send the complete list')
  })

  it('★ 说清了同一时刻只能有一项 in_progress —— 和上面那条校验是一对', () => {
    expect(d).toContain('EXACTLY ONE item may be in_progress')
  })

  it('★ 说清了没验证过不许标 completed', () => {
    expect(d).toContain('done AND verified')
    expect(d).toContain('completed')
  })

  it('也说清了什么时候不该用它 —— 否则回答一个问题也要先列清单', () => {
    expect(d).toContain('When NOT to use it')
  })
})
