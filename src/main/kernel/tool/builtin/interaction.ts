import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'

/**
 * 一次最多四道题。上限不是怕界面放不下,是怕模型把「问清楚」当成「先问一轮问卷」——
 * 用户面对八道题的第一反应是全部关掉,那比问少了还糟。
 */
const questionSchema = z.object({
  header: z.string().trim().min(1).max(24).describe('Short label for this question, at most a few words.'),
  question: z.string().trim().min(1).max(8000),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(1000),
    description: z.string().trim().min(1).max(1000).optional()
  })).max(8).default([]).describe('Choices to offer. Omit or leave empty to ask for a freeform answer only.'),
  multiSelect: z.boolean().default(false).describe('Allow more than one option to be selected.'),
  allowFreeform: z.boolean().default(true).describe('Also let the user type an answer of their own.')
})

export const askUserTool = defineTool({
  internalId: 'AskUserQuestion',
  description: 'Ask the user one or more focused questions when their answers are needed to continue. Ask everything you need for the current decision in a single call, each question with its own options; wait for the actual answers before proceeding. Do not use this tool for tool execution permission, which is handled automatically.',
  schema: z.object({ questions: z.array(questionSchema).min(1).max(4) }),
  readOnly: true, destructive: false, needsNetwork: false,
  async run(input, ctx) {
    if (ctx.interact === undefined) return toolFail('User interaction is unavailable in this environment.')
    // 既没选项又不许自由作答的题在界面上无从回答 —— 让它在挂起之前就失败,
    // 否则用户会看到一道点不动的题,而模型在等一个永远不会来的回答。
    const dead = input.questions.findIndex((q) => q.options.length === 0 && !q.allowFreeform)
    if (dead >= 0) return toolFail(`Question ${dead + 1} has no options and does not allow a freeform answer.`)
    const response = await ctx.interact({ kind: 'ask_user', questions: input.questions })
    if (response.kind !== 'ask_user') return toolFail('Unexpected interaction response.')
    if (response.answers === null) return toolFail('The user dismissed these questions. Do not assume an answer.')
    // 按 header 回给模型,不按下标 —— 见 `AskUserQuestion.header` 上的注释
    return toolOk(JSON.stringify({
      answers: input.questions.map((question, index) => ({
        header: question.header,
        question: question.question,
        answer: response.answers?.[index] ?? []
      }))
    }))
  }
})

export const planApprovalTool = defineTool({
  internalId: 'RequestPlanApproval',
  description: 'Present a concrete plan for user review and wait for approval or feedback. Approval does not change the permission mode; plan mode still permits read-only tools only.',
  schema: z.object({ plan: z.string().trim().min(1).max(32000) }),
  readOnly: true, destructive: false, needsNetwork: false,
  async run(input, ctx) {
    if (ctx.interact === undefined) return toolFail('User interaction is unavailable in this environment.')
    const response = await ctx.interact({ kind: 'plan_approval', plan: input.plan })
    if (response.kind !== 'plan_approval') return toolFail('Unexpected interaction response.')
    return toolOk(JSON.stringify({ approved: response.approved, feedback: response.feedback ?? '' }))
  }
})
