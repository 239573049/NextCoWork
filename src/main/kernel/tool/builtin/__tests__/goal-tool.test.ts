import { describe, expect, it, vi } from 'vitest'
import type { InteractionResponse } from '../../../../../shared/agent/interaction'
import { GOAL_PROPOSAL_CONDITION_MAX } from '../../../../../shared/domain/goal'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { proposeGoalTool } from '../goal'

/**
 * `ProposeGoal` 的测试。
 *
 * ★ 这个文件里最重要的两条是**反向断言**,它们钉的是工具契约里两个「不」:
 *
 * 1. 工具结果里**没有审批结果** —— 审批走另一条路(主进程 → 渲染层),
 *    模型永远收不到。谁哪天顺手往结果里加一个 `approved`,这条会立刻红。
 * 2. 工具**不等用户回答** —— `proposeGoal` 只负责派发,审批弹窗还开着。
 *    这里用一个立刻 resolve 的假实现证明它不会挂在等人回答上。
 */

type ProposedStatus = 'set' | 'pending'

/** 转发给主进程的那一次调用 —— 绝大多数断言都要看它。 */
function spy() {
  // 参数名带下划线:它们只用来钉住类型,断言看的是 `mock.calls`
  return vi.fn(async (_condition: string, _askUser: boolean): Promise<ProposedStatus> => 'pending')
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {},
    // 这个工具自己从不 await 它 —— 它只是「这是个交互式会话」的凭据
    interact: async (): Promise<InteractionResponse> => ({ id: 'i1', kind: 'ask_user', answers: null }),
    canProposeGoal: () => true,
    proposeGoal: () => Promise.resolve('pending' as const),
    ...overrides
  }
}

const CONDITION = 'bun test 的退出码为 0（转录里有这次运行的输出）'

describe('ProposeGoal · 元数据与描述', () => {
  it('★ readOnly、非破坏、不出网 —— 它是 plan 模式下也要留着的工具之一', () => {
    expect(proposeGoalTool.internalId).toBe('ProposeGoal')
    expect(proposeGoalTool.readOnly).toBe(true)
    expect(proposeGoalTool.destructive).toBe(false)
    expect(proposeGoalTool.needsNetwork).toBe(false)
  })

  /**
   * ★ 「判定器只看对话」必须**写死在描述里**:判定器跑不了命令、读不了文件,
   * 而描述是模型唯一会读的规格。少了这一句,模型会提一个谁也核不了的目标,
   * 这一轮就再也停不下来了。
   */
  it('★ 描述里写死「判定器只看对话」,并把上限写成常量而不是字面量 500', () => {
    const d = proposeGoalTool.description
    expect(d).toContain('it cannot run commands or read files')
    expect(d).toContain('from the conversation alone')
    expect(d).toContain(`in at most ${String(GOAL_PROPOSAL_CONDITION_MAX)} characters`)
    expect(d).toContain('keep working while it is handled')
    expect(d).toContain('do not ask about the decision and do not re-propose the same or a reworded condition')
    expect(d).toContain('with no dialog')
  })
})

describe('ProposeGoal · 五道门', () => {
  /**
   * ★ 这一位必须由 `defineTool` 原样透出到 `ToolRegistration` 上:透不出来的话
   * 工具**永远不会被摘掉**,而症状是「模型调了一次注定被拒的工具」——
   * 静默的,没人会去查注册表。
   */
  it('★ 五道门缺一道就不下发', () => {
    const isEnabled = (c: ToolContext): boolean | undefined => proposeGoalTool.isEnabled?.(c)
    expect(isEnabled(ctx())).toBe(true)
    // 1. 子 run 里没人可问
    expect(isEnabled(ctx({ depth: 1 }))).toBe(false)
    // 2. 非交互会话
    expect(isEnabled(ctx({ interact: undefined }))).toBe(false)
    // 3、4、5(disabled / 正在等审批 / plan 模式)由主进程合成这一位
    expect(isEnabled(ctx({ canProposeGoal: () => false }))).toBe(false)
    expect(isEnabled(ctx({ canProposeGoal: undefined }))).toBe(false)
    // 没有派发通道 = 收了也办不成
    expect(isEnabled(ctx({ proposeGoal: undefined }))).toBe(false)
  })

  /**
   * ★ 快照是**这一轮开头**取的,而设置、plan 模式、待批状态都会在回合之中变化。
   * 所以 `run()` 进门必须拿同一份判定再核一遍 —— 否则一次注定被拒的调用照样会
   * 走到副作用那一步。
   */
  it('★ 同一份判定也拦在 run() 门口,且一次都不转发', async () => {
    const propose = spy()
    const cases: [string, ToolContext][] = [
      ['子 run', ctx({ depth: 1, proposeGoal: propose })],
      ['非交互会话', ctx({ interact: undefined, proposeGoal: propose })],
      ['主进程说不可以(disabled / plan / 正在等审批)', ctx({ canProposeGoal: () => false, proposeGoal: propose })],
      ['没有派发通道', ctx({ proposeGoal: undefined })]
    ]
    for (const [label, c] of cases) {
      const r = await proposeGoalTool.execute({ condition: CONDITION }, c)
      expect(r.isError, label).toBe(true)
      expect(r.output.content, label).toContain('unavailable')
    }
    expect(propose).not.toHaveBeenCalled()
  })
})

describe('ProposeGoal · 入参与规范化', () => {
  it('缺省 ask_user = true —— 漏传一次不该等于替用户做了决定', async () => {
    const propose = spy()
    const r = await proposeGoalTool.execute({ condition: CONDITION }, ctx({ proposeGoal: propose }))
    expect(propose.mock.calls[0]).toEqual([CONDITION, true])
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.output.content).askUser).toBe(true)
  })

  it('显式 ask_user: false 原样转发(用户自己的话里已经说了要这个结果)', async () => {
    const propose = spy()
    const r = await proposeGoalTool.execute({ condition: CONDITION, ask_user: false }, ctx({ proposeGoal: propose }))
    expect(propose.mock.calls[0]).toEqual([CONDITION, false])
    expect(JSON.parse(r.output.content).askUser).toBe(false)
  })

  it('条件按规范化后的原文转发 —— 不可见字符剥掉、两端空白去掉', async () => {
    const propose = spy()
    await proposeGoalTool.execute({ condition: '  \u200b让测试全绿\ufeff  ' }, ctx({ proposeGoal: propose }))
    expect(propose.mock.calls[0]).toEqual(['让测试全绿', true])
  })

  /**
   * ★ 一串零宽空格看起来是「写了东西」,判定器收到的却是一个空条件 ——
   * 它会稳定地判未达成,于是这一轮永远停不下来。
   */
  it('★ 规范化之后为空的条件被拒,且不转发', async () => {
    const propose = spy()
    const r = await proposeGoalTool.execute({ condition: '\u200b\u200b\u0000 \u200f' }, ctx({ proposeGoal: propose }))
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('empty once invisible characters are stripped')
    expect(propose).not.toHaveBeenCalled()
  })

  /**
   * ★ 超长**拒绝,不截断** —— 截断后的条件是一个用户没同意的目标。
   * 边界就钉在 500:正好 500 全量转发,501 一次都不出去。
   */
  it('★ 长度边界:正好 500 通过,501 被拒且原样不截断', async () => {
    const propose = spy()
    const atLimit = 'a'.repeat(GOAL_PROPOSAL_CONDITION_MAX)
    const ok = await proposeGoalTool.execute({ condition: atLimit }, ctx({ proposeGoal: propose }))
    expect(ok.isError).toBe(false)
    expect(propose.mock.calls[0]).toEqual([atLimit, true])

    const overLimit = 'a'.repeat(GOAL_PROPOSAL_CONDITION_MAX + 1)
    const bad = await proposeGoalTool.execute({ condition: overLimit }, ctx({ proposeGoal: propose }))
    expect(bad.isError).toBe(true)
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('空串与缺字段由 schema 挡下', async () => {
    expect((await proposeGoalTool.execute({ condition: '   ' }, ctx())).isError).toBe(true)
    expect((await proposeGoalTool.execute({}, ctx())).isError).toBe(true)
    expect((await proposeGoalTool.execute({ condition: 42 }, ctx())).isError).toBe(true)
  })
})

describe('ProposeGoal · 两种结局', () => {
  /**
   * ★ **不等用户回答。** `await proposeGoal` 等的是派发:主进程把提案记下来就
   * 返回,审批弹窗还开着。所以这段测试用一个「立刻 resolve」的假实现 ——
   * 它证明工具不会挂在等人回答上。
   */
  it('★ 只等派发,不等人回答(status: pending 立刻返回)', async () => {
    const propose = spy()
    const r = await proposeGoalTool.execute({ condition: CONDITION }, ctx({ proposeGoal: propose }))
    const payload = JSON.parse(r.output.content)
    expect(payload.status).toBe('pending')
    expect(r.isError).toBe(false)
    // 三句「别做」:等不到结果,所以别等、别问、别提第二次
    expect(payload.message).toContain('do not wait for the decision')
    expect(payload.message).toContain('do not ask the user about it')
    expect(payload.message).toContain('do not propose this condition again')
    expect(payload.message).toContain('No new goal is active until a kickoff message arrives.')
  })

  it('直接设立时 status: set,并告诉模型 kickoff 随后就到', async () => {
    const propose = vi.fn(async (_condition: string, _askUser: boolean): Promise<ProposedStatus> => 'set')
    const r = await proposeGoalTool.execute({ condition: CONDITION, ask_user: false }, ctx({ proposeGoal: propose }))
    const payload = JSON.parse(r.output.content)
    expect(payload).toMatchObject({ condition: CONDITION, askUser: false, status: 'set' })
    expect(payload.message).toContain('A kickoff message follows')
    expect(payload.message).toContain('keep working')
  })

  /**
   * ★ **审批结果不进工具结果**(照参考实现)。批没批由 kickoff 消息告诉模型,
   * 而那条消息走的是上下文注入,不是这里。多一个字段 = 模型会开始等一个它
   * 本来就等不到的回答。
   */
  it('★ 结果里只有这四个字段:condition / askUser / status / message', async () => {
    const r = await proposeGoalTool.execute({ condition: CONDITION }, ctx())
    expect(Object.keys(JSON.parse(r.output.content)).sort()).toEqual(['askUser', 'condition', 'message', 'status'])
  })
})
