import { ulid } from '../../shared/util/id'
import { planFilePath, type PlanFileRef } from '../../shared/domain/plan-file'
import type { ToolContext } from './tool/registry'
import { markRead } from './tool/builtin/read-tracker'
import { resolveInWorkspace } from './tool/path-guard'

/**
 * 一份计划文件的归属范围。
 *
 * ★ 按**会话**存,不按 run。一次计划几乎总要跨好几轮:模型先问一批问题、
 * 用户回答,这中间 run 早就结束了。按 runId 存的话,下一轮
 * `activePlanFor` 返回 undefined,`planToolAllowList` 于是又把 Write/Edit
 * 摘掉 —— 而模型还记得计划文件路径,照样去调。症状是一句
 * 「There is no tool named Write」,看起来像权限出了问题,其实是状态丢了。
 *
 * 没有 sessionId 的调用(纯内核测试、无头调用)退回 runId,语义与从前一致。
 */
export interface PlanScope {
  runId: string
  sessionId?: string
}

export interface ActivePlan extends PlanFileRef {
  sessionId?: string
  workspaceId?: string
  absolutePath: string
}

/**
 * 最多记住几个会话的计划,超了丢最旧的。
 *
 * ★ 和 `read-tracker` 的封顶同一个理由:没有「会话结束」的钩子可挂。
 * 正常的清除在 `ExitPlanMode` 拿到批准/拒绝时发生(见 `builtin/plan-file.ts`),
 * 这里兜的是「计划提了一半就再也没回来」的那些。
 */
const MAX_SCOPES = 64

const activePlans = new Map<string, ActivePlan>()

function scopeKey(scope: PlanScope): string {
  return scope.sessionId ?? scope.runId
}

export async function enterPlanRun(ctx: ToolContext): Promise<ActivePlan> {
  const current = activePlans.get(scopeKey(ctx))
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
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId })
  }
  // Map 保持插入序,第一个 key 就是最旧的那个会话
  if (activePlans.size >= MAX_SCOPES) {
    const oldest = activePlans.keys().next()
    if (!oldest.done) activePlans.delete(oldest.value)
  }
  activePlans.set(scopeKey(ctx), plan)
  return plan
}

export function activePlanFor(scope: PlanScope): ActivePlan | undefined {
  return activePlans.get(scopeKey(scope))
}

export function leavePlan(scope: PlanScope): void {
  activePlans.delete(scopeKey(scope))
}

export function planToolAllowList(scope: PlanScope, tools: readonly string[]): readonly string[] {
  const active = activePlans.has(scopeKey(scope))
  return tools.filter((tool) => {
    if (tool === 'Task') return false
    return active ? tool !== 'EnterPlanMode' : !['Write', 'Edit', 'ExitPlanMode'].includes(tool)
  })
}
