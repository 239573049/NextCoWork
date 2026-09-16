import { ulid } from '../../shared/util/id'
import { planFilePath, type PlanFileRef } from '../../shared/domain/plan-file'
import type { ToolContext } from './tool/registry'
import { markRead } from './tool/builtin/read-tracker'
import { resolveInWorkspace } from './tool/path-guard'

export interface ActivePlan extends PlanFileRef {
  runId: string
  sessionId?: string
  workspaceId?: string
  absolutePath: string
}

const activePlans = new Map<string, ActivePlan>()

export async function enterPlanRun(ctx: ToolContext): Promise<ActivePlan> {
  const current = activePlans.get(ctx.runId)
  if (current !== undefined) throw new Error(`Plan mode is already active for ${current.path}.`)
  if (ctx.workspaceRoot === '') throw new Error('Plan mode requires an open workspace.')

  const planId = ulid(ctx.host.clock.now())
  const path = planFilePath(planId)
  const absolutePath = ctx.host.path === undefined
    ? resolveInWorkspace(ctx.workspaceRoot, path)
    : await ctx.host.path.resolveWithin(ctx.workspaceRoot, path)
  await ctx.host.fs.mkdirp(absolutePath)
  await ctx.host.fs.writeFile(absolutePath, '')
  markRead(ctx.runId, absolutePath)

  const plan: ActivePlan = {
    planId,
    path,
    absolutePath,
    runId: ctx.runId,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId })
  }
  activePlans.set(ctx.runId, plan)
  return plan
}

export function activePlanForRun(runId: string): ActivePlan | undefined {
  return activePlans.get(runId)
}

export function leavePlanRun(runId: string): void {
  activePlans.delete(runId)
}

export function planToolAllowList(runId: string, tools: readonly string[]): readonly string[] {
  const active = activePlans.has(runId)
  return tools.filter((tool) => {
    if (tool === 'Task') return false
    return active ? tool !== 'EnterPlanMode' : !['Write', 'Edit', 'ExitPlanMode'].includes(tool)
  })
}
