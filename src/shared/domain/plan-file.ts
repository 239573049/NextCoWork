export const PLAN_FILE_MAX_BYTES = 64 * 1024

export type PlanApprovalAction =
  | 'approve_current'
  | 'approve_new_session'
  | 'request_revision'
  | 'reject'

export interface PlanFileRef {
  planId: string
  /** Workspace-relative path, always `.plan/<plan-id>.md`. */
  path: string
}

export type PlanExecutionRef = PlanFileRef

export interface PlanToolReceipt extends PlanFileRef {
  type: 'plan_file'
  action: PlanApprovalAction
  feedback?: string
}

export function planFilePath(planId: string): string {
  return `.plan/${planId}.md`
}
