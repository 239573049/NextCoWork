/**
 * 子代理的**接线**验收 —— 从父代理调 `Task` 一路到子 run 的事件落在父窗口上。
 *
 * ## 为什么这份测试必须存在,而且必须断言「信封」
 *
 * 子 run 有自己的 runId,于是有自己的事件 topic。`RunPump.flush()` 在
 * `!windows.hasSubscribers(topic)` 时**整批丢弃**事件 —— 所以订阅继承
 * (`windows.inherit`)没接上的表现是:**不报错、子 run 正常跑完、
 * 父代理拿到正确的结果,而界面上什么都不发生**。
 *
 * 只断言「子 run 的 status 是 done」的话,这条线整个断掉也照样全绿。
 * 所以这里断言的是**父窗口收到的信封里存在 `runId === childRunId` 的那一批**,
 * 并且配了一条反向用例:不装启动器时,那批信封**不存在**。
 * 两条合起来,才证明是 `windows.inherit` 让它工作的。
 *
 * ## 上游是自己写的,不是内置演示上游
 *
 * 演示上游挑的是 `tools[0]`(那是 `echo`,顺序有意义,见 `builtin/index.test.ts`),
 * 没法让它去调 `Task`。所以这里自己拼 SSE —— 但用的是 `renderDemoSse`,
 * 即和演示上游**同一个渲染器**:分片、事件序列、解析器全都是生产路径那份。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEvent } from '../../../shared/agent/event'
import type { RunRequest } from '../../../shared/agent/run-request'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../shared/domain/workspace'
import type { AgentEventEnvelope } from '../../../shared/ipc/contract'
import { runs } from '../../kernel/run-registry'
import {
  DEMO_ALIAS,
  DEMO_ALIASES,
  DEMO_PROVIDER,
  DEMO_PROVIDER_ID,
  demoHost,
  renderDemoSse
} from '../../kernel/upstream/demo'
import {
  ensureSeeded,
  installChildRunLauncher,
  installHost,
  resetRuntimeForTest
} from '../../runtime'
import { store } from '../../state/store'
import type { WindowContext } from '../../window/registry'
import { startChildRun, startRun } from '../agent'

/** 只出现在**交给子代理的 prompt** 里的记号 —— 假上游靠它区分父子两条 run */
const CHILD_MARK = 'SUBTASK-MARK'
const CHILD_REPORT = '子代理报告:配置读取在 src/config.ts:12。'
/** 演示上游底下的第二条别名 —— 「默认子代理」那一栏指的那个,好和父 run 分得开 */
const SUB_ALIAS = 'nextcowork-demo-fast'

/** 假上游要派给谁。用例里改它,就等于改模型填进 `subagent_type` 的那个字符串。 */
let subagentType = 'general-purpose'

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

let nextId = 900
function fakeWindow(): { wc: FakeWebContents; ctx: WindowContext } {
  const wc = new FakeWebContents(nextId++)
  return { wc, ctx: { id: wc.id, kind: 'main', sender: wc as unknown as WebContents } }
}

interface UpstreamBody {
  model?: string
  messages?: Array<{ role: string; content?: Array<Record<string, unknown>> }>
  tools?: Array<{ name: string }>
}

/**
 * 一个只会做一件事的假上游:父代理调一次 `Task`,子代理直接交报告。
 *
 * ★ 父子共用同一个 fetch(它们本来就跑在同一个 host 上),靠 prompt 里的
 * 记号区分 —— 这也顺带钉住了「子代理拿到的是我们写进 prompt 的那段文字」。
 */
function fakeUpstream(): typeof fetch {
  let seq = 0
  return (_input, init) => {
    seq += 1
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as UpstreamBody
    const messages = body.messages ?? []
    const model = body.model ?? DEMO_ALIAS

    const texts = messages.flatMap((m) =>
      (m.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
    )
    // 子代理那条 run:直接交一份报告,不调任何工具
    if (texts.some((t) => t.includes(CHILD_MARK))) {
      return Promise.resolve(sse({ blocks: [{ kind: 'text', text: CHILD_REPORT }] }, model))
    }

    const last = messages[messages.length - 1]
    const result = (last?.content ?? []).find((b) => b.type === 'tool_result')
    if (result !== undefined) {
      const got = typeof result.content === 'string' ? result.content : ''
      return Promise.resolve(sse({ blocks: [{ kind: 'text', text: `父代理收工:${got}` }] }, model))
    }

    // ★ 按**外部名**调用 —— 名字映射是会话内的事,测试不该自己猜
    const name = (body.tools ?? []).map((t) => t.name).find((n) => n.toLowerCase() === 'task')
    if (name === undefined) throw new Error('工具表里没有 Task —— 接线在更靠前的地方就断了')

    return Promise.resolve(
      sse(
        {
          blocks: [
            { kind: 'text', text: '这活我派个子代理去做。' },
            {
              kind: 'tool_use',
              id: `toolu_${String(seq)}`,
              name,
              input: {
                description: '查配置读取处',
                prompt: `${CHILD_MARK} 找出这个仓库里读配置的地方`,
                subagent_type: subagentType
              }
            }
          ],
          stopReason: 'tool_use'
        },
        model
      )
    )
  }
}

function sse(
  reply: {
    blocks: Array<
      | { kind: 'text'; text: string }
      | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >
    stopReason?: 'end_turn' | 'tool_use'
  },
  model: string
): Response {
  const text = renderDemoSse(
    { blocks: reply.blocks, stopReason: reply.stopReason ?? 'end_turn' },
    model,
    20
  )
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
  })
}

let runSeq = 0
const PARENT_SESSION = 'parent-session'

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: `sub-wire-${++runSeq}`,
  sessionId: PARENT_SESSION,
  workspaceId: 'w1',
  depth: 0,
  input: [{ type: 'text', text: '帮我查一下配置在哪里读的' }],
  mode: 'normal',
  thinking: 'off',
  webSearch: false,
  // ★ `auto` 档:Task 的 destructive 是 false,于是闸门放行。
  //   `ask` 档下写与执行一律被拒,那是另一个文件的事。
  permissionMode: 'auto',
  model: DEMO_ALIAS,
  skillIds: [],
  ...over
})

async function waitForEnd(runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const h = runs.get(runId)
    if (h === undefined || h.status !== 'running') return
    if (Date.now() > deadline) throw new Error(`run ${runId} 在 ${String(timeoutMs)}ms 内没有结束`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const allEvents = (wc: FakeWebContents): AgentEvent[] => wc.envelopes().flatMap((e) => e.events)

beforeEach(() => {
  subagentType = 'general-purpose'
  resetRuntimeForTest()
  store.putWorkspace({ id: 'w1', name: 'Local test workspace', rootPath: '', environment: { kind: 'local' }, settings: DEFAULT_WORKSPACE_SETTINGS, createdAt: 1, lastOpenedAt: 1 })
  store.ensureSession({ id: PARENT_SESSION, workspaceId: 'w1', rootPathAtCreation: '' })
  store.setHistory(PARENT_SESSION, [])
  installHost(demoHost({ fetch: fakeUpstream() }, { chunkDelayMs: 0 }))
  // ★ `seed()` 不再种演示上游(理由见 runtime.ts 的 seed 文件头),而这份测试
  // 全程用 DEMO_ALIAS 发 run —— 自己种两行,机器本身一点没变
  store.putProvider(DEMO_PROVIDER)
  for (const alias of DEMO_ALIASES) store.putAlias(alias)
  /*
    ★ `seed()` 会给全新安装种一个「默认子代理」(内置上游的 flash),而它**排在
    父 run 前面**(见 `subagentModelSelection`)。这份测试断言的是**继承**那一档,
    所以要把那一栏清成「跟随对话」—— 不清的话每条用例都在测种子,而不是接线。

    ★★ 顺序不能反:`seed()` 是**懒的**(第一次 `getRouter()` 才跑),而它只在
    这一栏为空时才种。先清后种的话种子照样落回来,清了等于没清。
    `ensureSeeded()` 就是为「先把种子跑完」准备的那个入口。
  */
  ensureSeeded()
  store.updateSettings({ subagent: { model: '', modelProviderId: undefined } })
})

afterEach(() => {
  runs.abortAll()
  resetRuntimeForTest()
})

describe('父代理派子代理 · 全链路', () => {
  it('★ 子 run 的事件落在父窗口上 —— 断言信封的 runId,不是子 run 的 status', async () => {
    installChildRunLauncher(startChildRun)
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const started = allEvents(wc).find((e) => e.type === 'subagent_start')
    expect(started).toBeDefined()
    const childRunId = started?.type === 'subagent_start' ? started.childRunId : ''
    expect(childRunId).not.toBe('')

    // ★ 这一行就是这份文件存在的理由
    const childEnvelopes = wc.envelopes().filter((e) => e.runId === childRunId)
    expect(childEnvelopes.length).toBeGreaterThan(0)
  })

  it('★ 不装启动器时那批信封就不存在 —— 证明是 windows.inherit 让它工作的', async () => {
    // 刻意**不**调 installChildRunLauncher:走 runtime 里那个降级分支
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const started = allEvents(wc).find((e) => e.type === 'subagent_start')
    const childRunId = started?.type === 'subagent_start' ? started.childRunId : ''
    expect(childRunId).not.toBe('')

    expect(wc.envelopes().filter((e) => e.runId === childRunId)).toHaveLength(0)
    // 但子 run 本身是跑了的 —— 父代理照样拿到了结果
    expect(runs.get(r.runId)?.status).toBe('done')
  })

  it('subagent_start / subagent_end 成对出现,并且带同一个 callId 和 childRunId', async () => {
    installChildRunLauncher(startChildRun)
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const evs = allEvents(wc)
    const s = evs.find((e) => e.type === 'subagent_start')
    const e = evs.find((x) => x.type === 'subagent_end')
    expect(s?.type).toBe('subagent_start')
    expect(e?.type).toBe('subagent_end')
    if (s?.type !== 'subagent_start' || e?.type !== 'subagent_end') return
    expect(e.callId).toBe(s.callId)
    expect(e.childRunId).toBe(s.childRunId)
    expect(e.status).toBe('done')
  })

  it('子代理的产出变成 tool_result,父代理据此收工', async () => {
    installChildRunLauncher(startChildRun)
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    // 落地的文字看 message_commit —— 那是最终归一化之后的那份
    const committed = JSON.stringify(allEvents(wc).filter((e) => e.type === 'message_commit'))
    expect(committed).toContain('父代理收工')
    expect(committed).toContain(CHILD_REPORT)

    // 子代理的产出确实是经 tool_result 回来的,不是父代理自己编的
    const ended = allEvents(wc).find((e) => e.type === 'tool_end')
    expect(ended?.type === 'tool_end' ? ended.isError : true).toBe(false)
    expect(JSON.stringify(ended)).toContain(CHILD_REPORT)
  })
})

describe('父子两条转录互不相干', () => {
  /**
   * ★ 子 run 用的是**派生**的 sessionId(`<父>:sub:<childRunId>`)。
   *
   * 复用父的会被 `store.setHistory` 整数组覆盖直接毁掉:父子并发跑完,
   * 谁后 finally 谁赢,父的转录凭空少几轮。
   */
  it('★ 子 run 结束后,父转录里仍然有父自己的消息', async () => {
    installChildRunLauncher(startChildRun)
    const { ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const parent = store.getHistory(PARENT_SESSION)
    expect(parent.length).toBeGreaterThan(0)
    expect(parent.some((m) => m.role === 'user')).toBe(true)
    // 父的转录里有它自己那次工具调用,而不是被子代理那一轮顶掉
    expect(JSON.stringify(parent)).toContain('派个子代理')
  })

  it('子 run 的转录落在自己的 sessionId 下,是一份全新的上下文', async () => {
    installChildRunLauncher(startChildRun)
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const started = allEvents(wc).find((e) => e.type === 'subagent_start')
    const childRunId = started?.type === 'subagent_start' ? started.childRunId : ''
    const childSessionId = `${PARENT_SESSION}:sub:${childRunId}`
    const child = store.getHistory(childSessionId)

    expect(child.length).toBeGreaterThan(0)
    // ★ 子代理**看不到父对话**:父那句原话一个字都不在它的窗口里
    expect(JSON.stringify(child)).not.toContain('帮我查一下配置在哪里读的')
    expect(JSON.stringify(child)).toContain(CHILD_MARK)

    /*
      ★ 派生的 id 只是惯例,`parent_session_id` 才是那条转录「不进侧边栏」的
      **事实依据** —— 过滤和级联删除全读这一列,没有一处再去 parse 上面那个
      `:sub:`(理由见 `db/schema.ts` 第 10 条迁移)。这一条钉住的是接线:
      少了它,子会话又会以「新对话」的名义出现在最近对话里。
    */
    expect(store.getSession(childSessionId)?.parentSessionId).toBe(PARENT_SESSION)
    expect(store.listSessions(r.workspaceId).map((s) => s.id)).not.toContain(childSessionId)
  })
})

describe('派不出去的时候', () => {
  /**
   * ★ `subagent_type` 认不出时**绝不静默回落**到 general-purpose。
   *
   * 回落是所有失败模式里最坏的一个:名字敲错的用户会拿到一份「看起来对」的、
   * 由错误代理产出的结果,而且永远不会发现。所以这里同时断言两件事 ——
   * 拒绝的理由里带着可用清单(模型下一步能选对),以及**一条子 run 都没建**。
   */
  it('★ 名字认不出 → 报错并列出可用清单,而不是回落到 general-purpose', async () => {
    installChildRunLauncher(startChildRun)
    subagentType = 'reviewr'
    const { wc, ctx } = fakeWindow()
    const r = req()

    startRun(r, ctx)
    await waitForEnd(r.runId)

    const ended = allEvents(wc).find((e) => e.type === 'tool_end')
    expect(ended?.type === 'tool_end' ? ended.isError : false).toBe(true)
    const said = JSON.stringify(ended)
    expect(said).toContain('reviewr')
    expect(said).toContain('general-purpose') // 清单在,模型下一次能选对
    expect(said).not.toContain(CHILD_REPORT) // 没有任何子代理真的跑过

    // 连 subagent_start 都不该发 —— 界面上不该出现一个转瞬即逝的空节点
    expect(allEvents(wc).some((e) => e.type === 'subagent_start')).toBe(false)
    expect(runs.get(r.runId)?.children.size ?? 0).toBe(0)
  })
})

/**
 * ★★ 别名和供应商必须**成对**决定。
 *
 * `agents/<name>.md` 的 frontmatter 只写得下一个裸别名、没有供应商的概念,
 * 所以子代理声明了别名时,供应商就该是「没指定」(按优先级择优),
 * 而**不是**继承父亲锁的那家。写成两条独立的 `??` 就会拼出
 * 「A 家的别名 + B 家的锁」—— 候选集返回空,然后报一条指着 B 的错,
 * 而 B 跟这次调用根本没关系,无从排查。
 */
describe('子代理继承模型时的别名/供应商配对', () => {
  /** 装一个探针启动器:先记下子 RunRequest,再照常交给真启动器 */
  const captureChildReq = (): RunRequest[] => {
    const seen: RunRequest[] = []
    installChildRunLauncher((parent, childReq, driver) => {
      seen.push(childReq)
      return startChildRun(parent, childReq, driver)
    })
    return seen
  }

  it('子代理没声明模型时,连供应商一起继承父亲的', async () => {
    const seen = captureChildReq()
    const r = req({ modelProviderId: DEMO_PROVIDER.id })

    startRun(r, fakeWindow().ctx)
    await waitForEnd(r.runId)

    expect(seen[0]).toMatchObject({ model: DEMO_ALIAS, modelProviderId: DEMO_PROVIDER.id })
  })

  it('父亲没锁供应商时子代理也没有 —— 不凭空多出一个锁', async () => {
    const seen = captureChildReq()
    const r = req()

    startRun(r, fakeWindow().ctx)
    await waitForEnd(r.runId)

    expect(seen[0]?.model).toBe(DEMO_ALIAS)
    expect(seen[0]?.modelProviderId).toBeUndefined()
  })

  /**
   * ★★ 设置页那一栏**真的会落到子 run 上**。
   *
   * 它以前是死配置:界面能选、能存,而 `childRequestFor` 只在「子代理自己声明的」
   * 和「父 run 的」之间二选一,那一栏一次都没被读过 —— 用户把子代理配成便宜模型,
   * 账单照着主力模型走,而且没有任何迹象。这条用例就是钉住它不再退化回去。
   */
  it('★ 设置里配了「默认子代理」时,子 run 用它 —— 别名和供应商成对', async () => {
    store.putAlias({ ...DEMO_ALIASES[0]!, alias: SUB_ALIAS })
    store.updateSettings({ subagent: { model: SUB_ALIAS, modelProviderId: DEMO_PROVIDER_ID } })
    const seen = captureChildReq()
    const r = req({ modelProviderId: DEMO_PROVIDER_ID })

    startRun(r, fakeWindow().ctx)
    await waitForEnd(r.runId)

    // 父 run 用的是 DEMO_ALIAS,子 run 必须换成设置里那个
    expect(seen[0]).toMatchObject({ model: SUB_ALIAS, modelProviderId: DEMO_PROVIDER_ID })
  })

  it('设置里那一对悬空时退回父 run —— 而不是拿一个查不到的别名去发请求', async () => {
    store.updateSettings({ subagent: { model: 'ghost-model', modelProviderId: 'no-such-provider' } })
    const seen = captureChildReq()
    const r = req({ modelProviderId: DEMO_PROVIDER_ID })

    startRun(r, fakeWindow().ctx)
    await waitForEnd(r.runId)

    expect(seen[0]).toMatchObject({ model: DEMO_ALIAS, modelProviderId: DEMO_PROVIDER_ID })
  })
})
