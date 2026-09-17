import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { PLAN_FILE_MAX_BYTES, type PlanToolReceipt } from '../../../../shared/domain/plan-file'
import { activePlanFor, enterPlanRun, leavePlan } from '../../plan-run'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'

export const enterPlanModeTool: ToolRegistration = defineTool({
  internalId: 'EnterPlanMode',
  description:
    'Enter file-backed planning after the user requirements are clear. This creates the only Markdown file ' +
    'that Write and Edit may change for the rest of this planning session and returns its path. Call it exactly once; ' +
    'the file stays active across later turns until the plan is approved or rejected.',
  schema: z.object({
    reason: z.string().max(2000).optional().describe('Why clarification is complete and planning can begin')
  }),
  readOnly: false,
  destructive: false,
  needsNetwork: false,
  async run(_input, ctx) {
    const plan = await enterPlanRun(ctx)
    return toolOk(JSON.stringify({
      type: 'plan_file_entered',
      planId: plan.planId,
      path: plan.path,
      instruction: `Write the complete Markdown plan to ${plan.path}, then call ExitPlanMode.`
    }))
  }
})

export const exitPlanModeTool: ToolRegistration = defineTool({
  internalId: 'ExitPlanMode',
  description:
    'Read the active Markdown plan and present it to the user for review. Call only after the plan file is complete. ' +
    'A revision response continues this run; approval or rejection ends it.',
  schema: z.object({}),
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(_input, ctx) {
    const active = activePlanFor(ctx)
    if (active === undefined) return toolFail('Plan mode is not active. Call EnterPlanMode first.')
    if (ctx.interact === undefined) return toolFail('Plan review is not available in this environment.')
    if (!(await ctx.host.fs.exists(active.absolutePath))) {
      /*
        ★ 文件没了就把计划一起放掉。计划活着的时候 `planToolAllowList` 不下发
        EnterPlanMode —— 不清掉的话,模型既写不成这一份(路径已失效),也重开不了
        新的一份,只能在同一条报错上原地打转。
      */
      leavePlan(ctx)
      return toolFail(`The plan file no longer exists: ${active.path}. Call EnterPlanMode to start a new plan.`)
    }
    const stat = await ctx.host.fs.stat(active.absolutePath)
    if (stat.isDir) return toolFail(`The plan path is a directory, not a Markdown file: ${active.path}`)
    if (stat.size === 0) return toolFail(`The plan file is empty: ${active.path}. Write the plan before exiting Plan mode.`)
    if (stat.size > PLAN_FILE_MAX_BYTES) {
      return toolFail(`The plan file is too large (${String(stat.size)} bytes; limit ${String(PLAN_FILE_MAX_BYTES)}).`)
    }

    const plan = await ctx.host.fs.readFile(active.absolutePath)
    if (plan.trim() === '') return toolFail(`The plan file contains no plan text: ${active.path}.`)
    const response = await ctx.interact({
      kind: 'plan_approval',
      planId: active.planId,
      path: active.path,
      plan
    })
    if (response.kind !== 'plan_approval') return toolFail('Plan review returned an invalid response.')

    // The editor may have saved while this interaction was open. Re-read now so approval is
    // always bound to a real, non-empty file rather than the stale snapshot shown initially.
    const latestStat = await ctx.host.fs.stat(active.absolutePath)
    if (latestStat.isDir || latestStat.size === 0 || latestStat.size > PLAN_FILE_MAX_BYTES) {
      return toolFail(`The plan file became invalid before review completed: ${active.path}`)
    }
    const latest = await ctx.host.fs.readFile(active.absolutePath)
    if (latest.trim() === '') return toolFail(`The plan file became empty before review completed: ${active.path}`)

    const receipt: PlanToolReceipt = {
      type: 'plan_file',
      planId: active.planId,
      path: active.path,
      action: response.action,
      ...(response.feedback === undefined ? {} : { feedback: response.feedback })
    }
    const suffix = response.feedback === undefined ? '' : `\n\nUser feedback:\n${response.feedback}`
    /*
      ★ 计划的生命周期到此为止 —— 但**只在批准/拒绝时**。要求修订的那一支必须
      留着:修订往往发生在下一轮(run 已经结束),计划一旦清掉,下一轮的
      Write/Edit 又会被摘掉,而模型手里还攥着那个路径。
    */
    if (response.action !== 'request_revision') leavePlan(ctx)
    return {
      ...toolOk(`${JSON.stringify(receipt)}${suffix}`),
      stopRun: response.action !== 'request_revision'
    }
  }
})
