import type { ModeDefinition } from '../../../shared/domain/mode'
import { BUILTIN_MODES, CODE_MODE } from './builtin'
import type { ModeDiagnostic, ModeScanResult } from './load'

export class ModeRegistry {
  private modes: readonly ModeDefinition[] = sortModes(BUILTIN_MODES)
  private diagnosticsValue: readonly ModeDiagnostic[] = []

  replaceAll(result: ModeScanResult): void {
    this.modes = sortModes(result.modes)
    this.diagnosticsValue = result.diagnostics
  }

  list(): readonly ModeDefinition[] {
    return this.modes
  }

  resolve(id: string): ModeDefinition {
    return this.modes.find((mode) => mode.id === id) ?? CODE_MODE
  }

  diagnostics(): readonly ModeDiagnostic[] {
    return this.diagnosticsValue
  }
}

export function modePromptFor(mode: ModeDefinition): string {
  if (mode.requiredTools === undefined || mode.requiredTools.length === 0) return mode.prompt
  return `${mode.prompt}\n\n# Required workflow tools\n\nYou must use these tools as required by this mode's workflow: ${mode.requiredTools.join(', ')}.`
}

function sortModes(modes: readonly ModeDefinition[]): readonly ModeDefinition[] {
  const order = new Map(BUILTIN_MODES.map((mode, index) => [mode.id, index]))
  return [...modes].sort((a, b) => {
    const aOrder = order.get(a.id)
    const bOrder = order.get(b.id)
    if (aOrder !== undefined || bOrder !== undefined) {
      return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER)
    }
    return a.name.localeCompare(b.name)
  })
}

let singleton: ModeRegistry | undefined

export function modeRegistry(): ModeRegistry {
  singleton ??= new ModeRegistry()
  return singleton
}
