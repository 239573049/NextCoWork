/**
 * ★ **接线**验收:`agent:run` 走**默认驱动**,一路跑到真 `AgentSession` 与内置演示上游。
 *
 * `agent-pump.test.ts` 显式传假发射器进去,量的是**泵**;这份文件一个 driver 参数都不传 ——
 * 它证明的恰恰是**生产路径本身是通的**:runtime 的装配、别名解析、工具注册、
 * 演示上游的挂载点、session 与 RunHandle 的握手。任何一处接错,红的是这里。
 *
 * 没有这份测试,「假发射器退居夹具」这件事就没人看着 —— 泵测试传了假的照样全绿,
 * 而真正跑起来的路径一行都没被执行过。
 *
 * ⚠️ 与 pump 测试同一条约束:`ipc/agent.ts` → `runtime.ts` 这条 import 链必须零 electron。
 * `runtime.ts` 的文件头写了为什么,而这个文件是那句话的执法者 ——
 * 哪天有人在 runtime 里 import 一个 electron 的**值**,挂的会是它。
 *
 * 用**真定时器**:演示上游的分片节奏、泵的 16ms 窗口、echo 的 delayMs 混在一起,
 * 假时钟推起来要处处 advance,而这里没有任何一处需要「卡在半路看一眼」——
 * 只有中断那一例需要,它自己按事件等。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { WebContents } from 'electron'
import type { AgentEvent } from '../../../shared/agent/event'
import type { RunRequest } from '../../../shared/agent/run-request'
import { toolOk } from '../../../shared/agent/tool'
import { applyEvents, emptyTranscript, type TranscriptState } from '../../../shared/agent/transcript'
import { hasSeqGap, type AgentEventEnvelope } from '../../../shared/ipc/contract'
import { abortableSleep } from '../../kernel/abort'
import { nodeHost } from '../../kernel/host'
import { runs } from '../../kernel/run-registry'
import { defineTool } from '../../kernel/tool/define'
import { DEMO_ALIAS, DEMO_MODEL, demoHost, withDemo } from '../../kernel/upstream/demo'
import { getRouter, getTools, installHost, resetRuntimeForTest } from '../../runtime'
import { store } from '../../state/store'
import type { WindowContext } from '../../window/registry'
import { abortRun, startRun } from '../agent'

class FakeWebContents {
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  constructor(readonly id: number) {}
  once(): void {}
  isDestroyed(): boolean {
    return false
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
  envelopes(): AgentEventEnvelope[] {
    return this.sent
      .filter((m) => m.channel === 'agent:event')
      .map((m) => m.payload as AgentEventEnvelope)
  }
}

let nextId = 500
function fakeWindow(): { wc: FakeWebContents; ctx: WindowContext } {
  const wc = new FakeWebContents(nextId++)
  return { wc, ctx: { id: wc.id, kind: 'main', sender: wc as unknown as WebContents } }
}

let runSeq = 0
const USER_TEXT = '看一下这个工程的结构'

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: `real-${++runSeq}`,
  sessionId: 's1',
  workspaceId: 'w1',
  depth: 0,
  input: [{ type: 'text', text: USER_TEXT }],
  mode: 'normal',
  thinking: 'off',
  webSearch: false,
  permissionMode: 'ask',
  // ★ 传的是**别名**。它和 upstreamModel 是两个不同的字符串,
  // 于是「别名有没有真的被翻译过」这件事在断言里看得见。
  model: DEMO_ALIAS,
  skillIds: [],
  ...over
})

/** 与 pump 测试同一个渲染层模拟 —— 用的是同两个函数,不是它们的副本 */
class RendererSim {
  transcript: TranscriptState = emptyTranscript()
  lastSeq = 0
  gaps = 0

  consume(env: AgentEventEnvelope): void {
    if (hasSeqGap(env, this.lastSeq)) {
      this.gaps++
      return
    }
    this.transcript = applyEvents(this.transcript, env.events)
    this.lastSeq = env.seq
  }
}

/**
 * 等到 run 真的结束。
 *
 * `run_end` 不可合批,泵收到它就同步 flush 并自删 —— 所以 status 一变,
 * 最后一批信封已经在 `wc.sent` 里了,不需要再多等一帧。
 */
async function waitForEnd(runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const h = runs.get(runId)
    if (h === undefined || h.status !== 'running') return
    if (Date.now() > deadline) throw new Error(`run ${runId} 在 ${timeoutMs}ms 内没有结束`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 等到某个事件出现在已推送的信封里 —— 中断要挑在「流到一半」下手 */
async function waitForEvent(
  wc: FakeWebContents,
  match: (e: AgentEvent) => boolean,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (wc.envelopes().some((env) => env.events.some(match))) return
    if (Date.now() > deadline) throw new Error(`等不到目标事件`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const allEvents = (wc: FakeWebContents): AgentEvent[] => wc.envelopes().flatMap((e) => e.events)

beforeEach(() => {
  resetRuntimeForTest()
  // 分片不等待:这份测试量的是接线对不对,不是分片节奏 ——
  // 后者是 demo.test.ts 的事。仍然经 `withDemo`,即生产路径同一个挂载点。
  installHost(withDemo(nodeHost(), { chunkDelayMs: 0 }))
})

afterEach(() => {
  runs.abortAll()
  resetRuntimeForTest()
})

describe('agent:run 走默认驱动 · 真 session + 内置演示上游', () => {
  it('★ 端到端:文字 → 工具调用 → 工具结果 → 收尾', async () => {
    const { wc, ctx } = fakeWindow()
    const r = req()
    startRun(r, ctx) // ← 不传 driver,这是全文件的重点
    await waitForEnd(r.runId)

    const sim = new RendererSim()
    for (const env of wc.envelopes()) sim.consume(env)
    // 合批不该在渲染层看出破绽:seq 一路连续,一次 attach 都不需要
    expect(sim.gaps).toBe(0)

    const parts = sim.transcript.messages.flatMap((m) => m.parts)
    // ★ 首个 text 是**用户自己发的那句**,不是模型的回复 —— 它也经 message_commit
    // 到达渲染层。少了它,用户按下回车后自己的消息不会出现在对话里。
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'tool_call', 'tool_result', 'text'])
    expect(parts[0]).toMatchObject({ type: 'text', text: USER_TEXT })

    // ★ 工具结果真的回到了上游、又被上游写进了下一轮回复里。
    // 这一条串起了 encode → 假网络 → decode → session → tool → 再 encode 一整圈;
    // 少接一根线,它就不成立。
    const last = parts[parts.length - 1]
    expect(last?.type === 'text' && last.text).toContain('演示值:text')

    const tools = Object.values(sim.transcript.tools)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('ok')

    expect(runs.get(r.runId)?.status).toBe('done')
  })

  it('★ 别名被翻译成上游模型名:请求写 alias,回来的是 upstreamModel', async () => {
    const { wc, ctx } = fakeWindow()
    const r = req()
    startRun(r, ctx)
    await waitForEnd(r.runId)

    const sim = new RendererSim()
    for (const env of wc.envelopes()) sim.consume(env)

    // 别名解析这一跳没做,`message_start.model` 会原样回显 alias。
    // 两个常量是不同字符串,断言才有意义。
    expect(DEMO_ALIAS).not.toBe(DEMO_MODEL)
    expect(sim.transcript.model).toBe(DEMO_MODEL)
  })

  it('没配过的模型:给 no_healthy_provider,而不是崩在某个 undefined 上', async () => {
    const { wc, ctx } = fakeWindow()
    const r = req({ model: '压根没配过的模型' })
    startRun(r, ctx)
    await waitForEnd(r.runId)

    const end = allEvents(wc).find((e) => e.type === 'run_end')
    expect(end?.type === 'run_end' && end.status).toBe('error')
    expect(end?.type === 'run_end' && end.error?.code).toBe('no_healthy_provider')
  })

  it('★ 中断:工具执行途中停止,每个 tool_call 仍配得上一个 tool_result(§4.8)', async () => {
    /**
     * 把 `echo` 换成一个**慢**版本,好让中断稳稳落在工具执行中间。
     *
     * 不这么做的话,演示上游给 echo 编出来的 `delayMs` 是 1 —— 中断在
     * 「工具已开始、尚未返回」这个几毫秒的窗口里能不能落进去全看运气,
     * 而一个偶尔落在窗口外的用例会退化成「工具正常跑完了」,断言照样绿。
     *
     * 同 internalId 是**替换**(见 ToolRegistry.register 的注释),
     * 所以它仍是 tools[0] —— 演示上游挑的就是第一个。externalName 也不变。
     */
    getTools().register(
      defineTool({
        internalId: 'echo',
        description: '原样返回传入的文本。',
        schema: z.object({ text: z.string(), delayMs: z.number().optional() }),
        readOnly: true,
        destructive: false,
        async run(input, ctx) {
          await abortableSleep(30_000, ctx.signal)
          return toolOk(input.text)
        }
      })
    )

    const { wc, ctx } = fakeWindow()
    const r = req()
    startRun(r, ctx)

    await waitForEvent(wc, (e) => e.type === 'tool_start')
    abortRun({ runId: r.runId, cascade: true })
    await waitForEnd(r.runId)

    expect(runs.get(r.runId)?.status).toBe('aborted')

    const sim = new RendererSim()
    for (const env of wc.envelopes()) sim.consume(env)
    const parts = sim.transcript.messages.flatMap((m) => m.parts)

    const calls = parts.filter((p) => p.type === 'tool_call')
    const results = parts.filter((p) => p.type === 'tool_result')
    /**
     * ★ 先证明**确实开过工具调用**,再证明它被配上了 —— 否则这条断言是空的:
     * 一个在工具开始之前就死掉的 run 同样满足「没有落单的 tool_use」。
     */
    expect(calls.length).toBeGreaterThan(0)
    expect(results.map((p) => (p.type === 'tool_result' ? p.callId : ''))).toEqual(
      calls.map((c) => (c.type === 'tool_call' ? c.callId : ''))
    )
    // 补出来的是**错误**结果,不是一个看起来成功了的空结果
    expect(results.every((p) => p.type === 'tool_result' && p.isError)).toBe(true)
  })

  it("★ thinking 开着也跑得通 —— 输入框的默认档位就是 'auto'", async () => {
    /**
     * 其余用例一律 `thinking: 'off'`,于是「思考预算」这一段在接线层面一行都没被走过。
     * 而输入框的默认值(`DEFAULT_WORKSPACE_SETTINGS.defaultThinking`)是 `'auto'` ——
     * 也就是说**用户实际走的**恰恰是没被覆盖的那条路。它会经 resolveThinkingBudget →
     * encode 抬高 max_tokens → 演示上游校验 `max_tokens > budget_tokens`,
     * 任何一环错了都是 400。e2e 探针点的那一下走的也是这条路。
     *
     * 这一条不测「思考内容对不对」(那是 demo.test.ts 的事),只测**这条路是通的**。
     */
    const { wc, ctx } = fakeWindow()
    const r = req({ thinking: 'auto' })
    startRun(r, ctx)
    await waitForEnd(r.runId)

    expect(runs.get(r.runId)?.status).toBe('done')

    const sim = new RendererSim()
    for (const env of wc.envelopes()) sim.consume(env)
    const parts = sim.transcript.messages.flatMap((m) => m.parts)
    // 思考块真的到了转录里 —— 否则这条用例只是又跑了一遍 'off' 那条路
    expect(parts.some((p) => p.type === 'thinking')).toBe(true)
  })

  it('两个 run 并行不串台:各自的事件只推给各自的订阅者', async () => {
    const a = fakeWindow()
    const b = fakeWindow()
    const ra = req()
    const rb = req()

    startRun(ra, a.ctx)
    startRun(rb, b.ctx)
    await Promise.all([waitForEnd(ra.runId), waitForEnd(rb.runId)])

    expect(a.wc.envelopes().every((e) => e.runId === ra.runId)).toBe(true)
    expect(b.wc.envelopes().every((e) => e.runId === rb.runId)).toBe(true)
    expect(a.wc.envelopes().length).toBeGreaterThan(0)
    expect(b.wc.envelopes().length).toBeGreaterThan(0)
  })

  /**
   * ★ 多轮。一个会话里连发两条,第二个 run 必须**接着第一轮往下写**。
   *
   * 没有这一条,`AgentSession` 的 `history` 缺省(空转录)会让每轮都从零开始:
   * 界面上明明有三轮问答,模型却只看得见最后一句。而这种失败在 UI 上
   * 完全看不出来 —— 它表现为「模型好像有点笨」,不是一个错误。
   *
   * 断言落在 `store.getHistory` 上而不是上游请求体上,因为两者是同一件事的
   * 两端:session 以 `getHistory()` 起手、以 `session.history` 收尾。
   * 终态里同时有两轮,就意味着第二个 session 确实是从第一轮接上的。
   */
  it('★ 同一会话的第二个 run 接着第一轮的转录往下写', async () => {
    const first = req({ sessionId: 'multi', input: [{ type: 'text', text: '第一句' }] })
    startRun(first, fakeWindow().ctx)
    await waitForEnd(first.runId)

    const afterFirst = store.getHistory('multi').length
    expect(afterFirst).toBeGreaterThan(0)

    const second = req({ sessionId: 'multi', input: [{ type: 'text', text: '第二句' }] })
    startRun(second, fakeWindow().ctx)
    await waitForEnd(second.runId)

    const flat = JSON.stringify(store.getHistory('multi'))
    expect(flat).toContain('第一句')
    expect(flat).toContain('第二句')
    // 累积而不是覆盖 —— 第二轮把第一轮顶掉的话,长度不会涨
    expect(store.getHistory('multi').length).toBeGreaterThan(afterFirst)
  })

  it('会话之间互不串台:另一个 sessionId 看不到这段转录', async () => {
    const mine = req({ sessionId: 'sa', input: [{ type: 'text', text: '只属于 sa 的话' }] })
    startRun(mine, fakeWindow().ctx)
    await waitForEnd(mine.runId)

    const other = req({ sessionId: 'sb', input: [{ type: 'text', text: 'sb 的话' }] })
    startRun(other, fakeWindow().ctx)
    await waitForEnd(other.runId)

    expect(JSON.stringify(store.getHistory('sb'))).not.toContain('只属于 sa 的话')
  })
})

describe('运行时自播种', () => {
  it('演示上游总是在表里,且 defaultModel 指向它(全新安装点开就能用)', async () => {
    // getRouter 里会 seed;经一次真 run 把它触发
    const { ctx } = fakeWindow()
    const r = req()
    startRun(r, ctx)
    await waitForEnd(r.runId)

    const { store } = await import('../../state/store')
    expect(store.listProviders().some((p) => p.id === 'demo')).toBe(true)
    expect(store.getSettings().defaultModel).toBe(DEMO_ALIAS)
  })

  it('★ 已经选过模型就不覆盖 —— 否则用户选的模型每次启动都被顶回演示上游', async () => {
    const { store } = await import('../../state/store')
    store.updateSettings({ defaultModel: '用户自己选的' })

    // seeded 已被 beforeEach 的 resetRuntimeForTest 清掉,这一下会真的重跑 seed
    getRouter()

    expect(store.getSettings().defaultModel).toBe('用户自己选的')

    // 还原成全新安装的样子 —— store 是模块级单例,不还原会影响后面的用例
    store.updateSettings({ defaultModel: '' })
  })

  it('★ 换宿主之后路由器必须重建,否则新装的宿主完全不起作用', async () => {
    // 第一轮:演示宿主,跑得通 —— 顺便把路由器建出来(它构造时抓住了宿主引用)
    const a = fakeWindow()
    const ra = req()
    startRun(ra, a.ctx)
    await waitForEnd(ra.runId)
    expect(runs.get(ra.runId)?.status).toBe('done')

    /**
     * 换成一个一律 401 的宿主。`demoHost({ fetch })` 给的是「演示密钥 + 我的假 fetch」,
     * 而不是 `withDemo` 那种按主机名分派 —— 后者会把演示 URL 又还给演示上游,
     * 这一轮就照样成功,什么都验不出来。
     */
    installHost(
      demoHost({ fetch: () => Promise.resolve(new Response('nope', { status: 401 })) })
    )

    const b = fakeWindow()
    const rb = req()
    startRun(rb, b.ctx)
    await waitForEnd(rb.runId)

    // 路由器若还攥着旧宿主,这一轮会和上一轮一样成功 ——
    // 而那正是「装了新宿主也不生效」的症状:改完设置页没反应,重启才对。
    expect(runs.get(rb.runId)?.status).toBe('error')
    const end = allEvents(b.wc).find((e) => e.type === 'run_end')
    expect(end?.type === 'run_end' && end.error?.code).toBe('auth')
  })
})
