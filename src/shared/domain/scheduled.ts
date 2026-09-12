import type { PermissionMode } from '../agent/permission'

export type ScheduleRule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }

export interface RepeatWindow {
  enabled: boolean
  endTime?: string
  intervalMinutes?: number
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  workspaceId: string
  model: string
  modelProviderId?: string
  schedule: ScheduleRule
  timezone: string
  repeatWindow: RepeatWindow
  enabled: boolean
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export type ScheduledRunStatus = 'queued' | 'running' | 'success' | 'error' | 'skipped' | 'aborted'

export interface ScheduledRun {
  id: string
  taskId: string
  sessionId: string
  trigger: 'scheduled' | 'manual'
  status: ScheduledRunStatus
  scheduledAt: number
  startedAt?: number
  endedAt?: number
  summary?: string
  error?: string
}

export interface ScheduledTaskInput {
  name: string
  prompt: string
  workspaceId: string
  model: string
  modelProviderId?: string
  schedule: ScheduleRule
  timezone?: string
  repeatWindow?: RepeatWindow
  enabled?: boolean
}

export const DEFAULT_REPEAT_WINDOW: RepeatWindow = { enabled: false }

function partsInZone(at: number, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23'
  }).formatToParts(new Date(at))
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

function zoneOffset(at: number, timezone: string): number {
  const p = partsInZone(at, timezone)
  const asUtc = Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
  return asUtc - at
}

function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const first = naive - zoneOffset(naive, timezone)
  const second = naive - zoneOffset(first, timezone)
  return second
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const hour = Number(match[1]); const minute = Number(match[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

function parseLocalDateTime(value: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const [, year, month, day, hour, minute] = match
  const parsed = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) }
  if (!parseTime(`${hour}:${minute}`) || parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > 31) return null
  return parsed
}

function addDays(year: number, month: number, day: number, amount: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function nextAtOrAfterLocal(
  rule: ScheduleRule,
  timezone: string,
  after: number,
): number | null {
  if (rule.kind === 'once') {
    const local = parseLocalDateTime(rule.at)
    if (local === null) return null
    const timestamp = localToUtc(local.year, local.month, local.day, local.hour, local.minute, timezone)
    return timestamp > after ? timestamp : null
  }
  const time = parseTime(rule.time)
  if (time === null) return null
  const current = partsInZone(after, timezone)
  const maxDays = rule.kind === 'daily' ? 370 : 14
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = addDays(current.year ?? 1970, current.month ?? 1, current.day ?? 1, offset)
    if (rule.kind === 'weekly') {
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
      if (!rule.weekdays.includes(weekday)) continue
    }
    const candidate = localToUtc(date.year, date.month, date.day, time.hour, time.minute, timezone)
    if (candidate > after) return candidate
  }
  return null
}

export function nextScheduledAt(rule: ScheduleRule, timezone: string, after = Date.now()): number | null {
  try {
    return nextAtOrAfterLocal(rule, timezone, after)
  } catch {
    return null
  }
}

/** Returns the next fixed schedule occurrence, including optional same-day repeats. */
export function nextScheduledOccurrence(
  rule: ScheduleRule,
  timezone: string,
  repeatWindow: RepeatWindow = DEFAULT_REPEAT_WINDOW,
  after = Date.now(),
): number | null {
  if (!repeatWindow.enabled) return nextScheduledAt(rule, timezone, after)
  const interval = Math.max(1, Math.round(repeatWindow.intervalMinutes ?? 60))
  const end = parseTime(repeatWindow.endTime ?? '')
  if (end === null) return nextScheduledAt(rule, timezone, after)

  const current = partsInZone(after, timezone)
  const maxDays = rule.kind === 'once' ? 1 : rule.kind === 'daily' ? 370 : 14
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = addDays(current.year ?? 1970, current.month ?? 1, current.day ?? 1, offset)
    let start: { hour: number; minute: number }
    if (rule.kind === 'once') {
      const local = parseLocalDateTime(rule.at)
      if (local === null || local.year !== date.year || local.month !== date.month || local.day !== date.day) continue
      start = { hour: local.hour, minute: local.minute }
    } else {
      const parsedTime = parseTime(rule.time)
      if (parsedTime === null) continue
      start = parsedTime
      if (rule.kind === 'weekly') {
        const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
        if (!rule.weekdays.includes(weekday)) continue
      }
    }
    const startAt = localToUtc(date.year, date.month, date.day, start.hour, start.minute, timezone)
    const endAt = localToUtc(date.year, date.month, date.day, end.hour, end.minute, timezone)
    const lastAt = endAt > startAt ? endAt : startAt
    for (let candidate = startAt; candidate <= lastAt; candidate += interval * 60_000) {
      if (candidate > after) return candidate
    }
    if (rule.kind === 'once') break
  }
  return null
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function normalizeScheduledTaskInput(input: ScheduledTaskInput, now = Date.now()): Omit<ScheduledTask, 'id'> {
  const timezone = input.timezone?.trim() || systemTimeZone()
  const repeatWindow = input.repeatWindow?.enabled
    ? {
        enabled: true,
        endTime: input.repeatWindow.endTime,
        intervalMinutes: Math.max(1, Math.round(input.repeatWindow.intervalMinutes ?? 60))
      }
    : { enabled: false }
  return {
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    workspaceId: input.workspaceId,
    model: input.model,
    ...(input.modelProviderId === undefined ? {} : { modelProviderId: input.modelProviderId }),
    schedule: input.schedule,
    timezone,
    repeatWindow,
    enabled: input.enabled ?? true,
    nextRunAt: input.enabled === false ? null : nextScheduledOccurrence(input.schedule, timezone, repeatWindow, now),
    createdAt: now,
    updatedAt: now
  }
}

export function advanceScheduledTask(task: ScheduledTask, after: number): ScheduledTask {
  const next = task.enabled ? nextScheduledOccurrence(task.schedule, task.timezone, task.repeatWindow, after) : null
  return { ...task, nextRunAt: next, updatedAt: after }
}

/** Background runs never wait for an interactive permission prompt. */
export const SCHEDULED_PERMISSION_MODE: PermissionMode = 'full'
