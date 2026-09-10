import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import type { PlanOperation } from '../../../../shared/domain/plan'
import { isPlanOperation, planToMarkdown } from '../../../../shared/domain/plan'
import { approvePlan, submitPlan, updatePlan } from '../../../db/repo'
import { defineTool } from '../define'

const operationSchema = z.record(z.string(), z.unknown()).refine(isPlanOperation, 'Unknown plan operation')
const updateSchema = z.object({
  planId: z.string().optional(),
  baseVersion: z.number().int().nonnegative().optional(),
  operations: z.array(operationSchema).min(1).max(100),
  rationale: z.string().max(4000).optional()
})

export const planUpdateTool = defineTool({
  internalId: 'PlanUpdate',
  description: 'Create or incrementally update the durable plan. Send structured operations, not a full Markdown document. Always use the latest baseVersion when revising a plan.',
  schema: updateSchema,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    if (ctx.sessionId === undefined) return toolFail('A session is required to update a plan.')
    const result = updatePlan({
      planId: input.planId,
      sessionId: ctx.sessionId,
      sourceRunId: ctx.runId,
      baseVersion: input.baseVersion,
      operations: input.operations as PlanOperation[]
    })
    if (!result.ok || result.plan === undefined) return toolFail(result.message)
    return toolOk(JSON.stringify({ planId: result.plan.id, version: result.plan.version, status: result.plan.status, message: result.message }))
  }
})

const submitSchema = z.object({ planId: z.string().min(1), version: z.number().int().nonnegative() })

export const exitPlanModeTool = defineTool({
  internalId: 'ExitPlanMode',
  description: 'Submit the current plan for user review. Call this only after PlanUpdate has produced a concrete plan. Wait for approval or feedback before execution.',
  schema: submitSchema,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    if (ctx.interact === undefined) return toolFail('User interaction is unavailable in this environment.')
    const plan = submitPlan(input.planId, input.version)
    const response = await ctx.interact({ kind: 'plan_approval', plan: planToMarkdown(plan), planId: plan.id, planVersion: plan.version })
    if (response.kind !== 'plan_approval') return toolFail('Unexpected interaction response.')
    if (response.approved) approvePlan(plan.id, plan.version)
    return toolOk(JSON.stringify({ planId: plan.id, version: plan.version, approved: response.approved, feedback: response.feedback ?? '' }))
  }
})

/** Fixed-schema read-only helper. Entering plan mode is ultimately a Run option. */
export const enterPlanModeTool = defineTool({
  internalId: 'EnterPlanMode',
  description: 'Declare that the current task requires read-only planning before execution. The host must start a plan-mode run for this capability.',
  schema: z.object({ reason: z.string().max(2000).optional() }),
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(_input, ctx) {
    return toolOk(JSON.stringify({ mode: 'plan', runId: ctx.runId, message: 'The current run is already governed by its selected mode. Use PlanUpdate and ExitPlanMode.' }))
  }
})
