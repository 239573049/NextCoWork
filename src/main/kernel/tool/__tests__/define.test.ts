import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { toolOk, type ToolProgress } from '../../../../shared/agent/tool'
import { nodeHost } from '../../host'
import { builtinTools, echoTool } from '../builtin'
import { defineTool } from '../define'
import type { ToolContext } from '../registry'

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: '/ws',
    signal: new AbortController().signal,
    permissionMode: 'ask',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    // nodeHost() 结构上满足 ToolHost —— 不用手搓假对象
    host: nodeHost(),
    emit: () => {},
    ...over
  }
}

describe('defineTool · 入参校验', () => {
  const tool = defineTool({
    internalId: 't',
    description: 'd',
    schema: z.object({ n: z.number(), s: z.string().optional() }),
    readOnly: true,
    destructive: false,
    run: async (input) => toolOk(`n=${input.n}`)
  })

  it('合法入参解析后交给 run', async () => {
    expect((await tool.execute({ n: 42 }, ctx())).output.content).toBe('n=42')
  })

  /**
   * ★ `input` 是**模型生成**的,可以是任何东西。
   * 校验失败必须是一个工具**结果**,不是一个异常 —— 异常会打死整个 run,
   * 而模型看到「参数不对」是能自己改正重试的。
   */
  it('入参不合法时返回工具错误而不是抛出', async () => {
    const r = await tool.execute({ n: '不是数字' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('n')
  })

  it('完全不是对象也不崩', async () => {
    for (const bad of [null, undefined, 42, 'str', []]) {
      const r = await tool.execute(bad, ctx())
      expect(r.isError, String(bad)).toBe(true)
    }
  })

  /** 错误信息要**指名道姓**,模型才知道改哪个字段 */
  it('错误信息里带字段路径', async () => {
    const nested = defineTool({
      internalId: 'n',
      description: 'd',
      schema: z.object({ opts: z.object({ depth: z.number() }) }),
      readOnly: true,
      destructive: false,
      run: async () => toolOk('x')
    })
    const r = await nested.execute({ opts: { depth: 'deep' } }, ctx())
    expect(r.output.content).toContain('opts.depth')
  })
})

describe('defineTool · 异常收敛', () => {
  /**
   * ★ 方案 §4.11:`tool_failed` **进转录并继续循环**。
   * 工具抛出的错误让整个 run 消失,是手写 Agent 循环最容易做错的分类之一。
   */
  it('run 抛出普通错误时变成工具错误', async () => {
    const tool = defineTool({
      internalId: 't',
      description: 'd',
      schema: z.object({}),
      readOnly: true,
      destructive: false,
      run: async () => {
        throw new Error('ENOENT: 文件不存在')
      }
    })
    const r = await tool.execute({}, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('ENOENT')
  })

  it('抛出非 Error 也能收敛', async () => {
    const tool = defineTool({
      internalId: 't',
      description: 'd',
      schema: z.object({}),
      readOnly: true,
      destructive: false,
      run: async () => {
        throw '一个字符串'
      }
    })
    expect((await tool.execute({}, ctx())).isError).toBe(true)
  })

  /**
   * ★ 唯一的例外。中断被伪装成工具失败的话,模型会看到「工具失败了」
   * 然后**继续往下跑** —— 用户点了停止,对话却还在动。
   */
  it('中断原样抛出,不伪装成工具失败', async () => {
    const tool = defineTool({
      internalId: 't',
      description: 'd',
      schema: z.object({}),
      readOnly: true,
      destructive: false,
      run: async () => {
        throw new DOMException('aborted', 'AbortError')
      }
    })
    await expect(tool.execute({}, ctx())).rejects.toThrow(/abort/i)
  })
})

describe('defineTool · schema 导出', () => {
  const tool = defineTool({
    internalId: 't',
    description: 'd',
    schema: z.object({ text: z.string().describe('要回显的文本') }),
    readOnly: true,
    destructive: false,
    run: async () => toolOk('x')
  })

  /** `$schema` 对上游没有意义,但每次请求都要为它付 token */
  it('剥掉 $schema', () => {
    expect(tool.inputSchema).not.toHaveProperty('$schema')
  })

  it('保留 type / properties / required 与字段描述', () => {
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    })
  })

  /** schema 要跟着请求体走一趟 JSON,也要经 IPC 给设置页 */
  it('能通过结构化克隆', () => {
    expect(() => structuredClone(tool.inputSchema)).not.toThrow()
  })

  it('source 默认是 builtin', () => {
    expect(tool.source).toEqual({ kind: 'builtin' })
  })
})

describe('echo 工具', () => {
  it('原样返回文本', async () => {
    const r = await echoTool.execute({ text: '你好' }, ctx())
    expect(r).toMatchObject({ isError: false, output: { content: '你好' } })
  })

  it('缺 text 时是工具错误', async () => {
    expect((await echoTool.execute({}, ctx())).isError).toBe(true)
  })

  it('等待期间发进度事件', async () => {
    const emitted: ToolProgress[] = []
    const r = await echoTool.execute(
      { text: 'x', delayMs: 1 },
      ctx({ emit: (p) => emitted.push(p), callId: 'c9' })
    )
    expect(r.isError).toBe(false)
    expect(emitted).toEqual([{ callId: 'c9', message: '等待 1ms' }])
  })

  it('不等待时不发进度', async () => {
    const emit = vi.fn()
    await echoTool.execute({ text: 'x' }, ctx({ emit }))
    expect(emit).not.toHaveBeenCalled()
  })

  /**
   * ★ 方案 §4.3:`ctx.signal` 必须**真的传到 execute 体内**。
   * 只中断 HTTP 流而不管工具体,会留下一堆僵尸 shell 和还在写的文件。
   */
  it('等待途中被中断则抛出', async () => {
    const ac = new AbortController()
    const p = echoTool.execute({ text: 'x', delayMs: 10_000 }, ctx({ signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('已中断的 signal 立刻抛出', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      echoTool.execute({ text: 'x', delayMs: 5 }, ctx({ signal: ac.signal }))
    ).rejects.toThrow(/abort/i)
  })

  it('delayMs 上限外的值是工具错误', async () => {
    expect((await echoTool.execute({ text: 'x', delayMs: -1 }, ctx())).isError).toBe(true)
    expect((await echoTool.execute({ text: 'x', delayMs: 999_999 }, ctx())).isError).toBe(true)
  })

  it('builtinTools 包含 echo 且 internalId 唯一', () => {
    const ids = builtinTools().map((t) => t.internalId)
    expect(ids).toContain('echo')
    expect(new Set(ids).size).toBe(ids.length)
  })
})
