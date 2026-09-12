import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from '../index'
import { createProgressPlanV2, createSession, getExecutionPlanV2, getPlanV2, putPlanV2, submitPlanV2, transitionPlanV2, updatePlanProgressV2 } from '../repo'

beforeEach(() => {
  closeDatabase()
  createSession({ id: 'plan-v2-session', workspaceId: 'plan-v2-workspace', title: 'Plan v2', rootPathAtCreation: '/tmp' })
})
afterEach(() => closeDatabase())

const input = { sessionId: 'plan-v2-session', sourceRunId: 'planning-run', explanation: 'Implement and verify.', plan: [{ step: 'Inspect source', status: 'pending' as const }, { step: 'Run tests', status: 'pending' as const }] }

describe('plan v2 lifecycle', () => {
  it('persists a reviewable plan and binds execution progress to its run', () => {
    const saved = putPlanV2(input)
    if (!saved.ok) throw new Error(saved.message)
    const review = submitPlanV2(saved.plan.id, saved.plan.version)
    expect(review.lifecycle).toBe('review')
    transitionPlanV2(review.id, review.version, 'approved')
    transitionPlanV2(review.id, review.version, 'executing', 'execution-run')
    const progress = updatePlanProgressV2(review.id, review.version, [{ step: 'Inspect source', status: 'completed' }, { step: 'Run tests', status: 'in_progress' }])
    expect(progress.version).toBe(2)
    expect(getExecutionPlanV2('execution-run')?.id).toBe(review.id)
    transitionPlanV2(progress.id, progress.version, 'completed')
    expect(getPlanV2(progress.id)?.lifecycle).toBe('completed')
  })

  it('rejects empty, duplicate and multiple-active plans', () => {
    expect(putPlanV2({ ...input, plan: [] }).ok).toBe(false)
    expect(putPlanV2({ ...input, plan: [{ step: 'same', status: 'pending' }, { step: 'same', status: 'completed' }] }).ok).toBe(false)
    expect(putPlanV2({ ...input, plan: [{ step: 'one', status: 'in_progress' }, { step: 'two', status: 'in_progress' }] }).ok).toBe(false)
  })

  it('rejects stale versions and approved-plan rewrites', () => {
    const saved = putPlanV2(input)
    if (!saved.ok) throw new Error(saved.message)
    submitPlanV2(saved.plan.id, saved.plan.version)
    transitionPlanV2(saved.plan.id, saved.plan.version, 'approved')
    expect(() => transitionPlanV2(saved.plan.id, 99, 'executing', 'run')).toThrow('version conflict')
    expect(putPlanV2({ ...input, planId: saved.plan.id }).ok).toBe(false)
  })

  it('creates normal-mode progress without an approval interaction', () => {
    const plan = createProgressPlanV2({ ...input, sourceRunId: 'normal-run' })
    expect(plan.lifecycle).toBe('executing')
    expect(plan.executionRunId).toBe('normal-run')
    expect(getExecutionPlanV2('normal-run')?.id).toBe(plan.id)
  })

  it('allows failed execution to be retried by a new run', () => {
    const plan = createProgressPlanV2({ ...input, sourceRunId: 'first-run' })
    transitionPlanV2(plan.id, plan.version, 'failed')
    const retried = transitionPlanV2(plan.id, plan.version, 'executing', 'retry-run')
    expect(retried.executionRunId).toBe('retry-run')
  })
})
