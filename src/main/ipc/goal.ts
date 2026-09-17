/** Goal IPC: state broadcasts are global; an idle check-in goes to one owning renderer. */
import type { InvokeReq, InvokeRes } from '../../shared/ipc/contract'
import { GOAL_CONDITION_MAX, normalizeGoalCondition } from '../../shared/domain/goal'
import { activateGoal, deactivateGoal, goalSourceRunId, restoreGoal, setGoalChangeListener } from '../goal/runtime'
import { getActiveGoal } from '../goal/state'
import { ensureGoalRuntime, getHost } from '../runtime'
import { interactions } from '../kernel/interaction-gate'
import { runTopic, windows, type WindowContext } from '../window/registry'

export function registerGoalBridge(): void {
  ensureGoalRuntime()
  setGoalChangeListener((change, sourceRunId) => {
    if (change.input === undefined) {
      windows.emitToAll('goal:changed', change)
      return true
    }
    const { input: _input, ...state } = change
    windows.emitToAll('goal:changed', state)
    // Sending a wake-up to every window would start the same work more than once.
    const owner = windows.list().find((window) => !window.sender.isDestroyed()
      && sourceRunId !== undefined && windows.isSubscribed(runTopic(sourceRunId), window.sender))
    if (owner === undefined) return false
    windows.emitTo(owner.sender, 'goal:changed', change)
    return true
  })
}

export function getGoal(req: InvokeReq<'goal:get'>, ctx?: WindowContext): InvokeRes<'goal:get'> {
  ensureGoalRuntime()
  const goal = restoreGoal(req.sessionId)
  const sourceRunId = goalSourceRunId(req.sessionId)
  if (ctx !== undefined && sourceRunId !== undefined) windows.subscribe(runTopic(sourceRunId), ctx.sender)
  return goal
}

export function setGoal(req: InvokeReq<'goal:set'>): InvokeRes<'goal:set'> {
  ensureGoalRuntime()
  const condition = typeof req.condition === 'string' ? normalizeGoalCondition(req.condition) : ''
  if (condition === '') return { ok: false, reason: 'empty', length: 0 }
  if (condition.length > GOAL_CONDITION_MAX) return { ok: false, reason: 'too_long', length: condition.length }
  interactions.cancelGoalProposals(req.sessionId)
  const kickoff = activateGoal({ sessionId: req.sessionId, condition, origin: 'user', now: getHost().clock.now() })
  const goal = getActiveGoal(req.sessionId)
  if (goal === undefined) return { ok: false, reason: 'empty', length: 0 }
  return { ok: true, goal, kickoff: kickoff ?? [] }
}

export function clearGoal(req: InvokeReq<'goal:clear'>): void {
  ensureGoalRuntime()
  restoreGoal(req.sessionId)
  interactions.cancelGoalProposals(req.sessionId)
  deactivateGoal(req.sessionId, 'user_clear')
}
