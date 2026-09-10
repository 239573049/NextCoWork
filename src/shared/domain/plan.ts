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
