export const BUILTIN_MODE_IDS = ['code', 'plan', 'acp'] as const

export type BuiltinModeId = (typeof BUILTIN_MODE_IDS)[number]
export type ModeId = string
export type ModeSourceKind = 'builtin' | 'global' | 'project'

export interface ModeDefinition {
  /** Stable id stored on sessions and used by the composer. */
  id: ModeId
  /** User-authored display name. Built-ins are localized by id in the renderer. */
  name: string
  /** User-authored summary. Built-ins are localized by id in the renderer. */
  description: string
  /** Appended to the common system prompt. */
  prompt: string
  /** Omitted means inherit every tool allowed by the run. */
  tools?: string[]
  /** Tools the workflow promises to call; the prompt decides at which stage. */
  requiredTools?: string[]
  source: { kind: ModeSourceKind; path: string }
}

export interface ModeListItem {
  id: ModeId
  name: string
  description: string
  scope: ModeSourceKind
  source: string
  tools?: string[]
  requiredTools?: string[]
}

export const MODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MODE_NAME_MAX = 80
export const MODE_DESCRIPTION_MAX = 512
export const MODE_PROMPT_MAX = 16 * 1024

export function isBuiltinModeId(value: string): value is BuiltinModeId {
  return (BUILTIN_MODE_IDS as readonly string[]).includes(value)
}

/** Read old persisted values without preserving the old modes themselves. */
export function normalizeModeId(value: unknown): ModeId {
  if (typeof value !== 'string') return 'code'
  const id = value.trim().toLowerCase()
  if (id === 'normal' || id === 'goal') return 'code'
  if (MODE_ID_RE.test(id)) return id
  return 'code'
}
