import type { PlanDocument, PlanOperation, PlanDocumentV2, PlanV2Input, PlanLifecycle, PlanStepV2Status } from '../../shared/domain/plan'
import { getPlan, listPlans, getPlanV2, listPlansV2, putPlanV2, submitPlanV2, transitionPlanV2, updatePlanProgressV2, legacyPlanAsV2 } from '../db/repo'

export function list(req: { sessionId: string }): PlanDocument[] {
  return listPlans(req.sessionId)
}

export function get(req: { planId: string }): PlanDocument | null {
  return getPlan(req.planId) ?? null
}

export function update(req: { planId?: string; sessionId: string; baseVersion?: number; operations: PlanOperation[] }): never {
  void req
  throw new Error('Legacy plans are read-only. Use the v2 plan protocol.')
}

export function submit(req: { planId: string; version: number }): PlanDocument {
  void req
  throw new Error('Legacy plans are read-only. Use the v2 plan protocol.')
}

export function listV2(req: { sessionId: string }): PlanDocumentV2[] { return [...listPlansV2(req.sessionId), ...listPlans(req.sessionId).map(legacyPlanAsV2)] }
export function getV2(req: { planId: string }): PlanDocumentV2 | null { return getPlanV2(req.planId) ?? (getPlan(req.planId) === undefined ? null : legacyPlanAsV2(getPlan(req.planId)!)) }
export function putV2(req: PlanV2Input) { return putPlanV2(req, 'user') }
export function submitV2(req: { planId: string; version: number }): PlanDocumentV2 { return submitPlanV2(req.planId, req.version) }
export function transitionV2(req: { planId: string; version: number; lifecycle: PlanLifecycle; executionRunId?: string }): PlanDocumentV2 { return transitionPlanV2(req.planId, req.version, req.lifecycle, req.executionRunId) }
export function progressV2(req: { planId: string; version: number; explanation?: string | null; plan: Array<{ id?: string; step: string; status: PlanStepV2Status }> }): PlanDocumentV2 { return updatePlanProgressV2(req.planId, req.version, req.plan, req.explanation) }
