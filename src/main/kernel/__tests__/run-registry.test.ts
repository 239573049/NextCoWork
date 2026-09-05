import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../shared/agent/event'
import { assistantMessage } from '../../../shared/agent/message'
import type { RunRequest } from '../../../shared/agent/run-request'
import { RunRegistry, RunHandle, collect } from '../run-registry'

/**
 * RunRegistry 是方案 §10「看着可砍但不能砍」清单里的一条。
 * 它解决多消费者、重放、背压、嵌套四件事,而这四件事出问题时的症状
 * ——「重载后 UI 空白」「第二个窗口收不到」「转录里少一段」——
 * 全都不会指向这个文件。
 */

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: 'r1',
  sessionId: 's1',
  workspaceId: 'w1',
  depth: 0,
  input: [],
  mode: 'normal',
  thinking: 'auto',
  webSearch: false,
  permissionMode: 'ask',
  model: 'test',
  skillIds: [],
  ...over
})

const textDelta = (text: string): AgentEvent => ({
  type: 'stream',
  delta: { type: 'text_delta', index: 0, text }
})
const commit = (id: string, text: string): AgentEvent => ({
  type: 'message_commit',
  message: assistantMessage(id, [{ type: 'text', text }], 1)
})

describe('RunHandle · seq 与重放', () => {
  it('seq 从 1 开始,每次 emit 递增', () => {
    const h = new RunHandle(req())
    expect(h.emit(textDelta('a'))).toBe(1)
    expect(h.emit(textDelta('b'))).toBe(2)
    expect(h.seq).toBe(2)
  })

  it('since(0) 给出全部,since(n) 给出其后的', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('a'))
    h.emit(textDelta('b'))
    h.emit(textDelta('c'))
    expect(h.since(0)).toHaveLength(3)
    expect(h.since(2)).toEqual([textDelta('c')])
    expect(h.since(3)).toEqual([])
    // 未来的 seq 不应该凭空变出事件来
    expect(h.since(99)).toEqual([])
  })

  it('★ message_commit 之后,seq 仍然连续 —— 裁剪不能影响编号', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('a'))
    h.emit(commit('m1', 'a'))
    // 裁剪掉了一条日志,但 seq 计数器不受影响:
    // 下一个事件必须是 3,否则渲染层的 lastSeq+1 检查会永远误报缺口。
    expect(h.emit(textDelta('b'))).toBe(3)
  })
})

describe('RunHandle · 日志裁剪(方案 §4.7)', () => {
  it('★ 提交会顶掉它之前的 delta —— 但保留提交本身', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('你'))
    h.emit(textDelta('好'))
    h.emit(commit('m1', '你好'))

    const replay = h.since(0)
    // 三条进去,一条出来:两条 delta 的内容已经在提交的消息里了
    expect(replay).toHaveLength(1)
    expect(replay[0]?.type).toBe('message_commit')
  })

  it('★ 裁剪对重建是无损的 —— 提交后的新 delta 要留着', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('第一段'))
    h.emit(commit('m1', '第一段'))
    h.emit(textDelta('第二段还在流'))

    const replay = h.since(0)
    expect(replay.map((e) => e.type)).toEqual(['message_commit', 'stream'])
  })

  it('只清到上一个提交为止,更早的提交不受影响', () => {
    const h = new RunHandle(req())
    h.emit(commit('m1', '一'))
    h.emit(textDelta('二'))
    h.emit(commit('m2', '二'))

    const replay = h.since(0)
    expect(replay.map((e) => e.type)).toEqual(['message_commit', 'message_commit'])
  })

  it('★ 结构性事件不被裁掉 —— 重放时 UI 要靠它们重建工具卡片', () => {
    const h = new RunHandle(req())
    h.emit({ type: 'tool_start', callId: 'c1', toolName: 'read', input: {} })
    h.emit(textDelta('x'))
    h.emit({ type: 'tool_end', callId: 'c1', output: { content: 'ok' }, isError: false })
    h.emit(commit('m1', 'x'))

    expect(h.since(0).map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'message_commit'])
  })

  it('裁剪后 since 仍按 seq 过滤,不按下标', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('a')) // seq 1,会被裁
    h.emit(commit('m1', 'a')) // seq 2
    h.emit(textDelta('b')) // seq 3
    // 日志里只剩 seq 2、3 两条。用下标 slice 的实现在这里会返回错的东西。
    expect(h.since(2)).toEqual([textDelta('b')])
  })
})

describe('RunHandle · 多消费者与生命周期', () => {
  it('★ 两个监听器都收到 —— 这是不用 AsyncIterable 的头号理由', () => {
    const h = new RunHandle(req())
    const a: AgentEvent[] = []
    const b: AgentEvent[] = []
    h.on((e) => a.push(e))
    h.on((e) => b.push(e))
    h.emit(textDelta('x'))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('退订后不再收到', () => {
    const h = new RunHandle(req())
    const seen: AgentEvent[] = []
    const off = h.on((e) => seen.push(e))
    h.emit(textDelta('x'))
    off()
    h.emit(textDelta('y'))
    expect(seen).toHaveLength(1)
    expect(h.listenerCount).toBe(0)
  })

  it('run_end 之后清空监听器,不留悬挂引用', () => {
    const h = new RunHandle(req())
    h.on(() => {})
    h.finish('done')
    expect(h.listenerCount).toBe(0)
    expect(h.status).toBe('done')
  })

  it('★ 结束后的迟到事件被丢弃,且不推进 seq', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = new RunHandle(req())
    h.finish('done')
    const before = h.seq
    h.emit(textDelta('迟到'))
    expect(h.seq).toBe(before)
    expect(h.since(0).filter((e) => e.type === 'stream')).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('finish 只生效一次 —— 二次 finish 不覆盖状态', () => {
    const h = new RunHandle(req())
    h.finish('aborted')
    h.finish('done')
    expect(h.status).toBe('aborted')
  })

  it('collect 收齐到 run_end 为止', async () => {
    const h = new RunHandle(req())
    const p = collect(h)
    h.emit(textDelta('a'))
    h.finish('done')
    const events = await p
    expect(events.map((e) => e.type)).toEqual(['stream', 'run_end'])
  })

  it('collect 对已结束的 run 立即返回日志', async () => {
    const h = new RunHandle(req())
    h.emit(textDelta('a'))
    h.finish('done')
    expect((await collect(h)).map((e) => e.type)).toEqual(['stream', 'run_end'])
  })
})

describe('RunHandle · 待决交互与快照', () => {
  const pending = (id: string): AgentEvent => ({
    type: 'interaction_request',
    interaction: {
      kind: 'ask_user',
      id,
      runId: 'r1',
      question: 'q',
      allowFreeform: true,
      createdAt: 1
    }
  })

  it('★ 待决表跟着事件走 —— attach 时才有东西可还原', () => {
    const h = new RunHandle(req())
    h.emit(pending('i1'))
    h.emit(pending('i2'))
    expect(h.snapshot(0).pendingInteractions.map((p) => p.id)).toEqual(['i1', 'i2'])

    h.emit({ type: 'interaction_resolved', id: 'i1', outcome: { status: 'aborted' } })
    expect(h.snapshot(0).pendingInteractions.map((p) => p.id)).toEqual(['i2'])
  })

  it('快照带上当前 seq —— 渲染层据此续接增量', () => {
    const h = new RunHandle(req())
    h.emit(textDelta('a'))
    h.emit(textDelta('b'))
    const snap = h.snapshot(1)
    expect(snap.seq).toBe(2)
    expect(snap.events).toHaveLength(1)
    expect(snap.status).toBe('running')
  })

  it('快照里的待决表是副本,外部改不动内部', () => {
    const h = new RunHandle(req())
    h.emit(pending('i1'))
    h.snapshot(0).pendingInteractions.length = 0
    expect(h.snapshot(0).pendingInteractions).toHaveLength(1)
  })
})

describe('RunRegistry · 嵌套与中断', () => {
  it('★ 重复 runId 抛错 —— 静默复用会让两个 run 共享转录', () => {
    const reg = new RunRegistry()
    reg.create(req())
    expect(() => reg.create(req())).toThrow(/已存在/)
  })

  it('子 run 登记到父的 children', () => {
    const reg = new RunRegistry()
    reg.create(req({ runId: 'parent' }))
    reg.create(req({ runId: 'child', parentRunId: 'parent', depth: 1 }))
    expect([...(reg.get('parent')?.children ?? [])]).toEqual(['child'])
  })

  it('abort 触发 signal', () => {
    const reg = new RunRegistry()
    const h = reg.create(req())
    expect(h.signal.aborted).toBe(false)
    reg.abort('r1', false)
    expect(h.signal.aborted).toBe(true)
  })

  it('★ cascade 中断整棵子树(方案 §4.8 第 5 件)', () => {
    const reg = new RunRegistry()
    const p = reg.create(req({ runId: 'p' }))
    const c = reg.create(req({ runId: 'c', parentRunId: 'p', depth: 1 }))
    const g = reg.create(req({ runId: 'g', parentRunId: 'c', depth: 2 }))

    reg.abort('p', true)
    expect([p.signal.aborted, c.signal.aborted, g.signal.aborted]).toEqual([true, true, true])
  })

  it('cascade 为 false 时子 run 继续跑', () => {
    const reg = new RunRegistry()
    const p = reg.create(req({ runId: 'p' }))
    const c = reg.create(req({ runId: 'c', parentRunId: 'p', depth: 1 }))
    reg.abort('p', false)
    expect(p.signal.aborted).toBe(true)
    expect(c.signal.aborted).toBe(false)
  })

  it('abort 不存在的 run 不抛', () => {
    expect(() => new RunRegistry().abort('ghost', true)).not.toThrow()
  })

  it('runningIn 只数本工作区里还在跑的 —— 外层 Tab 角标的数据源', () => {
    const reg = new RunRegistry()
    reg.create(req({ runId: 'a', workspaceId: 'w1' }))
    reg.create(req({ runId: 'b', workspaceId: 'w1' })).finish('done')
    reg.create(req({ runId: 'c', workspaceId: 'w2' }))
    expect(reg.runningIn('w1').map((r) => r.runId)).toEqual(['a'])
  })

  it('activeSubagentCount 只统计仍在运行的子 run', () => {
    const reg = new RunRegistry()
    reg.create(req({ runId: 'root' }))
    reg.create(req({ runId: 'child', parentRunId: 'root', depth: 1 }))
    reg.create(req({ runId: 'done-child', parentRunId: 'root', depth: 1 })).finish('done')
    reg.create(req({ runId: 'grandchild', parentRunId: 'child', depth: 2 }))

    expect(reg.activeSubagentCount()).toBe(2)
  })

  it('reap 只回收已结束且无人订阅的', () => {
    const reg = new RunRegistry()
    reg.create(req({ runId: 'done' })).finish('done')
    const watched = reg.create(req({ runId: 'watched' }))
    watched.on(() => {})
    reg.create(req({ runId: 'running' }))

    expect(reg.reap()).toBe(1)
    expect(reg.get('done')).toBeUndefined()
    expect(reg.get('running')).toBeDefined()
    expect(reg.get('watched')).toBeDefined()
  })
})
