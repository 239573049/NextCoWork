import { describe, expect, it } from 'vitest'
import { ToolCallAccumulator } from '../agent/stream'
import { assistantMessage, orphanedToolCalls, userMessage } from '../agent/message'
import type { ContentPart } from '../agent/message'
import { minPermission } from '../agent/permission'

/**
 * 这三组测的都是方案 §10「看着可砍但不能砍」清单里的东西。
 * 它们的共同点:出错时的症状离病根很远 ——
 * 一个 400、一次提权、一次静默丢工具,都不会指向这几十行代码。
 */

describe('ToolCallAccumulator', () => {
  it('分片累积后只 parse 一次', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'read_file')
    a.delta('c1', '{"pa')
    a.delta('c1', 'th":"a.ts"')
    a.delta('c1', '}')
    expect(a.end('c1')).toEqual({ ok: true, name: 'read_file', input: { path: 'a.ts' } })
  })

  it('零 delta 归一成 {} —— 无参工具的上游可能一个 delta 都不发', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'list_tools')
    expect(a.end('c1')).toEqual({ ok: true, name: 'list_tools', input: {} })
  })

  it('全空白也归一成 {}', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'noop')
    a.delta('c1', '   \n')
    expect(a.end('c1')).toEqual({ ok: true, name: 'noop', input: {} })
  })

  it('★ 非法 JSON 返回 ok:false 而不是抛异常 —— 抛出去会打断整个 Agent 循环', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'write_file')
    a.delta('c1', '{"path":') // 流式中途被截断
    const r = a.end('c1')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.name).toBe('write_file') // 名字要留住,才能生成有意义的工具错误
      expect(r.raw).toBe('{"path":')
      expect(r.reason).toBeTruthy()
    }
  })

  it('没见过 start 的 callId 不抛,返回 ok:false', () => {
    const a = new ToolCallAccumulator()
    const r = a.end('ghost')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ghost')
  })

  it('end 之后条目被清掉,不会二次产出', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 't')
    a.delta('c1', '{}')
    expect(a.end('c1').ok).toBe(true)
    expect(a.end('c1').ok).toBe(false)
    expect(a.pending()).toEqual([])
  })

  it('pending() 报告未闭合的调用 —— 中断收尾靠它补 tool_result', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'slow_tool')
    a.start('c2', 'other')
    a.delta('c2', '{}')
    a.end('c2')
    expect(a.pending()).toEqual([{ callId: 'c1', name: 'slow_tool' }])
  })

  it('并行工具调用互不串扰', () => {
    const a = new ToolCallAccumulator()
    a.start('c1', 'one')
    a.start('c2', 'two')
    a.delta('c1', '{"x":')
    a.delta('c2', '{"y":2}')
    a.delta('c1', '1}')
    expect(a.end('c2')).toEqual({ ok: true, name: 'two', input: { y: 2 } })
    expect(a.end('c1')).toEqual({ ok: true, name: 'one', input: { x: 1 } })
  })
})

describe('orphanedToolCalls —— 中断收尾(方案 §4.8 第 4 步)', () => {
  const call = (callId: string, name: string): ContentPart => ({
    type: 'tool_call',
    callId,
    name,
    input: {}
  })
  const result = (callId: string): ContentPart => ({
    type: 'tool_result',
    callId,
    output: { content: 'ok' },
    isError: false
  })

  it('全部配对时没有孤儿', () => {
    const ms = [
      assistantMessage('m1', [call('c1', 'read')], 1),
      userMessage('m2', [result('c1')], 2)
    ]
    expect(orphanedToolCalls(ms)).toEqual([])
  })

  it('★ 未配对的 tool_call 被揪出来 —— 漏掉它下一轮请求就是 400', () => {
    const ms = [assistantMessage('m1', [call('c1', 'read'), call('c2', 'write')], 1)]
    expect(orphanedToolCalls(ms)).toEqual([
      { callId: 'c1', name: 'read' },
      { callId: 'c2', name: 'write' }
    ])
  })

  it('只补没配对的那个', () => {
    const ms = [
      assistantMessage('m1', [call('c1', 'read'), call('c2', 'write')], 1),
      userMessage('m2', [result('c1')], 2)
    ]
    expect(orphanedToolCalls(ms)).toEqual([{ callId: 'c2', name: 'write' }])
  })

  it('tool_result 跨多条消息也算配对', () => {
    const ms = [
      assistantMessage('m1', [call('c1', 'a')], 1),
      assistantMessage('m2', [{ type: 'text', text: '稍等' }], 2),
      userMessage('m3', [result('c1')], 3)
    ]
    expect(orphanedToolCalls(ms)).toEqual([])
  })

  it('空转录不炸', () => {
    expect(orphanedToolCalls([])).toEqual([])
  })
})

describe('minPermission —— 子代理不继承 full(方案 §4.9)', () => {
  it('取更严格的一档', () => {
    expect(minPermission('full', 'ask')).toBe('ask')
    expect(minPermission('ask', 'full')).toBe('ask')
    expect(minPermission('full', 'auto')).toBe('auto')
    expect(minPermission('auto', 'ask')).toBe('ask')
  })

  it('相同档位原样返回', () => {
    expect(minPermission('full', 'full')).toBe('full')
    expect(minPermission('ask', 'ask')).toBe('ask')
  })

  it('★ full 永远不可能凭空产生 —— 这是提权路径的封堵点', () => {
    const modes = ['ask', 'auto', 'full'] as const
    for (const a of modes) {
      for (const b of modes) {
        if (a !== 'full' || b !== 'full') expect(minPermission(a, b)).not.toBe('full')
      }
    }
  })

  it('可交换 —— 参数顺序不影响结果', () => {
    const modes = ['ask', 'auto', 'full'] as const
    for (const a of modes) {
      for (const b of modes) {
        expect(minPermission(a, b)).toBe(minPermission(b, a))
      }
    }
  })
})
