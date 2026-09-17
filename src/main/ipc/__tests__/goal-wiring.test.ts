/**
 * 会话目标的**接线**验收 —— 走真 `runAgent` 装配 + 真 `goal:set` / `goal:get` /
 * `goal:clear`,只换掉一件东西:上游那条流。
 *
 * ## 这份文件在防什么
 *
 * `goal-runtime.test.ts` 把 `handleTurnEnd` 本身钉得很死,但它注入的是**假的
 * `runHooks`**,而且直接调运行时函数。于是下面这几件事**一行都没被执行过**:
 *
 * - `runAgent` 有没有真的把 `onTurnEnd` 装到主 run 上;
 * - `goalEvaluatorModel` / `...ProviderId` 有没有在本次 run 的**第一个 await 之前**
 *   成对冻结(中途改设置不该换掉正在跑的这一轮的判定器);
 * - 判成 `not_met` 之后主模型有没有**真的被再叫一轮**,判成 `met` 之后有没有
 *   真的收尾并清掉目标;
 * - 那些 `goal_status` 标记有没有**只落进转录、不落进上行请求**。
 *
 * 任何一处接错,那边照样全绿。`goal-evaluate.test.ts` 量的是判定器自己(裁转录、
 * 收敛失败),喂的是假的 `GoalEvaluatorPort` —— 它证明不了「判定请求在生产路径上
 * 真的会被发出去」。这一份不喂端口:判定走
 * `hooks.ts → evaluateGoal → getRouter().stream` 那条**生产**路,只有 `stream`
 * 被换成脚本。
 *
 * ## 换掉的只有 `getRouter().stream`
 *
 * 别名解析、工具注册表、权限闸门、Stop 钩子链、转录落盘一律是真的。
 * ★ 演示上游的那条 provider / 别名照常种进 store —— 判定器要用 `resolveModel`
 * 算上下文窗口,没有别名它会直接 `skipped`(reason `no_model`)。但**一个字节都
 * 出不了网**:`stream` 整个被换掉,`fetch` 那条路走不到;宿主仍然套着 `withDemo`,
 * 万一哪条请求漏过脚本,落到的也是演示上游而不是真网络。
 *
 * ## 真钩子、真子进程
 *
 * 最后一条用例注册的是一条**运行期命令型 Stop 钩子**,它真的起一个 POSIX shell、
 * 从 stdin 读那行 JSON、按 `stop_hook_active` 决定 exit 2 / exit 0 —— 于是
 * 「阻断 = 这一轮继续跑」这件事在接线层面被验了一次。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import { assistantMessage, userMessage } from '../../../shared/agent/message'
import type { RunRequest } from '../../../shared/agent/run-request'
import type { ProviderStreamEvent, TokenUsage } from '../../../shared/agent/stream'
import type { ActiveGoal } from '../../../shared/domain/goal'
import type { HookDefinition } from '../../../shared/domain/hook'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../shared/domain/workspace'
import { STOP_HOOK_FEEDBACK_PREFIX, GOAL_EVALUATOR_SYSTEM, goalKickoffMessage } from '../../goal/prompt'
import { getActiveGoal } from '../../goal/state'
import { registerRuntimeHook, runtimeHooksFor } from '../../hook-registry'
import { nodeHost } from '../../kernel/host'
import { interactions } from '../../kernel/interaction-gate'
import { runs } from '../../kernel/run-registry'
import type { CanonicalRequest } from '../../kernel/upstream/canonical'
import {
  DEMO_ALIAS,
  DEMO_ALIASES,
  DEMO_MODEL,
  DEMO_PROVIDER,
  DEMO_PROVIDER_ID,
  withDemo
} from '../../kernel/upstream/demo'
import { getRouter, getTools, installHost, resetRuntimeForTest, runAgent } from '../../runtime'
import { store } from '../../state/store'
import { clearGoal, getGoal, setGoal } from '../goal'

const WS = 'w1'
/** 判定模型那一栏用的第二个别名 —— 与演示别名**同一家**、另一个名字(用例 2)。 */
const JUDGE_ALIAS = 'judge'

type GoalStatus = Extract<ContentPart, { type: 'goal_status' }>

let tmp = ''
let root = ''

// ═══════════════════════════════════════════════════════════════
// 上游脚本
// ═══════════════════════════════════════════════════════════════

interface UpstreamCall {
  /** 判定请求由 `system === GOAL_EVALUATOR_SYSTEM` 认出来 —— 那正是生产里的判据 */
  kind: 'main' | 'evaluator'
  model: string
  modelProviderId: string | undefined
  request: CanonicalRequest
}

let calls: UpstreamCall[] = []
let mainTurn = 0
let evaluationTurn = 0
let onMain: (request: CanonicalRequest, turn: number) => AsyncGenerator<ProviderStreamEvent>
let onEvaluate: (request: CanonicalRequest, turn: number) => AsyncGenerator<ProviderStreamEvent>

const mainCalls = (): UpstreamCall[] => calls.filter((call) => call.kind === 'main')
const evaluationCalls = (): UpstreamCall[] => calls.filter((call) => call.kind === 'evaluator')

const usage = (): TokenUsage => ({ inputTokens: 12, outputTokens: 6 })

/** 一整轮:message_start → text_delta → message_end(end_turn)。 */
async function* textTurn(text: string, during?: () => void): AsyncGenerator<ProviderStreamEvent> {
  yield { type: 'message_start', model: DEMO_MODEL, providerId: DEMO_PROVIDER_ID }
  during?.()
  yield { type: 'text_delta', index: 0, text }
  yield { type: 'message_end', stopReason: 'end_turn', usage: usage() }
}

/** 判定器的一轮。`during` 在正文之前跑 —— 用例 3 就是靠它「判到一半把目标清掉」。 */
async function* verdictTurn(json: string, during?: () => void): AsyncGenerator<ProviderStreamEvent> {
  yield { type: 'message_start', model: DEMO_MODEL, providerId: DEMO_PROVIDER_ID }
  during?.()
  yield { type: 'text_delta', index: 0, text: json }
  yield { type: 'message_end', stopReason: 'end_turn', usage: usage() }
}

/** 一轮工具调用:`tool_call_start → delta → end`,停因是 `tool_use`。 */
async function* toolTurn(name: string, input: unknown): AsyncGenerator<ProviderStreamEvent> {
  const callId = 'toolu_goal_1'
  yield { type: 'message_start', model: DEMO_MODEL, providerId: DEMO_PROVIDER_ID }
  yield { type: 'text_delta', index: 0, text: '先把完成条件立起来。' }
  yield { type: 'tool_call_start', index: 1, callId, name }
  yield { type: 'tool_call_delta', index: 1, callId, argsDelta: JSON.stringify(input) }
  yield { type: 'tool_call_end', index: 1, callId }
  yield { type: 'message_end', stopReason: 'tool_use', usage: usage() }
}

/**
 * ★ 全文件唯一一处假东西。装的是**已经建好的那个路由器实例** ——
 * `runAgent` 拿到的 `upstream: getRouter()` 就是它,所以这条缝足够窄也足够准。
 */
function installScriptedUpstream(): void {
  vi.spyOn(getRouter(), 'stream').mockImplementation((request) => {
    const kind = request.system === GOAL_EVALUATOR_SYSTEM ? 'evaluator' : 'main'
    calls.push({ kind, model: request.model, modelProviderId: request.modelProviderId, request })
    return kind === 'evaluator' ? onEvaluate(request, ++evaluationTurn) : onMain(request, ++mainTurn)
  })
}

// ═══════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════

let runSeq = 0
const req = (sessionId: string, over: Partial<RunRequest> = {}): RunRequest => ({
  runId: `goal-wiring-${++runSeq}`,
  sessionId,
  workspaceId: WS,
  depth: 0,
  input: [{ type: 'text', text: '帮我看看这个工程' }],
  mode: 'normal',
  thinking: 'off',
  webSearch: false,
  permissionMode: 'ask',
  model: DEMO_ALIAS,
  skillIds: [],
  ...over
})

/**
 * 预置一条**非空**转录。
 *
 * 两个作用:(1) 标题生成器只在 `history.length === 0` 时才起 —— 不预置就会真的
 * 去打一次上游;(2) 「已设定」那条标记要挂在一条**已有的**助手消息上,
 * 否则它只能排队等下一次提交。
 */
function seedSession(sessionId: string): void {
  store.ensureSession({
    id: sessionId,
    workspaceId: WS,
    model: DEMO_ALIAS,
    mode: 'normal',
    thinking: 'off',
    rootPathAtCreation: root
  })
  store.setHistory(sessionId, [
    userMessage(`${sessionId}-u0`, [{ type: 'text', text: '先前的提问' }], 1),
    assistantMessage(`${sessionId}-a0`, [{ type: 'text', text: '先前的回答' }], 2)
  ])
}

/** 真的经 `goal:set`,拿到它给的那条 internal kickoff。 */
function setGoalOrThrow(sessionId: string, condition: string): { goal: ActiveGoal; kickoff: ContentPart[] } {
  const result = setGoal({ sessionId, condition })
  if (!result.ok) throw new Error(`目标没设上:${result.reason}`)
  return { goal: result.goal, kickoff: result.kickoff }
}

/**
 * 按渲染层的真实形状起一轮:`/goal` 拿到 kickoff 后,把它当 `input` 发出去,
 * 并带上 `inputInternal` + `inputGoalId`(见 `views/chat/ChatView.tsx`)。
 */
async function runGoalTurn(sessionId: string, condition: string): Promise<RunRequest> {
  const { goal, kickoff } = setGoalOrThrow(sessionId, condition)
  const request = req(sessionId, { input: kickoff, inputInternal: true, inputGoalId: goal.id })
  await runAgent(runs.create(request), request)
  return request
}

const markerSummary = (sessionId: string): Array<{ set: boolean; met: boolean; iterations: number }> =>
  statuses(sessionId).map((part) => ({ set: part.set === true, met: part.met, iterations: part.iterations ?? 0 }))

const statuses = (sessionId: string): GoalStatus[] =>
  store.getHistory(sessionId)
    .flatMap((message) => message.parts)
    .filter((part): part is GoalStatus => part.type === 'goal_status')

/** 落盘的那一份转录里有没有这个字面串 —— 声明成函数是为了断言失败时看得出查了什么。 */
const historyText = (sessionId: string): string => JSON.stringify(store.getHistory(sessionId))

/** 一份上行请求里的全部正文(判定器读的就是它)。 */
const wireText = (request: CanonicalRequest): string =>
  request.messages
    .flatMap((message: AgentMessage) => message.parts.map((part) => (part.type === 'text' ? part.text : '')))
    .join('\n')

beforeEach(() => {
  resetRuntimeForTest()
  tmp = mkdtempSync(join(tmpdir(), 'nextcowork-goal-wiring-'))
  root = join(tmp, 'ws')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(tmp, 'userData'), { recursive: true })

  store.putWorkspace({
    id: WS,
    name: 'goal wiring',
    rootPath: root,
    environment: { kind: 'local' },
    settings: DEFAULT_WORKSPACE_SETTINGS,
    createdAt: 1,
    lastOpenedAt: 1
  })
  /*
    ★ 宿主指向**临时** userData 与临时工作区根:这台开发机上真的装着一条全局
    Stop 钩子时,这几条用例会飘 —— 而它们量的是接线,不该被环境左右。
  */
  installHost(withDemo(nodeHost({
    paths: {
      userData: () => join(tmp, 'userData'),
      attachments: () => join(tmp, 'attachments'),
      temp: () => tmpdir()
    }
  }), { chunkDelayMs: 0 }))

  store.putProvider(DEMO_PROVIDER)
  for (const alias of DEMO_ALIASES) store.putAlias(alias)
  seedJudgeAlias()
  // 设置是库里的状态,不随 resetRuntimeForTest 复位 —— 自己收干净,免得上一条的
  // 判定模型漏到下一句断言里。
  store.updateSettings({ goalEvaluatorModel: '', goalEvaluatorModelProviderId: undefined })

  calls = []
  mainTurn = 0
  evaluationTurn = 0
  onMain = (_request, turn) => textTurn(`(脚本)第 ${turn} 轮主模型回复`)
  onEvaluate = () => verdictTurn('{"ok":false,"reason":"转录里还没有证据"}')

  installScriptedUpstream()
})

afterEach(() => {
  vi.restoreAllMocks()
  runs.abortAll()
  resetRuntimeForTest()
  rmSync(tmp, { recursive: true, force: true })
})

/** 判定模型那一栏要用的第二个名字 —— 同一个供应商上的另一条别名。 */
function seedJudgeAlias(): void {
  const demo = DEMO_ALIASES[0]
  if (demo === undefined) throw new Error('DEMO_ALIASES 是空的,夹具不成立')
  store.putAlias({ ...demo, alias: JUDGE_ALIAS })
}

describe('会话目标 · 真 runAgent 装配 + 真 goal IPC', () => {
  it('★ 全链路:kickoff 起步 → 判 not_met → 主模型真的又跑一轮 → 判 met → 收尾清目标', async () => {
    const sid = 'goal-e2e'
    const condition = '让 goal-wiring 这份测试全绿'
    seedSession(sid)

    const set = setGoalOrThrow(sid, condition)
    expect(set.kickoff).toEqual([{ type: 'text', text: goalKickoffMessage(condition) }])
    // 设目标这一刻就盖了「已设定」—— 挂在预置的那条助手消息上,不新增消息
    expect(markerSummary(sid)).toEqual([{ set: true, met: false, iterations: 0 }])

    onMain = (_request, turn) => textTurn(`第 ${turn} 轮的主模型回复`)
    onEvaluate = (_request, turn) => turn === 1
      ? verdictTurn('{"ok":false,"reason":"转录里还没看到测试输出"}')
      : verdictTurn('{"ok":true,"reason":"测试已经全绿了"}')

    const request = req(sid, { input: set.kickoff, inputInternal: true, inputGoalId: set.goal.id })
    await runAgent(runs.create(request), request)

    expect(runs.get(request.runId)?.status).toBe('done')
    // ★ 主模型被叫了**两次**:第二次是判定器判 not_met 之后真的回来的那一轮
    expect(mainCalls()).toHaveLength(2)
    expect(evaluationCalls()).toHaveLength(2)

    // 三个标记各就各位:设定 / 未达成(1 轮) / 达成(2 轮)
    expect(markerSummary(sid)).toEqual([
      { set: true, met: false, iterations: 0 },
      { set: false, met: false, iterations: 1 },
      { set: false, met: true, iterations: 2 }
    ])
    const notMet = statuses(sid).find((part) => part.met === false && part.set !== true)
    expect(notMet?.reason).toBe('转录里还没看到测试输出')

    /*
      ★ 「真的被叫回来」的硬证据:第二轮上行的消息里带着那条续跑注入。
      只看 `mainCalls().length === 2` 是不够的 —— 两次请求都可能是别的原因发出来的。
    */
    const second = mainCalls()[1]
    expect(second).toBeDefined()
    if (second === undefined) return
    expect(wireText(second.request)).toContain(STOP_HOOK_FEEDBACK_PREFIX)
    expect(wireText(second.request)).toContain('转录里还没看到测试输出')

    /*
      ★★ 标记只属于 UI 那一轨。`attachUiParts` 动的是 `messages`,请求体读的是
      `contextMessages`(见 `agent-session.ts` 的 `commit`)—— 混进去的话,
      上游会对着一堆自己不认识的内容块开始道歉。
    */
    for (const call of mainCalls()) {
      expect(JSON.stringify(call.request.messages), 'goal_status 混进了上行请求').not.toContain('goal_status')
    }

    // 达成即自动清掉,而且 `goal:get` 不会把它捞回来
    expect(getActiveGoal(sid)).toBeUndefined()
    expect(getGoal({ sessionId: sid })).toBeUndefined()
  })

  it('★ 判定模型与供应商在 run 开始时**成对冻结**:中途改设置不动这一轮,下一轮才换', async () => {
    const sid = 'goal-freeze'
    const condition = '结束前把这次判定跑完'
    seedSession(sid)
    store.updateSettings({ goalEvaluatorModel: JUDGE_ALIAS, goalEvaluatorModelProviderId: DEMO_PROVIDER_ID })

    // ★ 在**第一条主模型的流里**改设置。冻结发生在 runAgent 的第一个 await 之前,
    //   所以这一改只该影响下一个 run。
    onMain = (_request, turn) => turn === 1
      ? textTurn('第一轮', () => {
        store.updateSettings({ goalEvaluatorModel: DEMO_ALIAS, goalEvaluatorModelProviderId: DEMO_PROVIDER_ID })
      })
      : textTurn('第二轮')
    onEvaluate = () => verdictTurn('{"ok":true,"reason":"这一轮就算达成"}')

    await runGoalTurn(sid, condition)
    await runGoalTurn(sid, `${condition}(第二轮)`)

    expect(evaluationCalls().map((call) => call.model)).toEqual([JUDGE_ALIAS, DEMO_ALIAS])
    expect(evaluationCalls().map((call) => call.modelProviderId)).toEqual([DEMO_PROVIDER_ID, DEMO_PROVIDER_ID])
    // 两次判定都真的发出去了 —— 否则上面那两行可能只是在比两个空数组
    expect(mainCalls()).toHaveLength(2)
  })

  it('★ 判定途中用户清掉目标:met 不落章,清除标记活过 finally,目标不复活', async () => {
    const sid = 'goal-cleared'
    const condition = '被清掉的那个目标'
    seedSession(sid)
    const set = setGoalOrThrow(sid, condition)

    onMain = () => textTurn('先按目标做事。')
    onEvaluate = () => verdictTurn('{"ok":true,"reason":"其实已经好了"}', () => {
      // ★ 判定还没回话,用户先按了「清除」—— 这正是那条裁决最可能作废的一刻
      clearGoal({ sessionId: sid })
    })

    const request = req(sid, { input: set.kickoff, inputInternal: true, inputGoalId: set.goal.id })
    await runAgent(runs.create(request), request)

    expect(runs.get(request.runId)?.status).toBe('done')
    expect(mainCalls()).toHaveLength(1)

    const parts = statuses(sid)
    expect(parts.some((part) => part.met)).toBe(false)
    expect(parts.some((part) => part.failed === true)).toBe(false)
    // 清除标记确实落在转录里(否则 UI 上那份历史会看起来像从没清过)
    expect(parts.some((part) => part.cleared === true)).toBe(true)

    /*
      ★★ 这一条才是重点:清除标记必须活过 `runAgent` 收尾时的
      `mergeGoalStatusHistory(agentSession.history, latest)`。被合并掉的话,
      `restorableGoalCondition` 读最后一条标记会重新认出一个活跃目标 ——
      用户清掉的目标下次打开自己回来。
    */
    expect(historyText(sid)).toContain('"cleared":true')
    expect(getGoal({ sessionId: sid })).toBeUndefined()
    expect(getActiveGoal(sid)).toBeUndefined()
  })

  it('★ 主模型自己调 ProposeGoal(ask_user:false):工具下发并被执行,目标直接设立,kickoff 走 internal,随后判成 met', async () => {
    const sid = 'goal-propose'
    const condition = 'goal-wiring 这份测试全绿'
    seedSession(sid)

    const advertised: string[] = []
    let proposeOnWire: string | undefined
    onMain = (request, turn) => {
      advertised.push(...request.tools.map((tool) => tool.externalName))
      if (turn !== 1) return textTurn('条件已经立好了,继续干活。')
      // ★ 从**真正下发的那张表**里认工具,而不是写死 'ProposeGoal':
      //   外部名由 ToolNamer 分配,撞名时会带哈希后缀。
      const propose = request.tools.find((tool) => tool.description.includes('Propose a completion condition'))
      proposeOnWire = propose?.externalName
      return propose === undefined
        ? textTurn('(脚本)这张表里没有 ProposeGoal')
        : toolTurn(propose.externalName, { condition, ask_user: false })
    }
    onEvaluate = () => verdictTurn('{"ok":true,"reason":"工具已经执行过了"}')

    const request = req(sid)
    await runAgent(runs.create(request), request)

    expect(runs.get(request.runId)?.status).toBe('done')
    // 「下发了」:这张表里确实有它,而且就是注册表算出来的那个外部名
    expect(proposeOnWire).toBe(getTools().byInternalId('ProposeGoal')?.externalName)
    expect(advertised).toContain(proposeOnWire)
    // 「是只读工具」:readOnly 的工具在 ask 档不弹审批,run 里一个待决交互都没有
    expect(getTools().byInternalId('ProposeGoal')?.readOnly).toBe(true)
    expect(interactions.list()).toEqual([])

    // 「被执行了」:工具回的是 ok,而且回的是「直接设立」那一支
    const toolResult = store.getHistory(sid)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && toolResult.isError).toBe(false)
    expect(toolResult?.type === 'tool_result' && toolResult.output.content).toContain('"status":"set"')

    // 「直接设立」的状态看得见:origin 是 proposal_direct,不是用户手设的那一支
    const setMarker = statuses(sid).find((part) => part.set === true)
    expect(setMarker).toMatchObject({ set: true, met: false, condition, origin: 'proposal_direct' })

    // kickoff 走的是 internal 通道 —— 它不该以用户的名义出现在对话里
    const internal = store.getHistory(sid).find((message) => message.role === 'user' && message.internal === true)
    expect(internal?.parts).toEqual([{ type: 'text', text: goalKickoffMessage(condition) }])
    const second = mainCalls()[1]
    expect(second).toBeDefined()
    if (second === undefined) return
    expect(wireText(second.request)).toContain(goalKickoffMessage(condition))

    // 判定的结论同样下来了:这一次是 met,目标收尾
    expect(evaluationCalls()).toHaveLength(1)
    expect(markerSummary(sid).at(-1)).toEqual({ set: false, met: true, iterations: 1 })
    expect(getActiveGoal(sid)).toBeUndefined()
  })

  it('★ 会话名下还有后台子 run(旧父 run 派出去的):判定整个推迟,判定器一次都不叫,目标留着', async () => {
    const sid = 'goal-background'
    const condition = '等后台那把活儿落地'
    seedSession(sid)

    /*
      ★ 一个**已经不在注册表里的旧父 run** 派出去、至今没回来的子 run。
      它靠 `parentSessionId` 挂在这条会话名下 —— 这正是
      `runs.activeBackgroundChildrenOfSession` 的判据,也是「跑着后台工作的是别人」
      这个事实的唯一来源。
    */
    const child = runs.create(req('goal-background-child', {
      runId: 'goal-child-run',
      parentSessionId: sid,
      parentRunId: 'goal-parent-run-already-gone',
      depth: 1
    }))
    child.backgroundTask = { type: 'Task', description: '后台子代理' }

    const set = setGoalOrThrow(sid, condition)
    onMain = () => textTurn('先看一眼现状。')

    const request = req(sid, { input: set.kickoff, inputInternal: true, inputGoalId: set.goal.id })
    await runAgent(runs.create(request), request)

    expect(runs.get(request.runId)?.status).toBe('done')
    expect(mainCalls()).toHaveLength(1)
    // ★ 判定器一条请求都没发:后台还在跑,这一轮读到的转录本来就是半截的
    expect(evaluationCalls()).toHaveLength(0)

    const goal = getActiveGoal(sid)
    expect(goal?.iterations).toBe(0)
    expect(goal?.deferredSince).toBeTypeOf('number')
    // 目标不会被推迟吃掉 —— 下一次用户开口时它接着判
    expect(getGoal({ sessionId: sid })).toMatchObject({ condition, iterations: 0 })
    expect(runtimeHookIds(sid)).toEqual([])
  })

  /**
   * ★ 真子进程、真阻断语义。
   *
   * 这条运行期命令型 Stop 钩子**只做一件事**:从 stdin 那行 JSON 里认出
   * `stop_hook_active`。第一次是 `false` → `exit 2`(阻断收尾 = 这一轮继续跑);
   * 第二次是 `true` → `exit 0`(放行)。
   *
   * ★ 脚本**只用 POSIX 的 `read` / `case`**,不碰文件、不删东西:它要证明的是
   *   「阻断 → 真的继续跑了一轮,并且把反馈递给了模型」,不是脚本本身有多能干。
   *
   * ★ 断言 `mainCalls()` 恰好两轮就是「第二次真的放行了」的证据:再阻断一次
   *   就会多跑一轮,而 `stop_hook_active` 没被解析出来的话它永远不会变成 true。
   */
  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('★ 运行期命令型 Stop 钩子:第一次 exit 2 让这一轮继续,第二次看 stop_hook_active 放行', async () => {
    const sid = 'goal-stop-hook'
    seedSession(sid)
    registerRuntimeHook(sid, stopOnceHook())
    expect(runtimeHookIds(sid)).toEqual(['stop-once'])

    onMain = (_request, turn) => textTurn(`第 ${turn} 轮`)

    const request = req(sid)
    await runAgent(runs.create(request), request)

    expect(runs.get(request.runId)?.status).toBe('done')
    expect(mainCalls()).toHaveLength(2)
    // 没有目标,所以一次判定都不该有 —— 这条钩子和 goal 是两条独立的路
    expect(evaluationCalls()).toHaveLength(0)
    expect(getActiveGoal(sid)).toBeUndefined()

    const second = mainCalls()[1]
    expect(second).toBeDefined()
    if (second === undefined) return
    expect(wireText(second.request)).toContain(STOP_HOOK_FEEDBACK_PREFIX)
    expect(wireText(second.request)).toContain('keep working')
    expect(historyText(sid)).toContain('keep working')
  })
})

/** 运行期钩子表的当前内容(纯字符串,失败信息里一眼看得出接了没接)。 */
function runtimeHookIds(sessionId: string): string[] {
  return [...runtimeHooksFor(sessionId)].map((hook) => hook.id)
}

/**
 * 一条只看 `stop_hook_active` 的 Stop 钩子。
 *
 * ★ 只用 POSIX 的 `read` / `case` / `printf` / `exit` —— 没有重定向、没有 `rm`、
 *   没有任何会改到这台机器的东西。命令原文写死在这里,是为了让人一眼读完。
 */
function stopOnceHook(): HookDefinition {
  return {
    id: 'stop-once',
    type: 'command',
    event: 'Stop',
    command: [
      'read -r line || true',
      'case "$line" in',
      `  *'"stop_hook_active":false'*) printf '%s\\n' 'the transcript has no evidence yet — keep working' >&2; exit 2 ;;`,
      'esac',
      'exit 0'
    ].join('\n'),
    enabled: true,
    timeoutMs: 10_000
  }
}
