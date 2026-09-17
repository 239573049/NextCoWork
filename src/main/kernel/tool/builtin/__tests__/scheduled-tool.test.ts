import { describe, expect, it, vi } from 'vitest'
import { SCHEDULED_AGENT_LIMITS, type SchedulingBridge, type ScheduledTaskSummary } from '../../../../../shared/domain/scheduled'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import {
  createScheduledTaskTool,
  deleteScheduledTaskTool,
  listScheduledTasksTool,
  scheduledTaskTools,
  updateScheduledTaskTool
} from '../scheduled'

/**
 * 四个定时任务工具的测试。
 *
 * 这里最重要的是三条**反向**断言,它们钉住的都是「有没有另一条路绕过去」:
 *
 * 1. 没有通道 / 没有工作区时,四个都**不下发**,而且调到了也拒 ——
 *    快照取自这一轮开头,而 `run()` 可能在几十秒后才执行。
 * 2. 子代理(`depth > 0`)**只能查,不能写**。
 * 3. 入参里**没有 workspace_id**:工作区身份只来自 ctx,模型说了不算。
 */

function summary(overrides: Partial<ScheduledTaskSummary> = {}): ScheduledTaskSummary {
  return {
    id: 'task_1',
    name: '每日构建检查',
    prompt: 'Run the build and report failures.',
    schedule: 'every day at 09:00 (Asia/Shanghai)',
    timezone: 'Asia/Shanghai',
    enabled: true,
    model: 'gpt-5.6-sol',
    nextRunAt: '2026-09-18 09:00',
    createdBy: 'agent',
    ...overrides
  }
}

function bridge(overrides: Partial<SchedulingBridge> = {}): SchedulingBridge {
  return {
    list: vi.fn(() => Promise.resolve([summary()])),
    create: vi.fn(() => Promise.resolve(summary())),
    update: vi.fn(() => Promise.resolve(summary({ name: '改过的名字' }))),
    remove: vi.fn(() => Promise.resolve({ id: 'task_1', name: '每日构建检查' })),
    ...overrides
  }
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session_1',
    workspaceId: 'ws_1',
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    model: 'gpt-5.6-sol',
    host: nodeHost(),
    emit: () => {},
    scheduling: bridge(),
    ...overrides
  }
}

const CREATE = {
  name: '每日构建检查',
  prompt: 'Run `npm run build` in /repo and report any failure.',
  schedule: { kind: 'daily', time: '09:00' }
}

describe('定时任务工具 · 元数据', () => {
  it('★ 只有查是只读的,三个写工具一律标破坏性 —— auto 档也要弹一次审批', () => {
    expect(listScheduledTasksTool.readOnly).toBe(true)
    expect(listScheduledTasksTool.destructive).toBe(false)
    for (const tool of [createScheduledTaskTool, updateScheduledTaskTool, deleteScheduledTaskTool]) {
      expect(tool.readOnly, tool.internalId).toBe(false)
      expect(tool.destructive, tool.internalId).toBe(true)
    }
    for (const tool of scheduledTaskTools) {
      expect(tool.needsNetwork, tool.internalId).toBe(false)
    }
  })

  /**
   * ★ 工作区身份是 ctx 的事。入参里一旦出现 workspace_id,
   * 就等于开了一条「模型指定跨工作区写入」的路,而那个 id 只能来自转录。
   */
  it('★ 四个工具的入参 schema 里都没有 workspace_id', () => {
    for (const tool of scheduledTaskTools) {
      expect(JSON.stringify(tool.inputSchema), tool.internalId).not.toContain('workspace_id')
    }
  })

  /** 描述是模型唯一会读的规格 —— 「新会话看不到当前对话」漏了,它就会写「继续刚才的分析」 */
  it('★ 创建工具的描述里写死「新会话、看不到这次对话」', () => {
    expect(createScheduledTaskTool.description).toMatch(/BRAND-NEW session/)
    expect(createScheduledTaskTool.description).toMatch(/cannot see this conversation/)
  })
})

describe('定时任务工具 · 三道门', () => {
  it('没有通道时四个都不下发,且调到了也拒', async () => {
    const noBridge = ctx({ scheduling: undefined })
    for (const tool of scheduledTaskTools) {
      expect(tool.isEnabled?.(noBridge), tool.internalId).toBe(false)
    }
    const r = await listScheduledTasksTool.execute({}, noBridge)
    expect(r.isError).toBe(true)
  })

  it('没有工作区时同样整体不下发', () => {
    const noWorkspace = ctx({ workspaceId: undefined })
    for (const tool of scheduledTaskTools) {
      expect(tool.isEnabled?.(noWorkspace), tool.internalId).toBe(false)
    }
  })

  it('★ 子代理只能查,不能建/改/删', async () => {
    const child = ctx({ depth: 1 })
    expect(listScheduledTasksTool.isEnabled?.(child)).toBe(true)
    for (const tool of [createScheduledTaskTool, updateScheduledTaskTool, deleteScheduledTaskTool]) {
      expect(tool.isEnabled?.(child), tool.internalId).toBe(false)
    }
    const created = await createScheduledTaskTool.execute(CREATE, child)
    expect(created.isError).toBe(true)
    expect(created.output.content).toMatch(/subagent/i)
    expect((child.scheduling?.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})

describe('定时任务工具 · 执行', () => {
  it('查:空工作区说人话,有任务时给结构化清单', async () => {
    const empty = ctx({ scheduling: bridge({ list: () => Promise.resolve([]) }) })
    expect((await listScheduledTasksTool.execute({}, empty)).output.content).toMatch(/no scheduled tasks/i)

    const listed = await listScheduledTasksTool.execute({}, ctx())
    expect(listed.isError).toBe(false)
    expect(listed.output.content).toContain('"count": 1')
    expect(listed.output.content).toContain('2026-09-18 09:00')
  })

  it('建:snake_case 的重复窗口转成领域层的 camelCase', async () => {
    const c = ctx()
    const result = await createScheduledTaskTool.execute(
      { ...CREATE, repeat_window: { enabled: true, end_time: '18:00', interval_minutes: 30 } },
      c
    )
    expect(result.isError).toBe(false)
    const call = (c.scheduling?.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(call).toMatchObject({
      name: CREATE.name,
      schedule: { kind: 'daily', time: '09:00' },
      repeatWindow: { enabled: true, endTime: '18:00', intervalMinutes: 30 }
    })
    // ★ 模型没指定模型别名时不塞一个进去 —— 继承当前 run 的模型是桥的事
    expect(call).not.toHaveProperty('model')
  })

  it(`★ 重复间隔小于 ${String(SCHEDULED_AGENT_LIMITS.minIntervalMinutes)} 分钟被 schema 挡住`, async () => {
    const c = ctx()
    const result = await createScheduledTaskTool.execute(
      { ...CREATE, repeat_window: { enabled: true, end_time: '18:00', interval_minutes: 1 } },
      c
    )
    expect(result.isError).toBe(true)
    expect((c.scheduling?.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('改:只带 task_id 时拒绝 —— 一次什么都不改的写入是模型搞错了,不该静默成功', async () => {
    const c = ctx()
    const result = await updateScheduledTaskTool.execute({ task_id: 'task_1' }, c)
    expect(result.isError).toBe(true)
    expect((c.scheduling?.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('改:只发变化的字段,没发的一个都不进 patch', async () => {
    const c = ctx()
    await updateScheduledTaskTool.execute({ task_id: 'task_1', enabled: false }, c)
    const [id, patch] = (c.scheduling?.update as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(id).toBe('task_1')
    expect(patch).toEqual({ enabled: false })
  })

  it('删:回话里带名字,让模型能向用户复述删掉的是哪一条', async () => {
    const result = await deleteScheduledTaskTool.execute({ task_id: 'task_1' }, ctx())
    expect(result.isError).toBe(false)
    expect(result.output.content).toContain('每日构建检查')
  })

  /** ★ 桥抛出来的话是给模型看的「下一步怎么改」,不能被包成一句内部错误 */
  it('★ 桥的拒绝原样转给模型', async () => {
    const refused = ctx({
      scheduling: bridge({ create: () => Promise.reject(new Error('This workspace already has 20 scheduled tasks')) })
    })
    const result = await createScheduledTaskTool.execute(CREATE, refused)
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('already has 20 scheduled tasks')
  })

  it('坏入参被 schema 挡住,不到桥那一层', async () => {
    const c = ctx()
    for (const bad of [
      { ...CREATE, schedule: { kind: 'daily', time: '9:00' } },
      { ...CREATE, schedule: { kind: 'weekly', weekdays: [], time: '09:00' } },
      { ...CREATE, name: '' },
      { prompt: 'x', schedule: { kind: 'daily', time: '09:00' } }
    ]) {
      expect((await createScheduledTaskTool.execute(bad, c)).isError, JSON.stringify(bad)).toBe(true)
    }
    expect((c.scheduling?.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
