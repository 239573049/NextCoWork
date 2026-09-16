import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspacePaths } from '../../../environment/paths'
import { activePlanForRun, leavePlanRun, planToolAllowList } from '../../plan-run'
import { nodeHost } from '../../host'
import { editTool, writeTool } from '../builtin/fs'
import { enterPlanModeTool, exitPlanModeTool } from '../builtin/plan-file'
import type { ToolContext } from '../registry'

let root = ''
let runId = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-plan-'))
  runId = `run-${Date.now()}`
})

afterEach(() => {
  leavePlanRun(runId)
  rmSync(root, { recursive: true, force: true })
})

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const base = nodeHost()
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    permissionMode: 'full',
    depth: 0,
    callId: 'call-1',
    runId,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    host: { ...base, path: createWorkspacePaths(base.fs, process.platform) },
    emit: () => undefined,
    ...overrides
  }
}

describe('file-backed Plan mode', () => {
  it('creates one Markdown file and changes the available workflow tools by phase', async () => {
    const before = planToolAllowList(runId, ['EnterPlanMode', 'Write', 'Edit', 'ExitPlanMode', 'Read'])
    expect(before).toEqual(['EnterPlanMode', 'Read'])

    // Local runs provide KernelHost without WorkspaceHost.path; this is the default desktop path.
    const result = await enterPlanModeTool.execute({ reason: 'Requirements are clear.' }, context({ host: nodeHost() }))
    expect(result.isError).toBe(false)
    const active = activePlanForRun(runId)
    expect(active?.path).toMatch(/^\.plan\/[0-9A-HJKMNP-TV-Z]{26}\.md$/)
    expect(readFileSync(active!.absolutePath, 'utf8')).toBe('')
    expect(planToolAllowList(runId, ['EnterPlanMode', 'Write', 'Edit', 'ExitPlanMode', 'Read']))
      .toEqual(['Write', 'Edit', 'ExitPlanMode', 'Read'])

    const second = await enterPlanModeTool.execute({}, context())
    expect(second.isError).toBe(true)
    expect(second.output.content).toContain('already active')
  })

  it('hard-fences Write and Edit to the active plan path', async () => {
    await enterPlanModeTool.execute({}, context())
    const active = activePlanForRun(runId)!
    const fenced = context({ writeFileRestriction: active.absolutePath })

    const blocked = await writeTool.execute({ file_path: join(root, 'src.ts'), content: 'no' }, fenced)
    expect(blocked.isError).toBe(true)
    expect(blocked.output.content).toContain('only modify its active Markdown plan')

    const written = await writeTool.execute({ file_path: active.absolutePath, content: '# Plan\n\n1. Implement.' }, fenced)
    expect(written.isError).toBe(false)
    const edited = await editTool.execute({
      file_path: active.absolutePath,
      old_string: 'Implement.',
      new_string: 'Implement and verify.'
    }, fenced)
    expect(edited.isError).toBe(false)
    expect(readFileSync(active.absolutePath, 'utf8')).toContain('Implement and verify.')
  })

  it('presents the saved Markdown and stops after approval', async () => {
    await enterPlanModeTool.execute({}, context())
    const active = activePlanForRun(runId)!
    await writeTool.execute({ file_path: active.absolutePath, content: '# Approved plan' }, context({ writeFileRestriction: active.absolutePath }))

    let presented: unknown
    const result = await exitPlanModeTool.execute({}, context({
      interact: async (request) => {
        presented = request
        return { id: 'interaction-1', kind: 'plan_approval', action: 'approve_current' }
      }
    }))
    expect(presented).toMatchObject({
      kind: 'plan_approval',
      planId: active.planId,
      path: active.path,
      plan: '# Approved plan'
    })
    expect(result.stopRun).toBe(true)
    expect(JSON.parse(result.output.content)).toMatchObject({
      type: 'plan_file',
      planId: active.planId,
      path: active.path,
      action: 'approve_current'
    })
  })

  it('continues the same run when the user requests a revision', async () => {
    await enterPlanModeTool.execute({}, context())
    const active = activePlanForRun(runId)!
    await writeTool.execute({ file_path: active.absolutePath, content: '# Draft plan' }, context({ writeFileRestriction: active.absolutePath }))
    const result = await exitPlanModeTool.execute({}, context({
      interact: async () => ({ id: 'interaction-1', kind: 'plan_approval', action: 'request_revision', feedback: 'Add tests.' })
    }))
    expect(result.stopRun).toBe(false)
    expect(result.output.content).toContain('Add tests.')
    expect(activePlanForRun(runId)?.planId).toBe(active.planId)
  })
})
