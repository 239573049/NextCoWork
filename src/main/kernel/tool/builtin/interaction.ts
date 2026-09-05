import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'

export const askUserTool = defineTool({
  internalId: 'AskUserQuestion',
  description: 'Ask the user a focused question when their answer is needed to continue. Provide optional choices; wait for the actual answer before proceeding. Do not use this tool for tool execution permission, which is handled automatically.',
  schema: z.object({
    question: z.string().trim().min(1).max(8000),
    choices: z.array(z.string().trim().min(1).max(1000)).min(1).max(8).optional(),
    allowFreeform: z.boolean().default(true)
  }),
  readOnly: true, destructive: false, needsNetwork: false,
  async run(input, ctx) {
    if (ctx.interact === undefined) return toolFail('User interaction is unavailable in this environment.')
    if (!input.allowFreeform && input.choices === undefined) return toolFail('Provide choices or allow a freeform answer.')
    const response = await ctx.interact({ kind: 'ask_user', ...input })
    if (response.kind !== 'ask_user') return toolFail('Unexpected interaction response.')
    return response.answer === null ? toolFail('The user dismissed this question. Do not assume an answer.')
      : toolOk(JSON.stringify({ answer: response.answer }))
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
