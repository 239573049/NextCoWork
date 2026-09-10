import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../index'
import { createSession, getPlan, listPlans, submitPlan, updatePlan } from '../repo'

let directory = ''
const sessionId = 'session-plan-test'

beforeEach(() => {
  closeDatabase()
  directory = mkdtempSync(join(tmpdir(), 'nextcowork-plan-'))
  openDatabase(directory)
  createSession({ id: sessionId, workspaceId: 'workspace-plan-test', title: 'Plans', rootPathAtCreation: '/tmp' })
})

afterEach(() => {
  closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

describe('versioned plans', () => {
  it('creates, increments, persists and submits a plan', () => {
    const first = updatePlan({
      sessionId,
      sourceRunId: 'run-1',
      operations: [
        { op: 'set_title', value: 'Ship the feature' },
        { op: 'set_summary', value: 'A small implementation plan.' },
        { op: 'insert_step', step: { title: 'Inspect', description: 'Read the relevant code.', dependsOn: [], acceptanceCriteria: [], mediaIds: [] } }
      ]
    })
    expect(first.ok).toBe(true)
    expect(first.plan?.version).toBe(1)
    expect(first.plan?.steps).toHaveLength(1)

    const second = updatePlan({
      planId: first.plan!.id,
      sessionId,
      sourceRunId: 'run-1',
      baseVersion: 1,
      operations: [{ op: 'update_step', stepId: first.plan!.steps[0]!.id, patch: { title: 'Inspect the repository' } }]
    })
    expect(second.plan?.version).toBe(2)
    expect(getPlan(first.plan!.id)?.steps[0]?.title).toBe('Inspect the repository')
    expect(listPlans(sessionId)).toHaveLength(1)

    const review = submitPlan(first.plan!.id, 2)
    expect(review.status).toBe('review')
  })

  it('rejects stale edits instead of overwriting newer user changes', () => {
    const first = updatePlan({ sessionId, sourceRunId: 'run-1', operations: [{ op: 'set_summary', value: 'first' }] })
    const current = updatePlan({ planId: first.plan!.id, sessionId, sourceRunId: 'user', baseVersion: 1, author: 'user', operations: [{ op: 'set_summary', value: 'user edit' }] })
    expect(current.ok).toBe(true)
    const stale = updatePlan({ planId: first.plan!.id, sessionId, sourceRunId: 'run-1', baseVersion: 1, operations: [{ op: 'set_summary', value: 'stale agent edit' }] })
    expect(stale.ok).toBe(false)
    expect(stale.conflict?.currentVersion).toBe(2)
    expect(getPlan(first.plan!.id)?.summary).toBe('user edit')
  })
})
