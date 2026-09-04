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
import type { AgentMessage } from '../../../../shared/agent/message'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'

/** 再多就不是「计划」而是「清单癖」了 —— 而且每一轮都要重发一遍 */
const MAX_TODOS = 40

const TodoItemSchema = z.object({
  content: z.string().min(1).max(500).describe('The task, in imperative form, e.g. "Run the tests"'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('The task state'),
  activeForm: z
    .string()
    .min(1)
    .max(500)
    .describe('The present continuous form, e.g. "Running the tests" — this is what the UI shows while it is in progress')
})

const TodoWriteInput = z.object({
  todos: z
    .array(TodoItemSchema)
    .max(MAX_TODOS)
    .describe('The complete task list. ALWAYS send the WHOLE list, never a delta')
})

/**
 * 一条待办。★ **导出**是因为 `context-assembler.ts` 要把当前清单渲染进
 * `<system-reminder>`,而「这个形状长什么样」不该有两份答案(见 `text.ts` 文件头)。
 */
export type TodoItem = z.infer<typeof TodoItemSchema>

/**
 * 清单的渲染标记。★ 同样导出:reminder 里那份快照和工具自己的回显必须长得一样,
 * 否则模型会以为那是两份不同的清单。
 */
export const MARK: Record<TodoItem['status'], string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]'
}

export const todoWriteTool: ToolRegistration = defineTool({
  internalId: 'TodoWrite',
  description:
    'Use this tool to manage a task list for the work in front of you. It helps you break the work up, ' +
    'keeps track of where you are, and shows the user what you are doing.\n\n' +
    'When to use it:\n' +
    '- The task takes three or more steps, or touches several files\n' +
    '- The user gave you several things at once (numbered, or comma-separated)\n' +
    '- The task is non-trivial and the order matters\n' +
    '- As soon as you receive the request: write the list first, then start\n' +
    '- Before starting an item: mark it in_progress\n' +
    '- After finishing an item: mark it completed IMMEDIATELY. Do NOT batch completions up\n\n' +
    'When NOT to use it:\n' +
    '- A single, straightforward step\n' +
    '- Purely answering a question or explaining some code\n' +
    '- Anything you can finish in a couple of actions — here the list is just noise\n\n' +
    'How to use it:\n' +
    '- ALWAYS send the complete list, not just the entries that changed. What you send IS the list\n' +
    '- There are exactly three states: pending (not started), in_progress (working on it now), ' +
    'completed (done)\n' +
    '- IMPORTANT: EXACTLY ONE item may be in_progress at a time. Marking everything in progress is the ' +
    'same as having no plan, and the user sees "it is doing five things at once"\n' +
    '- content is imperative ("Run the tests"), activeForm is present continuous ("Running the tests"). ' +
    'Both are required\n' +
    '- Mark completed ONLY when the work is actually done AND verified. If tests are still failing or the ' +
    'implementation is half-finished, leave it in_progress and add a new entry describing what is left\n' +
    '- NEVER mark something completed because you got stuck. Leave it, and add an entry saying what blocked you',
  schema: TodoWriteInput,
  /*
    ★ readOnly。它不碰磁盘、不碰网络,而 plan 模式(`readOnlyOnly` 快照)
    恰恰是最需要列清单的时候 —— 标成非只读,计划模式下模型就没法写计划了。
  */
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  // 契约要求返回 Promise;这个工具本身没有任何异步的事要做
  async run(input) {
    const { todos } = input

    if (todos.length === 0) {
      return toolFail(
        'The task list is empty. Either send at least one task, or do not call this tool at all — ' +
          'an empty list wipes out the plan the user can already see.'
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
        `Exactly one item may be in_progress at a time, and you sent ${String(active.length)}: ` +
          `${active.map((t) => `"${t.content}"`).join(', ')}. ` +
          `Keep only the one you are ACTUALLY working on right now, and set the rest back to pending.`
      )
    }

    const done = todos.filter((t) => t.status === 'completed').length
    const body = todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n')

    return toolOk(
      `Todo list updated (${String(done)}/${String(todos.length)} completed):\n${body}\n\n` +
        `Keep working through this list. As soon as an item is done, call this tool again to mark it — ` +
        `do NOT wait and mark them all at the end.`
    )
  }
})

export const TODO_LIMITS = { MAX_TODOS } as const

// ─────────────────────────── 从转录反推当前清单 ───────────────────────────

/**
 * 把「当前的待办清单」从转录里读回来。
 *
 * ★ 这**不违反**文件头那条无状态设计,反而是它的直接推论:当前清单已经在
 * 转录里了 —— 就是最近一次成功的 `TodoWrite` 调用的入参。所以这仍然是一个
 * **对转录的纯函数**,唯一真相源没有变,分叉不可能发生。
 *
 * 调用方(`context-assembler.ts`)拿它做的事,只是把已经存在的事实
 * **搬到离生成点更近的地方** —— 二十轮之前的那条 `tool_call`,模型翻不动了。
 *
 * ## 三处会踩空的地方
 *
 * 1. ★ **必须确认那次调用真的成功了。** `agent-session.ts` 是**先** commit
 *    `tool_call`、**后**在 `executeAll` → `defineTool` → `safeParse` 里校验的,
 *    所以被工具明确拒绝过的清单(两个 in_progress、空数组、坏 JSON)也原样
 *    躺在转录里。盲取最近一条 = 把工具拒绝过的东西当成当前进度渲染出去。
 *    判据是配对的 `tool_result` 存在**且** `isError === false`。
 * 2. ★ **`toolName` 是 `externalName`,要从注册表查**(`byInternalId('TodoWrite')`),
 *    不能写字面量、也不能从本轮的 `advertised` 快照里取。转录里存的是
 *    `ToolNamer` 分配的外部名,撞名时会带 8 位哈希后缀;而 `advertised`
 *    被 `readOnlyOnly` / `allowList` / `network` 过滤过,一个 `tools:` 写得窄的
 *    子代理会因此看不见**它自己刚写的**清单。两种错都是**静默**的。
 * 3. ★ **入参是 `unknown`,来源是模型** —— 这里做结构化窄化,不 throw、不引 zod。
 *
 * 压缩吃不掉它:`compactPart()` 只动 `tool_result` / `thinking` / `image`,
 * `tool_call` 走 `default: return p` 原样保留。
 */
export function latestTodosFrom(
  messages: readonly AgentMessage[],
  toolName: string
): readonly TodoItem[] | undefined {
  // 先把 callId → 成功与否收成一张表,省得对每个候选再正向扫一遍
  const ok = new Map<string, boolean>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_result') ok.set(p.callId, !p.isError)
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p === undefined || p.type !== 'tool_call' || p.name !== toolName) continue
      // 还没跑完的那次不算(没有配对结果),被拒绝的那次也不算
      if (ok.get(p.callId) !== true) continue
      const todos = narrowTodos(p.input)
      if (todos !== undefined) return todos
    }
  }
  return undefined
}

function narrowTodos(input: unknown): readonly TodoItem[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw: unknown = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return undefined

  const out: TodoItem[] = []
  for (const item of raw.slice(0, MAX_TODOS)) {
    if (typeof item !== 'object' || item === null) continue
    const { content, status, activeForm } = item as Record<string, unknown>
    if (typeof content !== 'string' || typeof activeForm !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    out.push({ content, status, activeForm })
  }
  return out.length > 0 ? out : undefined
}
