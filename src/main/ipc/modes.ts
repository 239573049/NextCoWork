import type { ModeDefinition } from '../../shared/domain/mode'
import type { ModeDiagnostic } from '../kernel/mode/load'
import { modeRegistry } from '../kernel/mode/registry'
import { getTools, refreshModes } from '../runtime'

export interface ModeCatalog {
  modes: readonly ModeDefinition[]
  diagnostics: readonly ModeDiagnostic[]
  tools: readonly string[]
}

export async function listModes(req: { workspaceId: string }): Promise<ModeCatalog> {
  await refreshModes(req.workspaceId)
  return {
    modes: modeRegistry(req.workspaceId).list(),
    diagnostics: modeRegistry(req.workspaceId).diagnostics(),
    tools: getTools().info().map((tool) => tool.internalId).sort()
  }
}
