import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../../../shared/domain/scheduled'

const state = vi.hoisted(() => ({ tasks: [] as ScheduledTask[] }))
vi.mock('electron', () => ({ Notification: { isSupported: () => false } }))
vi.mock('../../runtime', () => ({ runAgent: vi.fn() }))
vi.mock('../../window/registry', () => ({ windows: { emitToAll: vi.fn() } }))
vi.mock('../../state/store', () => ({ store: { listScheduledTasks: () => state.tasks } }))

import { startScheduler, stopScheduler } from '../scheduler'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
  state.tasks = []
})

afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const task = (delay: number): ScheduledTask => ({
  id: 'task', name: 'Future task', prompt: 'test', workspaceId: 'workspace', model: 'test',
  timezone: 'UTC', schedule: { kind: 'once', at: '2026-11-06T00:00' },
  repeatWindow: { enabled: false }, enabled: true, nextRunAt: Date.now() + delay,
  createdAt: 1, updatedAt: 1
})

describe('scheduler timer bounds', () => {
  it('caps a distant occurrence and rechecks without a 1ms overflow loop', async () => {
    const day = 24 * 60 * 60 * 1000
    state.tasks = [task(31 * day)]
    const timers = vi.spyOn(globalThis, 'setTimeout')
    startScheduler()
    expect(timers.mock.calls.at(-1)?.[1]).toBe(2_147_483_647)
    await vi.advanceTimersByTimeAsync(day)
    expect(timers).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_147_483_647 - day)
    expect(timers.mock.calls.at(-1)?.[1]).toBeLessThan(2_147_483_647)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('preserves a short delay and removes the timer on shutdown', () => {
    state.tasks = [task(60_000)]
    const timers = vi.spyOn(globalThis, 'setTimeout')
    startScheduler()
    expect(timers.mock.calls.at(-1)?.[1]).toBe(60_000)
    stopScheduler()
    expect(vi.getTimerCount()).toBe(0)
  })
})
