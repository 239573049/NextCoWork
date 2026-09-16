import type { PlanExecutionRef } from '../../shared/domain/plan-file'
import { PLAN_FILE_MAX_BYTES, planFilePath } from '../../shared/domain/plan-file'
import type { WorkspaceHost } from './host'

export interface PlanExecutionContext extends PlanExecutionRef {
  content: string
}

export async function loadPlanExecution(
  workspace: WorkspaceHost,
  ref: PlanExecutionRef
): Promise<PlanExecutionContext> {
  const expected = planFilePath(ref.planId)
  if (ref.path !== expected) throw new Error('The approved plan path does not match its id.')
  const absolutePath = await workspace.path.resolveWithin(workspace.rootPath, expected)
  if (!(await workspace.fs.exists(absolutePath))) throw new Error(`The approved plan file does not exist: ${expected}`)
  const stat = await workspace.fs.stat(absolutePath)
  if (stat.isDir || stat.size === 0 || stat.size > PLAN_FILE_MAX_BYTES) {
    throw new Error(`The approved plan file is invalid: ${expected}`)
  }
  const content = await workspace.fs.readFile(absolutePath)
  if (content.trim() === '') throw new Error(`The approved plan file is empty: ${expected}`)
  return { ...ref, content }
}
