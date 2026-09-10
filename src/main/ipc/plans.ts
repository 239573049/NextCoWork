import type { PlanDocument, PlanOperation } from '../../shared/domain/plan'
import { getPlan, listPlans, submitPlan, updatePlan } from '../db/repo'

export function list(req: { sessionId: string }): PlanDocument[] {
  return listPlans(req.sessionId)
}

export function get(req: { planId: string }): PlanDocument | null {
  return getPlan(req.planId) ?? null
}

export function update(req: { planId?: string; sessionId: string; baseVersion?: number; operations: PlanOperation[] }) {
  return updatePlan({ ...req, sourceRunId: 'user', author: 'user' })
}

export function submit(req: { planId: string; version: number }): PlanDocument {
  return submitPlan(req.planId, req.version)
}
