import { z } from 'zod'

export const PlanStatus = z.enum(['draft', 'review', 'approved', 'executing', 'completed', 'superseded'])
export type PlanStatus = z.infer<typeof PlanStatus>
export const PlanStepStatus = z.enum(['pending', 'in_progress', 'completed', 'skipped'])
export type PlanStepStatus = z.infer<typeof PlanStepStatus>

export interface PlanMediaRef {
  id: string
  kind: 'local' | 'external' | 'mermaid'
  alt: string
  caption?: string
  attachmentId?: string
  url?: string
  source?: string
  mime?: string
}

export interface PlanStep {
  id: string
  title: string
  description: string
  status: PlanStepStatus
  dependsOn: string[]
  acceptanceCriteria: string[]
  mediaIds: string[]
}

export interface PlanDocument {
  id: string
  sessionId: string
  version: number
  status: PlanStatus
  title: string
  summary: string
  steps: PlanStep[]
  risks: string[]
  validation: string[]
  media: PlanMediaRef[]
  sourceRunId: string
  updatedAt: number
}

export type PlanStepInput = Omit<PlanStep, 'id' | 'status'> & { id?: string; status?: PlanStepStatus }
export type PlanStepPatch = Partial<Omit<PlanStep, 'id'>>
export type PlanMediaInput = Omit<PlanMediaRef, 'id'> & { id?: string }
export type PlanOperation =
  | { op: 'set_title'; value: string }
  | { op: 'set_summary'; value: string }
  | { op: 'insert_step'; afterId?: string; step: PlanStepInput }
  | { op: 'update_step'; stepId: string; patch: PlanStepPatch }
  | { op: 'delete_step'; stepId: string }
  | { op: 'move_step'; stepId: string; afterId?: string }
  | { op: 'set_risks'; values: string[] }
  | { op: 'set_validation'; values: string[] }
  | { op: 'attach_media'; stepId?: string; media: PlanMediaInput }
  | { op: 'remove_media'; mediaId: string }

export interface PlanRevision {
  planId: string
  version: number
  author: 'agent' | 'user'
  sourceRunId?: string
  patch: PlanOperation[]
  createdAt: number
}

export interface PlanUpdateInput {
  planId?: string
  baseVersion?: number
  operations: PlanOperation[]
  rationale?: string
}

export interface PlanUpdateResult {
  ok: boolean
  plan?: PlanDocument
  conflict?: { currentVersion: number; planId: string }
  message: string
}

/** Codex-shaped plan protocol. The rich PlanDocument above is legacy read-only data. */
export const PlanStepV2Status = z.enum(['pending', 'in_progress', 'completed'])
export type PlanStepV2Status = z.infer<typeof PlanStepV2Status>
export const PlanLifecycle = z.enum(['draft', 'review', 'approved', 'executing', 'completed', 'failed', 'superseded'])
export type PlanLifecycle = z.infer<typeof PlanLifecycle>

export interface PlanStepV2 {
  id: string
  step: string
  status: PlanStepV2Status
}

export interface PlanDocumentV2 {
  id: string
  sessionId: string
  version: number
  lifecycle: PlanLifecycle
  explanation: string | null
  plan: PlanStepV2[]
  sourceRunId: string
  executionRunId?: string
  createdAt: number
  updatedAt: number
}

export type PlanRef = { planId: string; version: number }
export type ApprovedPlanExecution = PlanRef & { source: 'current_session' | 'new_session' }

export type PlanApprovalResponse =
  | { kind: 'approve_current'; planId: string; version: number; feedback?: string }
  | { kind: 'approve_new_session'; planId: string; version: number; feedback?: string }
  | { kind: 'request_revision'; planId: string; version: number; feedback: string }
  | { kind: 'reject'; planId: string; version: number; feedback?: string }

export interface PlanV2Input {
  planId?: string
  sessionId: string
  sourceRunId: string
  explanation?: string | null
  plan: Array<{ id?: string; step: string; status?: PlanStepV2Status }>
}

export function validatePlanV2Input(input: { explanation?: string | null; plan: Array<{ step: string; status: string }> }): string | null {
  if (!Array.isArray(input.plan) || input.plan.length === 0) return 'A plan must contain at least one step.'
  if (input.plan.length > 100) return 'A plan cannot contain more than 100 steps.'
  if (input.explanation !== undefined && input.explanation !== null && input.explanation.length > 4000) return 'Explanation is too long (maximum 4000 characters).'
  const seen = new Set<string>()
  let active = 0
  for (const step of input.plan) {
    if (typeof step.step !== 'string' || step.step.trim() === '') return 'Every plan step must contain text.'
    if (!PlanStepV2Status.safeParse(step.status).success) return `Unknown plan step status: ${step.status}`
    const key = step.step.trim().toLocaleLowerCase()
    if (seen.has(key)) return 'Plan steps must be unique.'
    seen.add(key)
    if (step.status === 'in_progress') active++
  }
  if (active > 1) return 'A plan can have at most one in-progress step.'
  return null
}

export function isPlanOperation(value: unknown): value is PlanOperation {
  if (typeof value !== 'object' || value === null || !('op' in value)) return false
  const op = (value as { op?: unknown }).op
  return typeof op === 'string' && ['set_title', 'set_summary', 'insert_step', 'update_step', 'delete_step', 'move_step', 'set_risks', 'set_validation', 'attach_media', 'remove_media'].includes(op)
}

export function planToMarkdown(plan: PlanDocument): string {
  const lines = [`# ${plan.title}`, '', plan.summary]
  if (plan.steps.length > 0) {
    lines.push('', '## Steps')
    for (const [index, step] of plan.steps.entries()) {
      lines.push(`${index + 1}. **${step.title}** — ${step.description}`)
      if (step.acceptanceCriteria.length > 0) lines.push(`   - Acceptance: ${step.acceptanceCriteria.join('; ')}`)
    }
  }
  if (plan.risks.length > 0) lines.push('', '## Risks', ...plan.risks.map((x) => `- ${x}`))
  if (plan.validation.length > 0) lines.push('', '## Validation', ...plan.validation.map((x) => `- ${x}`))
  return lines.join('\n')
}
