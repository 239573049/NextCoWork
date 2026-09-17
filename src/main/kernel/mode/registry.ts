import type { ModeDefinition } from '../../../shared/domain/mode'
import { RegistryBuckets } from '../registry-buckets'
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

/**
 * **每个工作区一份。** 参数没有默认值的理由见 `skill/registry.ts` 的同名函数,
 * 分桶与淘汰规则见 `kernel/registry-buckets.ts`。
 *
 * ★ 新建的桶出厂就带内建那几个模式,`resolve()` 也永远兜底到 `CODE_MODE` ——
 * 于是「总能解析出一个模式」在第一次扫描发生之前就成立。
 */
const buckets = new RegistryBuckets(() => new ModeRegistry())

export function modeRegistry(workspaceId: string): ModeRegistry {
  return buckets.get(workspaceId)
}

/** 工作区被移除时调。 */
export function dropModeRegistry(workspaceId: string): void {
  buckets.drop(workspaceId)
}

/** 全部丢掉 —— 换账户时必须调,理由同 `resetSkillRegistries`。 */
export function resetModeRegistries(): void {
  buckets.clear()
}
