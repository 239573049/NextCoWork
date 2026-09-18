import { describe, expect, it } from 'vitest'
import { toolRegistrationFor, type PluginToolDeclaration } from '../tools'

const DECL: PluginToolDeclaration = {
  name: 'make_thing',
  description: 'demo',
  inputSchema: { type: 'object', properties: {} },
  readOnly: true,
  destructive: false,
  needsNetwork: false
}

// 最小 ToolContext:execute 只用到 callId 与 signal。
function ctx(signal: AbortSignal): any {
  return { callId: 'c1', signal, workspaceRoot: '/w', permissionMode: 'default', depth: 0, runId: 'r', host: {}, emit: () => {} }
}

const run = async (raw: unknown, cardViews = new Set<string>()): Promise<{ content: string; card?: unknown }> => {
  const reg = toolRegistrationFor('acme.demo', DECL, async () => raw, cardViews)
  const ac = new AbortController()
  const result = await reg.execute({}, ctx(ac.signal))
  return { content: result.output.content, card: result.output.card }
}

describe('toolRegistrationFor · card 落地', () => {
  it('合法 declarative card 挂到 output.card,content 不含 card 数据', async () => {
    const out = await run({
      content: [{ text: '已排期' }],
      card: { kind: 'declarative', blocks: [{ type: 'status', label: '进行中', tone: 'ok' }] }
    })
    expect(out.content).toBe('已排期')
    expect(out.card).toEqual({ kind: 'declarative', blocks: [{ type: 'status', label: '进行中', tone: 'ok' }] })
  })

  it('★ 非法 card 被丢弃,只保留文本(卡片是锦上添花)', async () => {
    const out = await run({ content: [{ text: 'ok' }], card: { kind: 'declarative', blocks: [{ type: 'link', href: 'file:///etc/passwd' }] } })
    expect(out.content).toBe('ok')
    expect(out.card).toBeUndefined()
  })

  it('★ 有 card 但 content 非数组时,不把整对象塞进模型可见文本', async () => {
    const out = await run({ card: { kind: 'declarative', blocks: [{ type: 'text', value: '看卡片' }] } })
    expect(out.content).toBe('') // 不是 JSON.stringify(raw)
    expect(out.card).toBeDefined()
  })

  it('frame card 的 viewType 必须在该插件 cardViews 内', async () => {
    const bad = await run({ content: [{ text: 'x' }], card: { kind: 'frame', viewType: 'task.card', data: {} } }, new Set())
    expect(bad.card).toBeUndefined()
    const ok = await run({ content: [{ text: 'x' }], card: { kind: 'frame', viewType: 'task.card', data: { n: 1 } } }, new Set(['task.card']))
    expect(ok.card).toEqual({ kind: 'frame', viewType: 'task.card', data: { n: 1 } })
  })

  it('纯字符串结果没有 card,老行为不变', async () => {
    const out = await run('just text')
    expect(out.content).toBe('just text')
    expect(out.card).toBeUndefined()
  })
})
