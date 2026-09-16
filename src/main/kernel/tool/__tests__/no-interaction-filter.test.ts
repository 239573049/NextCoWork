import { describe, expect, it } from 'vitest'
import { builtinTools } from '../builtin'
import { ToolRegistry } from '../registry'

function seeded(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of builtinTools()) registry.register(tool)
  return registry
}

const ids = (registry: ToolRegistry, noInteraction?: boolean): string[] =>
  registry.snapshot(noInteraction === undefined ? {} : { noInteraction }).map((tool) => tool.internalId)

describe('subagent interaction tool filter', () => {
  it('removes every tool that waits for the user', () => {
    const list = ids(seeded(), true)
    expect(list).not.toContain('AskUserQuestion')
    expect(list).not.toContain('ExitPlanMode')
  })

  it('removes exactly the interactive tools', () => {
    const registry = seeded()
    const removed = new Set(ids(registry))
    for (const id of ids(registry, true)) removed.delete(id)
    expect([...removed].sort()).toEqual(['AskUserQuestion', 'ExitPlanMode'])
  })

  it('keeps interactive tools for the main agent', () => {
    const list = ids(seeded())
    expect(list).toContain('AskUserQuestion')
    expect(list).toContain('ExitPlanMode')
  })

  it('does not remove non-interactive tools', () => {
    const list = ids(seeded(), true)
    for (const id of ['Read', 'Grep', 'Task']) expect(list).toContain(id)
  })

  it('composes with the network filter', () => {
    const list = seeded().snapshot({ noInteraction: true, network: true }).map((tool) => tool.internalId)
    expect(list).toContain('web_search')
    expect(list).not.toContain('AskUserQuestion')
  })
})
