/**
 * 定时任务的四个工具 —— 让模型能把「以后再做的事」交给调度器,而不是
 * 在回复里写一句「我明早九点提醒你」(它没有明早)。
 *
 * ## 为什么是四个,不是一个带 action 的
 *
 * `readOnly` 是**工具级**的静态标记:plan 模式按它摘工具,权限闸门按它决定要不要
 * 弹审批(`permission-gate.ts` 那张表的第 2 行)。合成一个带 `action` 的工具,
 * 就只能整体标成「写」—— 于是计划模式下模型连「现在有哪些定时任务」都查不了,
 * 而查一下本来是零风险的。
 *
 * ## 三道门(`isEnabled`,`run()` 进门再核一遍)
 *
 * 1. `ctx.scheduling === undefined` —— 这个环境里排不了程(纯内核测试、无头调用)。
 * 2. `ctx.workspaceId === undefined` —— 任务是挂在工作区上的,没有工作区就没有归属。
 * 3. **写的三个另加 `depth === 0`** —— 子代理不排程。它看不到当前对话,
 *    「用户到底想不想要一条每天跑的任务」这件事它没有判断依据;而排程的后果
 *    (无人值守、full 权限、按天重复)远超出一次子任务该有的影响范围。
 *
 * ★ 快照取自这一轮的开头,而 `run()` 可能在几十秒之后才执行 —— 所以同一份判定
 * 两处都跑一遍(同 `goal.ts`)。
 *
 * ## 工作区身份不接受模型传
 *
 * 四个工具都**没有** `workspace_id` 参数,一律用 `ctx.workspaceId`:让模型指定
 * 工作区等于开了一条跨工作区写入的路,而它拿到的 id 只能来自转录里某处的引用 ——
 * 那正是最容易被提示注入拨动的东西。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import {
  SCHEDULED_AGENT_LIMITS,
  type SchedulingCreateInput,
  type SchedulingUpdateInput
} from '../../../../shared/domain/scheduled'
import { defineTool } from '../define'
import type { ToolContext, ToolRegistration } from '../registry'

/** 读:有通道、有工作区就行。 */
function canRead(ctx: ToolContext): boolean {
  return ctx.scheduling !== undefined && ctx.workspaceId !== undefined
}

/** 写:再加一条「不是子代理」。 */
function canWrite(ctx: ToolContext): boolean {
  return canRead(ctx) && ctx.depth === 0
}

const UNAVAILABLE =
  'Scheduled tasks are unavailable in this session. Do not retry — tell the user what you would have scheduled and continue.'

const SUBAGENT_REFUSED =
  'A subagent cannot create or change scheduled tasks. Report what should be scheduled to the parent agent instead.'

// ─────────────────────────── 入参 ───────────────────────────

/**
 * 规则。★ 判别联合直接映射 `ScheduleRule`,不另造一套扁平形状 ——
 * 两份形状迟早会漂,而漂的症状是「模型按 schema 传了参,任务却没有按那个时间跑」。
 */
const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('Local date-time "YYYY-MM-DDTHH:MM", must be in the future')
  }),
  z.object({
    kind: z.literal('daily'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Local time of day, "HH:MM"')
  }),
  z.object({
    kind: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).describe('0 = Sunday … 6 = Saturday'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Local time of day, "HH:MM"')
  })
]).describe('When the task fires')

const RepeatWindowSchema = z.object({
  enabled: z.boolean(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Local time the repeat window closes, "HH:MM"'),
  interval_minutes: z
    .number()
    .int()
    .min(SCHEDULED_AGENT_LIMITS.minIntervalMinutes)
    .optional()
    .describe(`Minutes between repeats inside the window (minimum ${String(SCHEDULED_AGENT_LIMITS.minIntervalMinutes)})`)
}).describe('Optional: repeat inside the same day until end_time. Leave it out for a single run per occurrence.')

const CommonFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(SCHEDULED_AGENT_LIMITS.maxNameLength)
    .describe('Short label shown in the scheduled-task list'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(SCHEDULED_AGENT_LIMITS.maxPromptLength)
    .describe(
      'The full instruction the agent receives when the task fires. It runs in a BRAND-NEW session that ' +
        'cannot see this conversation, so it must be self-contained.'
    ),
  timezone: z.string().trim().min(1).optional().describe('IANA timezone, e.g. "Asia/Shanghai". Defaults to this machine\'s timezone.'),
  repeat_window: RepeatWindowSchema.optional(),
  model: z.string().trim().min(1).optional().describe("Model alias. Omit to reuse this session's model — do not guess one."),
  enabled: z.boolean().optional().describe('Defaults to true')
}

const CreateInput = z.object({ ...CommonFields, schedule: ScheduleSchema })

const UpdateInput = z.object({
  task_id: z.string().trim().min(1).describe('Id from ListScheduledTasks'),
  name: CommonFields.name.optional(),
  prompt: CommonFields.prompt.optional(),
  schedule: ScheduleSchema.optional(),
  timezone: CommonFields.timezone,
  repeat_window: CommonFields.repeat_window,
  model: CommonFields.model,
  enabled: CommonFields.enabled
})

const DeleteInput = z.object({ task_id: z.string().trim().min(1).describe('Id from ListScheduledTasks') })

type RepeatWindowInput = z.infer<typeof RepeatWindowSchema>

/** snake_case(模型那侧的惯例)→ 领域层的 camelCase。 */
function toRepeatWindow(input: RepeatWindowInput | undefined): SchedulingCreateInput['repeatWindow'] {
  if (input === undefined) return undefined
  return {
    enabled: input.enabled,
    ...(input.end_time === undefined ? {} : { endTime: input.end_time }),
    ...(input.interval_minutes === undefined ? {} : { intervalMinutes: input.interval_minutes })
  }
}

/** 桥抛出来的话原样转给模型 —— 它写的就是「下一步该怎么改」。 */
function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─────────────────────────── 四个工具 ───────────────────────────

const SHARED_NOTE =
  'Scheduled tasks belong to the current workspace and run unattended in a new session with full ' +
  'permissions — no one is there to answer a question or approve anything.'

export const listScheduledTasksTool: ToolRegistration = defineTool({
  internalId: 'ListScheduledTasks',
  description:
    'List the scheduled tasks of the current workspace: id, name, prompt, schedule in plain words, ' +
    'timezone, whether it is enabled, and the next run time.\n' +
    'Call this before updating or deleting anything — the ids come from here, and they are the only ' +
    'valid input for UpdateScheduledTask and DeleteScheduledTask. ' +
    'Also call it before creating a task the user described loosely ("the nightly report"), so you ' +
    'change the existing one instead of adding a near-duplicate.',
  schema: z.object({}),
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  isEnabled: canRead,
  async run(_input, ctx) {
    if (!canRead(ctx) || ctx.scheduling === undefined) return toolFail(UNAVAILABLE)
    try {
      const tasks = await ctx.scheduling.list()
      if (tasks.length === 0) return toolOk('This workspace has no scheduled tasks.')
      return toolOk(JSON.stringify({ count: tasks.length, tasks }, null, 2))
    } catch (error) {
      return toolFail(failureOf(error))
    }
  }
})

export const createScheduledTaskTool: ToolRegistration = defineTool({
  internalId: 'CreateScheduledTask',
  description:
    `Create a scheduled task in the current workspace. ${SHARED_NOTE}\n\n` +
    'When to use it:\n' +
    '- The user asked for something to happen LATER or REPEATEDLY ("every morning", "next Monday", ' +
    '"check the build every day at 9")\n' +
    '- Never for work you can simply do now, and never to give yourself a reminder\n\n' +
    'Before you call it:\n' +
    '- Confirm the time AND the timezone with the user in their own words. You cannot see their clock\n' +
    '- Write `prompt` so it stands on its own: the run starts a BRAND-NEW session that cannot see this ' +
    'conversation, has no memory of it, and cannot ask anyone anything. Spell out the repository paths, ' +
    'the commands, and what "done" means\n' +
    '- Omit `model` unless the user named one — the task inherits this session\'s model\n\n' +
    `Limits: at most ${String(SCHEDULED_AGENT_LIMITS.maxTasksPerWorkspace)} tasks per workspace, and a ` +
    'repeat interval of at least ' + `${String(SCHEDULED_AGENT_LIMITS.minIntervalMinutes)} minutes. ` +
    'The reply states the next run time in the task\'s own timezone — quote THAT back to the user, do not ' +
    'restate the time from memory.',
  schema: CreateInput,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  needsNetwork: false,
  isEnabled: canWrite,
  async run(input, ctx) {
    if (!canRead(ctx) || ctx.scheduling === undefined) return toolFail(UNAVAILABLE)
    if (ctx.depth !== 0) return toolFail(SUBAGENT_REFUSED)
    const repeatWindow = toRepeatWindow(input.repeat_window)
    try {
      const created = await ctx.scheduling.create({
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(repeatWindow === undefined ? {} : { repeatWindow }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled })
      })
      return toolOk(JSON.stringify({ created, note: 'Tell the user the schedule and nextRunAt exactly as written here.' }, null, 2))
    } catch (error) {
      return toolFail(failureOf(error))
    }
  }
})

export const updateScheduledTaskTool: ToolRegistration = defineTool({
  internalId: 'UpdateScheduledTask',
  description:
    `Change an existing scheduled task of the current workspace — including tasks the user created by hand. ${SHARED_NOTE}\n` +
    'Send only the fields that change; everything you leave out keeps its current value. ' +
    'Use `enabled: false` to pause a task instead of deleting it when the user may want it back.\n' +
    'Get `task_id` from ListScheduledTasks — never guess it. Changing the schedule recomputes the next ' +
    'run time, which the reply states; quote that back to the user.',
  schema: UpdateInput,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  needsNetwork: false,
  isEnabled: canWrite,
  async run(input, ctx) {
    if (!canRead(ctx) || ctx.scheduling === undefined) return toolFail(UNAVAILABLE)
    if (ctx.depth !== 0) return toolFail(SUBAGENT_REFUSED)
    const repeatWindow = toRepeatWindow(input.repeat_window)
    const patch: SchedulingUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(repeatWindow === undefined ? {} : { repeatWindow }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled })
    }
    if (Object.keys(patch).length === 0) {
      return toolFail('Nothing to update — send at least one field besides task_id.')
    }
    try {
      const updated = await ctx.scheduling.update(input.task_id, patch)
      return toolOk(JSON.stringify({ updated }, null, 2))
    } catch (error) {
      return toolFail(failureOf(error))
    }
  }
})

export const deleteScheduledTaskTool: ToolRegistration = defineTool({
  internalId: 'DeleteScheduledTask',
  description:
    'Delete a scheduled task of the current workspace. This cannot be undone and the task history goes ' +
    'with it, so prefer UpdateScheduledTask with `enabled: false` when the user only wants it to stop ' +
    'for now. Delete only what the user asked you to delete — get `task_id` from ListScheduledTasks and ' +
    'confirm you are naming the same task they are.',
  schema: DeleteInput,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  needsNetwork: false,
  isEnabled: canWrite,
  async run(input, ctx) {
    if (!canRead(ctx) || ctx.scheduling === undefined) return toolFail(UNAVAILABLE)
    if (ctx.depth !== 0) return toolFail(SUBAGENT_REFUSED)
    try {
      const removed = await ctx.scheduling.remove(input.task_id)
      return toolOk(`Deleted scheduled task "${removed.name}" (${removed.id}).`)
    } catch (error) {
      return toolFail(failureOf(error))
    }
  }
})

/** 这一组的全部工具。顺序即下发顺序:先只读的那个,模型多半先查再改。 */
export const scheduledTaskTools: readonly ToolRegistration[] = [
  listScheduledTasksTool,
  createScheduledTaskTool,
  updateScheduledTaskTool,
  deleteScheduledTaskTool
]
