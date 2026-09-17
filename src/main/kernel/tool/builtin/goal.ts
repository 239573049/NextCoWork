/**
 * `ProposeGoal` —— 模型自己提一个完成条件,由一个独立判定器确认达成。
 *
 * ★ **这个工具的危险之处在于它改变的是「什么时候可以停」**,而不是它写了什么。
 * 所以「这次调用到底能不能成立」必须在**调它之前**就判死:一次注定被拒的调用
 * 白花一轮,而模型从错误里学到的东西比什么都糟。`isEnabled()` 就是那道判定,
 * 由 session 的这一轮工具快照消费(照 `todo.ts` 的 `readOnly` 那条注释,
 * 「标记对不对」是一个功能开关,不是一个字段)。
 *
 * ## 五道门
 *
 * 1. 子 run 里不可用(`depth === 0`)—— 子代理没人可问,同 `interaction.ts`
 * 2. 非交互会话不可用(`interact === undefined`)
 * 3. `settings.modelProposedGoals === 'disabled'`
 * 4. 当前 session 已有目标且正在等审批
 * 5. plan 模式下不可用 —— 让模型先把计划走完再提目标
 *
 * ★ 后三道归主进程的 `canProposeGoal()` 判(它拿得到设置与 session 状态,
 * 工具拿不到),前两道在工具这一侧判。**`run()` 进门还会再核一遍同一份判定**:
 * 快照是在这一轮的**开头**取的,而设置、plan 模式、待批状态都会在回合之中变化。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { GOAL_PROPOSAL_CONDITION_MAX, normalizeGoalCondition } from '../../../../shared/domain/goal'
import { defineTool } from '../define'
import type { ToolContext } from '../registry'

/**
 * 这次调用**能不能成立**。快照与 `run()` 用的是同一个函数 ——
 * 两份判定迟早会漂,而漂出来的症状是「下发了却拒」或「没下发却执行了」。
 */
function goalToolEnabled(ctx: ToolContext): boolean {
  return (
    ctx.depth === 0 &&
    ctx.interact !== undefined &&
    ctx.canProposeGoal?.() === true &&
    ctx.proposeGoal !== undefined
  )
}

/**
 * ★ 模型看见的那段 prompt 逐字照搬参考实现,只把 `500` 换成常量引用 ——
 * 数字写死在两处的话,改常量那天描述就在说谎,而**描述是模型唯一会读的规格**。
 */
const DESCRIPTION =
  `Propose a completion condition for this session's work — a goal that keeps you working until a separate evaluator confirms it is met. Non-blocking: the proposal renders alongside your work, so keep working while it is handled.\n` +
  `ask_user true (the default) asks the user first, with a one-keypress approval dialog. If they decline you will not be notified — do not ask about the decision and do not re-propose the same or a reworded condition. Set ask_user false — which sets the goal directly, with no dialog — ONLY when the user's own words in this conversation stated this outcome as what they want; if you inferred it from their intent or the task's shape — or are in doubt — ask. Either path confirms a set goal with a kickoff message; until that message arrives, no new goal is active.\n` +
  `Propose only when the user has asked for an outcome with a verifiable end state ("make the tests pass", "migrate every call site") and the work spans multiple turns. Not for one-off tasks, and never to widen scope: the condition must follow from their request.\n` +
  `The evaluator verifies the condition from the conversation alone — it cannot run commands or read files — so state one measurable end state with its check (e.g. "bun test exits 0"), in at most ${String(GOAL_PROPOSAL_CONDITION_MAX)} characters. One goal is active at a time; a newly approved or directly set proposal replaces the current one.`

const ProposeGoalInput = z.object({
  /**
   * ★ 上限在 schema 上再写一遍,不是为了「更早失败」,是为了让模型**在描述里**
   * 就看见那个数字(`.max()` 会进下发的 JSON Schema)。规范化之后的长度在
   * `run()` 里另判一次:不可见字符不算长度,但也不该被截断之后当成用户同意的目标。
   */
  condition: z
    .string()
    .trim()
    .min(1)
    .max(GOAL_PROPOSAL_CONDITION_MAX)
    .describe(
      'One measurable end state with its check, e.g. "bun test exits 0". The evaluator verifies it from the conversation alone — it cannot run commands or read files.'
    ),
  // 默认 true —— 不写这个默认值的话,模型漏传一次就等于替用户做了「不用问你」的决定
  ask_user: z
    .boolean()
    .default(true)
    .describe(
      "Ask the user for a one-keypress approval first. Set false ONLY when the user's own words in this conversation stated this outcome as what they want."
    )
})

/** 直接设立时的回话。★ 不提「审批结果」:那条结果不会再来。 */
const SET_MESSAGE =
  'The goal is set for this session. A kickoff message follows — keep working; do not stop and do not wait for anything.'

/**
 * 挂起等审批时的回话。
 *
 * ★ 三句「别做」是这段的全部重量:审批结果**不会**通知模型(照参考实现),
 * 所以它必须在这一刻被告知「等不到、别问、别提第二次」,否则它会在这里停住、
 * 或者过两轮把同一个条件换个说法再提一遍。
 */
const PENDING_MESSAGE =
  'The proposal is with the user for a one-keypress decision. Keep working — do not wait for the decision, do not ask the user about it, and do not propose this condition again, reworded or not. No new goal is active until a kickoff message arrives.'

export const proposeGoalTool = defineTool({
  internalId: 'ProposeGoal',
  description: DESCRIPTION,
  schema: ProposeGoalInput,
  // 不碰磁盘、不碰网络,且 plan 模式下可用与否由 isEnabled 的第 5 道门判(不靠这一位)
  readOnly: true,
  concurrencySafe: false,
  destructive: false,
  needsNetwork: false,
  isEnabled: goalToolEnabled,
  async run(input, ctx) {
    // ★ 与快照同一份判定,再核一遍 —— 快照取自这一轮的开头,而它可以中途变化
    const proposeGoal = ctx.proposeGoal
    if (!goalToolEnabled(ctx) || proposeGoal === undefined) {
      return toolFail('Goal proposals are unavailable in this session. Do not retry — continue with the work.')
    }

    const condition = normalizeGoalCondition(input.condition)
    // 零宽字符撑起来的「条件」看起来写了东西,判定器收到的却是一个空条件
    if (condition === '') {
      return toolFail(
        'The condition is empty once invisible characters are stripped. State one measurable end state the evaluator can confirm from the conversation alone.'
      )
    }
    // ★ 超长**拒绝**,不截断:截断后的条件是一个用户没同意的目标
    if (condition.length > GOAL_PROPOSAL_CONDITION_MAX) {
      return toolFail(
        `The condition is ${String(condition.length)} characters, over the ${String(GOAL_PROPOSAL_CONDITION_MAX)}-character limit. Shorten it and propose again — it is not truncated for you.`
      )
    }

    /*
      ★ `await` 等的是**派发**,不是用户的回答:主进程把这次提案记下来就返回,
      审批弹窗还开着。这里多等一等就会把整个 run 卡在一个没人回答的 Promise 上
      (`InteractionGate.request()` 没有超时 —— 见 registry.ts 里 noInteraction 那段)。
    */
    const status = await proposeGoal(condition, input.ask_user)

    return toolOk(
      JSON.stringify({
        condition,
        askUser: input.ask_user,
        status,
        message: status === 'set' ? SET_MESSAGE : PENDING_MESSAGE
      })
    )
  }
})
