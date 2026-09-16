import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeModeId } from '../../../shared/domain/mode'
import { nodeHost } from '../host'
import { scanModes, type ModeScanResult } from '../mode/load'
import { ModeRegistry } from '../mode/registry'

const fs = nodeHost().fs
let root = ''
let globalRoot = ''
let projectRoot = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-mode-'))
  globalRoot = join(root, 'global', 'modes')
  projectRoot = join(root, 'project', '.next-cowork', 'modes')
  mkdirSync(globalRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(scope: string, name: string, body: string): void {
  writeFileSync(join(scope, `${name}.md`), body)
}

function mode(name: string, description: string, tools = 'Read, Task', required = 'Task'): string {
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\nrequiredTools: ${required}\n---\nCoordinate this workflow.\n`
}

function scan(): Promise<ModeScanResult> {
  return scanModes({
    fs,
    globalRoot,
    projectRoot,
    availableTools: new Set(['Read', 'Task', 'AskUserQuestion'])
  })
}

describe('mode loader', () => {
  it('always includes immutable built-ins and loads a valid custom mode', async () => {
    put(globalRoot, 'review', mode('Review', 'Review through subagents'))
    const result = await scan()
    expect(result.modes.map((item) => item.id)).toEqual(expect.arrayContaining(['code', 'plan', 'acp', 'review']))
    expect(result.modes.find((item) => item.id === 'review')).toMatchObject({
      name: 'Review',
      tools: ['Read', 'Task'],
      requiredTools: ['Task'],
      source: { kind: 'global' }
    })
  })

  it('lets the project definition override a global custom mode', async () => {
    put(globalRoot, 'review', mode('Global review', 'Global'))
    put(projectRoot, 'review', mode('Project review', 'Project', 'Read', 'Read'))
    const result = await scan()
    expect(result.modes.find((item) => item.id === 'review')).toMatchObject({
      name: 'Project review',
      source: { kind: 'project' }
    })
  })

  it('rejects built-in overrides, unknown tools, and required tools outside the allow-list', async () => {
    put(globalRoot, 'code', mode('Override', 'Must not replace code'))
    put(globalRoot, 'unknown', mode('Unknown', 'Unknown tool', 'Read, MissingTool', 'Read'))
    put(globalRoot, 'invalid-required', mode('Invalid', 'Invalid required tool', 'Read', 'Task'))
    const result = await scan()
    expect(result.modes.filter((item) => ['unknown', 'invalid-required'].includes(item.id))).toEqual([])
    expect(result.modes.find((item) => item.id === 'code')?.source.kind).toBe('builtin')
    expect(result.diagnostics.some((item) => item.message.includes('cannot be overridden'))).toBe(true)
    expect(result.diagnostics.some((item) => item.message.includes('Unknown tool ids'))).toBe(true)
    expect(result.diagnostics.some((item) => item.message.includes('must also appear'))).toBe(true)
  })
})

describe('mode compatibility', () => {
  it('migrates legacy persisted ids and rejects malformed values', () => {
    expect(normalizeModeId('normal')).toBe('code')
    expect(normalizeModeId('goal')).toBe('code')
    expect(normalizeModeId('plan')).toBe('plan')
    expect(normalizeModeId('../escape')).toBe('code')
  })

  it('falls back to code when a saved custom mode disappears', () => {
    const registry = new ModeRegistry()
    expect(registry.resolve('deleted-mode').id).toBe('code')
  })
})
