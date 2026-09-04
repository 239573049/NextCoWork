/**
 * `TodoWrite` —— 模型自己的任务清单。
 *
 * ★ **完全无状态,这是它最反直觉也最重要的一点。**
 *
 * 直觉上这个工具该往某个 store 里写一份清单,下一轮再读回来。不需要:
 * 每一轮请求都会把**整条转录**重放给模型,而这次调用的 `tool_use`(连同它的
 * `todos` 入参)就在转录里 —— **转录本身就是那份状态**。
 *
 * 真去存一份的坏处是具体的:那份存下来的清单和转录里的会分叉(中断、重试、
 * 编辑历史消息之后),而模型看见的永远是转录里的那份。于是就有了一份
 * 谁也不看、却会在界面上显示的「幽灵清单」。
 *
 * 所以这里只做两件事:**校验**(把会让清单失去意义的形状挡回去),
 * 和**回显**(让模型确认它写下的东西被收到了)。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'

/** 再多就不是「计划」而是「清单癖」了 —— 而且每一轮都要重发一遍 */
const MAX_TODOS = 40

const TodoItem = z.object({
  content: z.string().min(1).max(500).describe('任务内容,祈使句,例如「跑测试」'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
  activeForm: z
    .string()
    .min(1)
    .max(500)
    .describe('进行时的说法,例如「正在跑测试」—— 这一条进行中时界面上显示的就是它')
})

const TodoWriteInput = z.object({
  todos: z.array(TodoItem).max(MAX_TODOS).describe('完整的任务清单。**每次都要发全量**,不是增量')
})

const MARK: Record<z.infer<typeof TodoItem>['status'], string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]'
}

export const todoWriteTool: ToolRegistration = defineTool({
  internalId: 'TodoWrite',
  description:
    '用这个工具管理当前任务的清单。它能帮你把工作拆开、记住进度,也让用户看得见你在做什么。\n\n' +
    '什么时候该用:\n' +
    '- 任务需要三步以上,或者要动多个文件\n' +
    '- 用户一口气给了好几件事(编号的、逗号分隔的都算)\n' +
    '- 任务不简单、值得先想清楚顺序\n' +
    '- 刚拿到需求时:先列出来,再开工\n' +
    '- 开始做某一项之前:把它标成 in_progress\n' +
    '- 做完某一项之后:**立刻**标成 completed,不要攒着一起标\n\n' +
    '什么时候不用:\n' +
    '- 只有一步、而且很直接的事\n' +
    '- 纯粹是回答一个问题、解释一段代码\n' +
    '- 三两下就做完的事 —— 这时候用它反而是噪音\n\n' +
    '怎么用:\n' +
    '- **每次都发全量清单**,不是只发变化的那几条。发什么,清单就变成什么\n' +
    '- 状态只有三种:pending(还没开始)、in_progress(正在做)、completed(做完了)\n' +
    '- ★ **同一时刻只能有一项 in_progress**。全都标成进行中等于没有计划,' +
    '而用户在界面上看到的是「它同时在做五件事」\n' +
    '- content 用祈使句(「跑测试」),activeForm 用进行时(「正在跑测试」),两个都要给\n' +
    '- 只有**真的做完并且验证过**才标 completed。测试还红着、实现还缺一半,就留在 in_progress,' +
    '并另开一条把没做完的部分写清楚\n' +
    '- 做不下去时不要标 completed:留着它,再加一条说明卡在哪里',
  schema: TodoWriteInput,
  /*
    ★ readOnly。它不碰磁盘、不碰网络,而 plan 模式(`readOnlyOnly` 快照)
    恰恰是最需要列清单的时候 —— 标成非只读,计划模式下模型就没法写计划了。
  */
  readOnly: true,
  destructive: false,
  // eslint-disable-next-line @typescript-eslint/require-await -- 契约要求 Promise;这个工具本身没有任何异步的事要做
  async run(input) {
    const { todos } = input

    if (todos.length === 0) {
      return toolFail(
        '任务清单是空的。要么给出至少一条任务,要么就别调用这个工具 —— ' +
          '发一个空清单会把界面上已经列出来的计划抹掉。'
      )
    }

    /*
      ★ 这条校验是有实际作用的,不是洁癖:多个 in_progress 时,界面上那行
      「正在……」不知道该显示哪一条,而模型也就失去了「我现在在做哪一步」这个锚点。
      拒绝并说清楚,比默默接受一份没有意义的清单要好。
    */
    const active = todos.filter((t) => t.status === 'in_progress')
    if (active.length > 1) {
      return toolFail(
        `同一时刻只能有一项 in_progress,你给了 ${String(active.length)} 项:` +
          `${active.map((t) => `「${t.content}」`).join('、')}。` +
          `请只保留你**此刻**真正在做的那一项,其余的改回 pending。`
      )
    }

    const done = todos.filter((t) => t.status === 'completed').length
    const body = todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n')

    return toolOk(
      `清单已更新(${String(done)}/${String(todos.length)} 完成):\n${body}\n\n` +
        `继续按这份清单做。做完一项就立刻再调一次这个工具把它标掉,不要等到最后一起标。`
    )
  }
})

export const TODO_LIMITS = { MAX_TODOS } as const
