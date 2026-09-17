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

/** 谁建的这条任务。缺省(旧数据、界面手建)一律按 `'user'` 读。 */
export type ScheduledTaskCreator = 'user' | 'agent'

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
  /** 缺省 = `'user'` —— 字段引入之前的任务全部落在这一档。 */
  createdBy?: ScheduledTaskCreator
  /**
   * 自动排程的层数:用户手建 = 0,定时任务**运行当中**由 Agent 建的 = 父任务 + 1。
   *
   * ★ 没有这个数,一个每天跑的任务可以在每次运行时再建一个任务,而新任务又接着建 ——
   * 指数增长,且在用户打开定时任务面板之前**没有任何症状**。
   */
  chainDepth?: number
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
  createdBy?: ScheduledTaskCreator
  chainDepth?: number
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
    updatedAt: now,
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    ...(input.chainDepth === undefined ? {} : { chainDepth: input.chainDepth })
  }
}

export function advanceScheduledTask(task: ScheduledTask, after: number): ScheduledTask {
  const next = task.enabled ? nextScheduledOccurrence(task.schedule, task.timezone, task.repeatWindow, after) : null
  return { ...task, nextRunAt: next, updatedAt: after }
}

/** Background runs never wait for an interactive permission prompt. */
export const SCHEDULED_PERMISSION_MODE: PermissionMode = 'full'

// ─────────────────────── Agent 侧(工具)的领域约定 ───────────────────────

/**
 * 只对**模型**生效的那几条上限 —— 用户在界面里不受它们约束。
 *
 * ★ 分开写而不是收紧领域层的校验:界面上的每一次创建背后都站着一个人,
 * 而工具那一侧站着的是一个会把「每分钟检查一次」当成合理安排的模型。
 */
export const SCHEDULED_AGENT_LIMITS = {
  /** 每个工作区模型能建到的上限。到顶之后 create 直接拒,并让模型去删旧的。 */
  maxTasksPerWorkspace: 20,
  /** 链式排程的最大层数(用户手建 = 0)。见 `ScheduledTask.chainDepth`。 */
  maxChainDepth: 2,
  /** 窗口内重复的最小间隔。领域层允许 1 分钟,那是给界面上的人用的。 */
  minIntervalMinutes: 5,
  maxNameLength: 60,
  maxPromptLength: 4000
} as const

/**
 * 交给模型看的一条任务。
 *
 * ★ 时间一律是**已经格式化好的本地时间字符串**,不是时间戳:模型拿到 epoch
 * 毫秒只会按 UTC 复述给用户,而任务是按 `timezone` 跑的 —— 那种错说出来
 * 一字不差地像真的(「已设为明早 9 点」),用户要到第二天才发现不对。
 */
export interface ScheduledTaskSummary {
  id: string
  name: string
  prompt: string
  /** 人话的规则,如 `every day at 09:00 (Asia/Shanghai)` */
  schedule: string
  timezone: string
  enabled: boolean
  model: string
  modelProviderId?: string
  /** 下次触发的本地时间;停用或规则已过期时为 null */
  nextRunAt: string | null
  createdBy: ScheduledTaskCreator
}

export interface SchedulingCreateInput {
  name: string
  prompt: string
  schedule: ScheduleRule
  timezone?: string
  repeatWindow?: RepeatWindow
  model?: string
  modelProviderId?: string
  enabled?: boolean
}

export type SchedulingUpdateInput = Partial<SchedulingCreateInput>

/**
 * 工具与主进程之间**唯一**的接触面(同 `SpawnSubagentFn` 的道理):
 * 工具住在内核里,而 store / 调度器 / 窗口广播住在 `main/`。
 *
 * ★ 失败一律 **throw 一个模型读得懂的英文 Error**,由工具转成 `toolFail` ——
 * 返回一个 `{ ok: false }` 型的结果会让每个调用点都要写一遍分支,而漏写的那处
 * 会把失败当成成功报给模型。
 */
export interface SchedulingBridge {
  list(): Promise<ScheduledTaskSummary[]>
  create(input: SchedulingCreateInput): Promise<ScheduledTaskSummary>
  update(id: string, patch: SchedulingUpdateInput): Promise<ScheduledTaskSummary>
  remove(id: string): Promise<{ id: string; name: string }>
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** `1714032000000` → `2024-04-25 09:00`(按给定时区)。时区非法时回退到 ISO。 */
export function formatInstantInZone(at: number, timezone: string): string {
  try {
    const p = partsInZone(at, timezone)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${String(p.year ?? 0)}-${pad(p.month ?? 1)}-${pad(p.day ?? 1)} ${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}`
  } catch {
    return new Date(at).toISOString()
  }
}

/** 一条规则的人话版本 —— 模型复述给用户时逐字用它。 */
export function describeScheduleRule(rule: ScheduleRule, timezone: string, repeatWindow?: RepeatWindow): string {
  const base = rule.kind === 'once'
    ? `once at ${rule.at.replace('T', ' ')}`
    : rule.kind === 'daily'
      ? `every day at ${rule.time}`
      : `every ${rule.weekdays.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join(', ')} at ${rule.time}`
  const repeat = repeatWindow?.enabled === true && repeatWindow.endTime !== undefined
    ? `, then every ${String(repeatWindow.intervalMinutes ?? 60)} minutes until ${repeatWindow.endTime}`
    : ''
  return `${base}${repeat} (${timezone})`
}

/** 存储形态 → 模型看的形态。**唯一**的转换处,免得两个工具各转一份。 */
export function summarizeScheduledTask(task: ScheduledTask): ScheduledTaskSummary {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    schedule: describeScheduleRule(task.schedule, task.timezone, task.repeatWindow),
    timezone: task.timezone,
    enabled: task.enabled,
    model: task.model,
    ...(task.modelProviderId === undefined ? {} : { modelProviderId: task.modelProviderId }),
    nextRunAt: task.nextRunAt === null ? null : formatInstantInZone(task.nextRunAt, task.timezone),
    createdBy: task.createdBy ?? 'user'
  }
}
