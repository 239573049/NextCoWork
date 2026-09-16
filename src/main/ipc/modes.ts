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
    modes: modeRegistry().list(),
    diagnostics: modeRegistry().diagnostics(),
    tools: getTools().info().map((tool) => tool.internalId).sort()
  }
}
