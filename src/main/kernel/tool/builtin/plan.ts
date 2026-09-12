import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { validatePlanV2Input, type PlanStepV2Status } from '../../../../shared/domain/plan'
import { createProgressPlanV2, getExecutionPlanV2, getPlanV2, putPlanV2, submitPlanV2, transitionPlanV2, updatePlanProgressV2 } from '../../../db/repo'
import { defineTool } from '../define'

const stepSchema = z.object({ step: z.string().min(1).max(2000), status: z.enum(['pending', 'in_progress', 'completed']).default('pending') }).strict()
const planSchema = z.object({ explanation: z.string().max(4000).nullable().optional(), plan: z.array(stepSchema).min(1).max(100) }).strict()
function planText(plan: { explanation: string | null; plan: Array<{ step: string; status: string }> }): string {
  return [plan.explanation ?? '', '', ...plan.plan.map((step, index) => `${index + 1}. [${step.status}] ${step.step}`)].join('\n').trim()
}

export const submitPlanTool = defineTool({
  internalId: 'submit_plan',
  description: 'Submit a concise implementation plan for review. Use only after read-only investigation. After this call, stop and wait for the user.',
  schema: planSchema, readOnly: true, destructive: false, needsNetwork: false,
  async run(input, ctx) {
    if (ctx.sessionId === undefined) return toolFail('A session is required to submit a plan.')
    const validation = validatePlanV2Input(input)
    if (validation !== null) return toolFail(validation)
    const saved = putPlanV2({ sessionId: ctx.sessionId, sourceRunId: ctx.runId, explanation: input.explanation, plan: input.plan })
    if (!saved.ok) return toolFail(saved.message)
    ctx.emitPlanEvent?.('plan_created', saved.plan)
    const review = submitPlanV2(saved.plan.id, saved.plan.version)
    ctx.emitPlanEvent?.('plan_review_requested', review)
    if (ctx.interact === undefined) return toolFail('User interaction is unavailable in this environment.')
    const response = await ctx.interact({ kind: 'plan_approval', plan: planText(review), planId: review.id, planVersion: review.version, planDocument: review })
    if (response.kind !== 'plan_approval') return toolFail('Unexpected interaction response.')
    const action = 'action' in response ? response.action : (response.approved ? 'approve_current' : 'reject')
    const resolve = (lifecycle: 'approved' | 'draft' | 'superseded') => {
      const current = getPlanV2(review.id)
      return current !== undefined && current.lifecycle !== 'review' ? current : transitionPlanV2(review.id, review.version, lifecycle)
    }
    if (action === 'approve_current' || action === 'approve_new_session') {
      const approved = resolve('approved')
      ctx.emitPlanEvent?.('plan_approval_resolved', approved)
      return { ...toolOk(JSON.stringify({ planId: review.id, version: review.version, action, approved: true, feedback: response.feedback ?? '' })), stopRun: true }
    }
    if (action === 'request_revision') {
      const draft = resolve('draft')
      ctx.emitPlanEvent?.('plan_approval_resolved', draft)
      return toolOk(JSON.stringify({ planId: review.id, version: review.version, action, approved: false, feedback: response.feedback }))
    }
    const superseded = resolve('superseded')
    ctx.emitPlanEvent?.('plan_approval_resolved', superseded)
    return { ...toolOk(JSON.stringify({ planId: review.id, version: review.version, action, approved: false, feedback: response.feedback ?? '' })), stopRun: true }
  }
})

export const updatePlanTool = defineTool({
  internalId: 'update_plan',
  description: 'Update execution progress for the approved plan. Keep the full checklist in plan[]; use at most one in_progress step.',
  schema: planSchema,
  readOnly: true, destructive: false, needsNetwork: false,
  async run(input, ctx) {
    try {
      if (ctx.sessionId === undefined) return toolFail('A session is required to update progress.')
      const current = getExecutionPlanV2(ctx.runId)
      const steps = input.plan as Array<{ id?: string; step: string; status: PlanStepV2Status }>
      const next = current === undefined
        ? createProgressPlanV2({ sessionId: ctx.sessionId, sourceRunId: ctx.runId, explanation: input.explanation, plan: steps })
        : updatePlanProgressV2(current.id, current.version, steps.map((step) => ({ ...step, id: current.plan.find((previous) => previous.step === step.step)?.id })), input.explanation)
      ctx.emitPlanProgress?.(next)
      return toolOk(JSON.stringify({ planId: next.id, version: next.version, lifecycle: next.lifecycle, plan: next.plan }))
    } catch (error) {
      return toolFail(error instanceof Error ? error.message : String(error))
    }
  }
})

export const planUpdateTool = updatePlanTool
export const exitPlanModeTool = submitPlanTool

export const enterPlanModeTool = defineTool({
  internalId: 'EnterPlanMode',
  description: 'Declare that the current task requires read-only planning. The host has already selected Plan mode.',
  schema: z.object({ reason: z.string().max(2000).optional() }), readOnly: true, destructive: false, needsNetwork: false,
  async run(_input, ctx) { return toolOk(JSON.stringify({ mode: 'plan', runId: ctx.runId, message: 'Use submit_plan after investigation.' })) }
})
