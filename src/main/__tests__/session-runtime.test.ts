/**
 * 会话运行时 —— 「下一轮什么时候开跑」搬到主进程之后的验收。
 *
 * 这里钉的语义原先住在渲染层的 `stores/session.ts`(那边的旧用例逐条搬了过来):
 * 排队、插话、续跑、后台子代理汇报、目标空闲检查。搬家的理由只有一条 ——
 * **没有窗口在看这条会话时,这些事也得发生**,而渲染层只有在有人看着时才收得到 `run_end`。
 *
 * 依赖全部是假的:一张假 run 表、一个 Map 当 kv。断言量的是运行时的决定,
 * 不是 IPC 或数据库。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, RunStatus } from '../../shared/agent/event'
import type { InterjectItem } from '../../shared/agent/interject'
import { userMessage } from '../../shared/agent/message'
import type { RunRequest, SendOptions } from '../../shared/agent/run-request'
import type {
  QueuedInput,
  SessionInputState,
  SessionQueueSnapshot,
  SubagentReportStatus
} from '../../shared/domain/queued-input'
import { SESSION_INPUT_VERSION } from '../../shared/domain/queued-input'
import {
  DRAFT_DEBOUNCE_MS,
  DEFERRED_RETRY_MS,
  SessionRuntime,
  type BackgroundReport,
  type SessionRunHandle
} from '../session-runtime'

const OPTS: SendOptions = {
  workspaceId: 'w1',
  depth: 0,
  mode: 'normal',
  thinking: 'auto',
  webSearch: false,
  permissionMode: 'ask',
  model: 'demo-model',
  skillIds: []
}

class FakeRun implements SessionRunHandle {
  status: RunStatus = 'running'
  readonly controller = new AbortController()
  readonly interjects: InterjectItem[][] = []
  readonly internal: InterjectItem[] = []
  private readonly listeners = new Set<(event: AgentEvent, seq: number) => void>()
  constructor(readonly runId: string, readonly sessionId: string, readonly req: RunRequest, readonly depth = 0) {}
  get signal(): AbortSignal { return this.controller.signal }
  on(listener: (event: AgentEvent, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: AgentEvent): void { for (const listener of this.listeners) listener(event, 0) }
  setInterject(items: readonly InterjectItem[]): void { this.interjects.push([...items]) }
  enqueueInternal(item: InterjectItem): void { this.internal.push(item) }
}

/** 一个最小的「主进程」:run 表、会话互斥、kv、广播 */
class Harness {
  readonly kv = new Map<string, SessionInputState>()
  readonly active = new Map<string, FakeRun>()
  /** run_end 之后、收尾落盘之前那一段:会话仍被占着 */
  readonly settling = new Set<string>()
  readonly launched: RunRequest[] = []
  readonly queues: SessionQueueSnapshot[] = []
  readonly reports: Array<{ sessionId: string; callId: string; status: SubagentReportStatus }> = []
  readonly persisted = new Map<string, SubagentReportStatus>()
  receipts = new Map<string, BackgroundReport & { reportStatus?: SubagentReportStatus }>()
  refuse: Error | null = null
  private id = 0
  readonly runtime: SessionRuntime

  constructor() {
    this.runtime = new SessionRuntime({
      now: () => 1_000 + this.id,
      newId: () => `id-${++this.id}`,
      readInput: (sessionId) => this.kv.get(sessionId) ?? null,
      writeInput: (sessionId, state) => { this.kv.set(sessionId, state) },
      activeRun: (sessionId) => this.active.get(sessionId),
      isBusy: (sessionId) => this.active.has(sessionId) || this.settling.has(sessionId),
      launch: (req) => this.start(req),
      emitQueue: (snapshot) => { this.queues.push(snapshot) },
      emitReport: (sessionId, callId, status) => { this.reports.push({ sessionId, callId, status }) },
      readReport: (sessionId, callId) => this.receipts.get(`${sessionId}/${callId}`),
      persistReportStatus: (sessionId, callId, status) => { this.persisted.set(`${sessionId}/${callId}`, status) },
      log: () => {}
    })
  }

  /** 用户在窗口里发出的一轮(`agent:run`) */
  send(sessionId: string, text: string, options: SendOptions = OPTS): FakeRun {
    return this.start({ ...options, runId: `user-${++this.id}`, sessionId, input: [{ type: 'text', text }] })
  }

  start(req: RunRequest): FakeRun {
    if (this.refuse !== null) throw this.refuse
    if (this.active.has(req.sessionId) || this.settling.has(req.sessionId)) throw new Error('会话忙')
    const run = new FakeRun(req.runId, req.sessionId, req)
    this.active.set(req.sessionId, run)
    this.launched.push(req)
    this.runtime.runStarted(run, req)
    return run
  }

  /** run_end 发出,但收尾还没落盘 —— 会话仍被占着 */
  end(run: FakeRun, status: RunStatus = 'done'): void {
    run.emit({ type: 'run_end', status })
    run.status = status
    this.active.delete(run.sessionId)
    this.settling.add(run.sessionId)
  }

  /** driver 的 finally 跑完,互斥释放 */
  settle(run: FakeRun): void {
    this.settling.delete(run.sessionId)
    this.runtime.runSettled(run)
  }

  finish(run: FakeRun, status: RunStatus = 'done'): void {
    this.end(run, status)
    this.settle(run)
  }

  queued(sessionId: string): QueuedInput[] {
    return this.runtime.getInput(sessionId)?.queued ?? []
  }

  enqueue(sessionId: string, text: string, options: SendOptions = OPTS, attachments: QueuedInput['attachments'] = []): void {
    this.runtime.queue(sessionId, { kind: 'enqueue', text, options, attachments })
  }
}

let h: Harness
beforeEach(() => { h = new Harness() })
afterEach(() => { vi.useRealTimers() })

const inputText = (req: RunRequest | undefined): string =>
  (req?.input ?? []).flatMap((part) => part.type === 'text' ? [part.text] : []).join('|')

describe('排队续跑', () => {
  it('生成中再发一条:进队列,不并发第二个 run,立刻落盘', () => {
    h.send('s', '第一条')
    h.enqueue('s', '第二条')

    expect(h.launched).toHaveLength(1)
    expect(h.queued('s').map((q) => q.text)).toEqual(['第二条'])
    expect(h.kv.get('s')?.queued.map((q) => q.text)).toEqual(['第二条'])
    expect(h.queues.at(-1)?.queued.map((q) => q.text)).toEqual(['第二条'])
  })

  it('★ run 正常结束、**收尾落盘之后**才续跑:run_end 那一刻会话还占着', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '第二条')

    h.end(first)
    expect(h.launched).toHaveLength(1)

    h.settle(first)
    expect(h.launched).toHaveLength(2)
    expect(inputText(h.launched[1])).toBe('第二条')
    expect(h.queued('s')).toEqual([])
  })

  it('★★ 没有任何窗口参与也会续上 —— 搬到主进程的全部理由', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '第二条')
    h.enqueue('s', '第三条')

    h.finish(first)
    const second = h.active.get('s')!
    h.finish(second)

    expect(h.launched.map(inputText)).toEqual(['第一条', '第二条', '第三条'])
  })

  it('续跑复用该条目入队当时的档位,排队期间改档位不影响已入队条目', () => {
    const first = h.send('s', '第一条', { ...OPTS, model: 'sonnet', permissionMode: 'full' })
    h.enqueue('s', '第二条', OPTS)
    h.enqueue('s', '第三条', { ...OPTS, model: 'haiku' })
    expect(h.queued('s').map((q) => q.options.model)).toEqual(['demo-model', 'haiku'])

    h.finish(first)
    expect(h.launched[1]).toMatchObject({ model: 'demo-model', permissionMode: 'ask' })
  })

  it('队列附件在续跑时重新出现在 input 里 —— 不是只剩文字', () => {
    const IMG = 'ncw://attachments/sessions/s/01J8A.png'
    const first = h.send('s', '第一条')
    h.enqueue('s', '带图的', OPTS, [{ kind: 'image', name: '01J8A.png', url: IMG }])

    h.finish(first)
    expect(h.launched[1]?.input).toEqual([
      { type: 'text', text: '带图的' },
      { type: 'image', mime: 'image/png', dataRef: IMG }
    ])
  })

  it('用户按停止 / 报错之后不自动续跑;手动继续走同一条路径', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '排队的')

    h.finish(first, 'aborted')
    expect(h.launched).toHaveLength(1)
    expect(h.queued('s').map((q) => q.text)).toEqual(['排队的'])

    h.runtime.queue('s', { kind: 'resume' })
    expect(h.launched).toHaveLength(2)
    expect(h.queued('s')).toEqual([])
  })

  it('报错后同样不自动续跑 —— 否则连着错 N 次烧 N 轮 token', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '排队的')
    h.finish(first, 'error')
    expect(h.launched).toHaveLength(1)
  })

  it('★ 冷启动不自动执行:从 kv 读回的队列,只有用户继续才会动', () => {
    h.kv.set('s', {
      v: SESSION_INPUT_VERSION, draft: '重启前写了一半', savedAt: 1,
      queued: [{ id: 'q-1', text: '重启前排队的', attachments: [], status: 'pending', options: OPTS, enqueuedAt: 1 }]
    })

    expect(h.runtime.getInput('s')?.queued.map((q) => q.text)).toEqual(['重启前排队的'])
    expect(h.launched).toEqual([])

    h.runtime.queue('s', { kind: 'resume' })
    expect(inputText(h.launched[0])).toBe('重启前排队的')
  })

  it('启动被拒:条目原样放回队首,不能凭空消失', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '第二条')
    h.refuse = new Error('需要先安装更新')

    h.finish(first)

    expect(h.queued('s').map((q) => q.text)).toEqual(['第二条'])
  })
})

describe('插话', () => {
  it('promote 后优先于先入队的 pending,且不捎带它', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '排队甲')
    h.enqueue('s', '排队乙')
    const 乙 = h.queued('s')[1]!
    h.runtime.queue('s', { kind: 'promote', id: 乙.id })

    // 正在跑:插话推给 run 的信箱,而不是等它跑完
    h.finish(first)

    expect(inputText(h.launched[1])).toBe('排队乙')
    expect(h.queued('s').map((q) => q.text)).toEqual(['排队甲'])
  })

  it('再点一次取消插话,并清掉 promotedAt;信箱收到一份空全集', () => {
    const run = h.send('s', '第一条')
    h.enqueue('s', '排队甲')
    const 甲 = h.queued('s')[0]!

    h.runtime.queue('s', { kind: 'promote', id: 甲.id })
    expect(h.queued('s')[0]?.status).toBe('promoted')
    h.runtime.queue('s', { kind: 'promote', id: 甲.id })

    expect(h.queued('s')[0]?.status).toBe('pending')
    expect(h.queued('s')[0]?.promotedAt).toBeUndefined()
    expect(run.interjects).toEqual([[{ id: 甲.id, parts: [{ type: 'text', text: '排队甲' }] }], []])
  })

  it('多条 promote 合并成一次输入,按插话顺序而非入队顺序', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '甲')
    h.enqueue('s', '乙')
    const [甲, 乙] = h.queued('s')
    h.runtime.queue('s', { kind: 'promote', id: 乙!.id })
    h.runtime.queue('s', { kind: 'promote', id: 甲!.id })

    h.finish(first)
    expect(inputText(h.launched[1])).toBe('乙\n\n甲')
    expect(h.queued('s')).toEqual([])
  })

  it('★ 运行中插话:只推 promoted;同 id 的 message_commit 才算送达,之后不会在续跑里再发一次', () => {
    const run = h.send('s', '第一条')
    h.enqueue('s', '甲')
    h.enqueue('s', '插一句')
    const 条目 = h.queued('s')[1]!

    h.runtime.queue('s', { kind: 'promote', id: 条目.id })
    expect(run.interjects.at(-1)).toEqual([{ id: 条目.id, parts: [{ type: 'text', text: '插一句' }] }])
    // 主进程确认注入之前不能移走 —— run 半路挂了消息就没了
    expect(h.queued('s')).toHaveLength(2)

    run.emit({ type: 'message_commit', message: userMessage(条目.id, [{ type: 'text', text: '插一句' }], 1) })
    expect(h.queued('s').map((q) => q.text)).toEqual(['甲'])

    h.finish(run)
    expect(h.launched.map(inputText)).toEqual(['第一条', '甲'])
  })

  it('空闲时点插话 = 立即发送', () => {
    const first = h.send('s', '第一条')
    h.enqueue('s', '排队的')
    h.finish(first, 'aborted')

    h.runtime.queue('s', { kind: 'promote', id: h.queued('s')[0]!.id })
    expect(h.launched).toHaveLength(2)
  })

  it('编辑改文本但不动档位快照与插话顺序;信箱收到新文本', () => {
    const run = h.send('s', '第一条')
    h.enqueue('s', '原文', { ...OPTS, model: 'sonnet' })
    const item = h.queued('s')[0]!
    h.runtime.queue('s', { kind: 'promote', id: item.id })
    const at = h.queued('s')[0]?.promotedAt

    h.runtime.queue('s', { kind: 'edit', id: item.id, text: '改过的' })

    const after = h.queued('s')[0]!
    expect(after.text).toBe('改过的')
    expect(after.options.model).toBe('sonnet')
    expect(after.promotedAt).toBe(at)
    expect(run.interjects.at(-1)).toEqual([{ id: item.id, parts: [{ type: 'text', text: '改过的' }] }])
  })

  it('撤回到输入框交回文本;删除只影响目标条目', () => {
    h.send('s', '第一条')
    h.enqueue('s', '甲')
    h.enqueue('s', '乙')
    const [甲, 乙] = h.queued('s')

    const taken = h.runtime.queue('s', { kind: 'take', id: 甲!.id })
    expect(taken.text).toBe('甲')
    h.runtime.queue('s', { kind: 'drop', id: 乙!.id })
    expect(h.queued('s')).toEqual([])
  })

  it('改权限档位:未消费的条目跟着换,其余档位不动', () => {
    h.send('s', '第一条')
    h.enqueue('s', '甲', { ...OPTS, model: 'sonnet' })
    h.runtime.queue('s', { kind: 'retagPermission', mode: 'full' })
    expect(h.queued('s')[0]?.options).toMatchObject({ permissionMode: 'full', model: 'sonnet' })
  })
})

describe('草稿与队列共用一个键', () => {
  it('★ 迟到的草稿防抖不会把已经续跑掉的条目写回去', () => {
    vi.useFakeTimers()
    const first = h.send('s', '第一条')
    h.enqueue('s', '第二条')
    h.runtime.setDraft('s', '写了一半', false)

    h.finish(first)
    expect(h.kv.get('s')?.queued).toEqual([])

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    expect(h.kv.get('s')).toMatchObject({ draft: '写了一半', queued: [] })
  })

  it('退出前 flush:挂在防抖里的草稿被写掉,而不是丢掉', () => {
    vi.useFakeTimers()
    h.runtime.setDraft('s', '最后半句', false)
    expect(h.kv.has('s')).toBe(false)

    h.runtime.flush()
    expect(h.kv.get('s')?.draft).toBe('最后半句')
  })

  it('版本号全局单调:条目被丢掉再重建之后,新快照仍然比旧的新', () => {
    h.send('s', '第一条')
    h.enqueue('s', '甲')
    const before = h.queues.at(-1)!.rev
    h.runtime.queue('s', { kind: 'drop', id: h.queued('s')[0]!.id })
    h.enqueue('s', '乙')
    expect(h.queues.at(-1)!.rev).toBeGreaterThan(before)
  })
})

describe('后台子代理汇报', () => {
  const report = (over: Partial<BackgroundReport> = {}): BackgroundReport => ({
    sessionId: 's', callId: 'task-bg', childRunId: 'run:sub:1', subagentType: 'general-purpose',
    text: '三处读取,都在 config.ts,另有两处在 legacy/loader.ts。', summary: '三处读取,都在 config.ts', ...over
  })

  it('★★ 父会话空闲:用上一次的档位起一轮 internal,正文是全文,界面那一轨只挂摘要', () => {
    h.finish(h.send('s', '派个后台任务'))

    h.runtime.childFinished(report(), 'done')

    const req = h.launched[1]!
    expect(req.inputInternal).toBe(true)
    expect(req.model).toBe('demo-model')
    const text = req.input.find((p) => p.type === 'text')
    expect(text?.type === 'text' && text.text).toContain('legacy/loader.ts')
    expect(req.input.find((p) => p.type === 'subagent')).toMatchObject({ callId: 'task-bg', summary: '三处读取,都在 config.ts' })
    expect(h.persisted.get('s/task-bg')).toBe('reported')
    expect(h.reports.map((r) => r.status)).toEqual(['injecting', 'reported'])
  })

  it('父会话还在跑:进它的信箱,不并发第二个 run', () => {
    const run = h.send('s', '还在跑')
    h.runtime.childFinished(report(), 'done')

    expect(h.launched).toHaveLength(1)
    expect(run.internal).toHaveLength(1)
    expect(run.internal[0]?.internal).toBe(true)
    expect(h.persisted.get('s/task-bg')).toBe('reported')
  })

  it('★ 父会话正在收尾(run_end 已发、互斥未放):等收尾完再起,且排在排队的用户消息之前', () => {
    const run = h.send('s', '第一条')
    h.enqueue('s', '排队的')
    h.end(run)

    h.runtime.childFinished(report(), 'done')
    expect(h.launched).toHaveLength(1)

    h.settle(run)
    expect(h.launched[1]?.inputInternal).toBe(true)
    // 用户那条留给汇报那一轮收尾时再续
    expect(h.queued('s').map((q) => q.text)).toEqual(['排队的'])
    h.finish(h.active.get('s')!)
    expect(inputText(h.launched[2])).toBe('排队的')
  })

  it('★★ 本进程没见过这条会话发消息(重启之后):置 blocked,不是静默 return', () => {
    h.runtime.childFinished(report(), 'done')
    expect(h.launched).toEqual([])
    expect(h.persisted.get('s/task-bg')).toBe('blocked')
  })

  it('手动处理:用调用方给的兜底档位照发;取不到全文就退回摘要', () => {
    h.receipts.set('s/task-bg', { ...report({ text: '' }), reportStatus: 'blocked' })

    expect(h.runtime.reportManually('s', 'task-bg', { ...OPTS, model: 'fallback-model' })).toBe('reported')

    const req = h.launched[0]!
    expect(req.model).toBe('fallback-model')
    const text = req.input.find((p) => p.type === 'text')
    expect(text?.type === 'text' && text.text).toContain('三处读取,都在 config.ts')
  })

  it('已经汇报过的不再汇报', () => {
    h.receipts.set('s/task-bg', { ...report(), reportStatus: 'reported' })
    expect(h.runtime.reportManually('s', 'task-bg', OPTS)).toBe('reported')
    expect(h.launched).toEqual([])
  })

  it('子代理被中断(用户停止 / 应用退出):不自动开一轮新对话,留给用户处理', () => {
    h.finish(h.send('s', '派个后台任务'))
    h.runtime.childFinished(report(), 'aborted')
    expect(h.launched).toHaveLength(1)
    expect(h.reports.at(-1)?.status).toBe('pending')
  })

  it('历史操作(手动压缩)占着会话、又没有 run 会收尾:靠有界重试投递', () => {
    vi.useFakeTimers()
    h.finish(h.send('s', '派个后台任务'))
    h.settling.add('s')

    h.runtime.childFinished(report(), 'done')
    expect(h.launched).toHaveLength(1)

    h.settling.delete('s')
    vi.advanceTimersByTime(DEFERRED_RETRY_MS)
    expect(h.launched[1]?.inputInternal).toBe(true)
  })
})

describe('目标空闲检查', () => {
  it('★ 空闲:主进程直接起一轮 internal + goalId,不经过任何窗口', () => {
    const parts = [{ type: 'text' as const, text: '目标检查' }]
    expect(h.runtime.wakeGoal('s', parts, OPTS, 'goal-1')).toBe(true)

    expect(h.launched[0]).toMatchObject({ sessionId: 's', input: parts, inputInternal: true, inputGoalId: 'goal-1' })
  })

  it('目标已经失效(启动被拒):返回 false,由目标运行时自己退避', () => {
    h.refuse = new Error('The goal was cleared or replaced')
    expect(h.runtime.wakeGoal('s', [{ type: 'text', text: '检查' }], OPTS, 'goal-1')).toBe(false)
  })

  it('记住的档位不带计划执行 —— 复用到一次检查上等于把同一份计划再执行一遍', () => {
    h.finish(h.start({ ...OPTS, runId: 'r1', sessionId: 's', input: [], planExecution: { path: 'plan.md' } as never }))
    h.runtime.childFinished({ sessionId: 's', callId: 'c', childRunId: 'r1:sub:1', text: '完成' }, 'done')
    expect(h.launched[1]?.planExecution).toBeUndefined()
  })
})
