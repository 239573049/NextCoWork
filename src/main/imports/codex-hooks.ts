import { createHash } from 'node:crypto'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { defaultTimeoutMs, HOOK_MAX_TIMEOUT_MS, HOOK_COMMAND_MAX, type HookDefinition, type HookEvent } from '../../shared/domain/hook'

export interface CodexHookEntry {
  event: string
  matcher?: string
  command?: string
  handlerType: string
  timeout?: number
  statusMessage?: string
  async?: boolean
  sourcePath: string
  scope: 'global' | 'project'
  projectKey?: string
  sourceKey: string
}

export function mapCodexHook(sourceId: string, entry: CodexHookEntry): { hook?: HookDefinition; diagnostics: ImportDiagnostic[] } {
  const diagnostics: ImportDiagnostic[] = []
  diagnostics.push({ code: 'hook.protocol-needs-review' })
  const supported = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']
  if (!supported.includes(entry.event)) diagnostics.push({ code: 'hook.unsupported-event', detail: entry.event })
  if (entry.handlerType !== 'command' || !entry.command || entry.command.length > HOOK_COMMAND_MAX) diagnostics.push({ code: 'hook.unsupported-handler', detail: entry.handlerType })
  const matcher = entry.matcher?.replace(/^\^([A-Za-z0-9_.-]+)\$$/, '$1')
  if (matcher && (!['PreToolUse', 'PostToolUse'].includes(entry.event) || !/^[A-Za-z0-9_.-]+$/.test(matcher))) diagnostics.push({ code: 'hook.matcher-needs-review', detail: matcher })
  const timeoutMs = entry.timeout === undefined ? defaultTimeoutMs(entry.event as HookEvent) : entry.timeout * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOOK_MAX_TIMEOUT_MS) diagnostics.push({ code: 'hook.unsupported-handler', detail: 'timeout' })
  if (entry.async) diagnostics.push({ code: 'hook.async-semantics-changed' })
  if (/\$\{?(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT)/.test(entry.command ?? '')) diagnostics.push({ code: 'hook.plugin-skipped' })
  const blocked = diagnostics.some((d) => ['hook.unsupported-event', 'hook.unsupported-handler', 'hook.plugin-skipped', 'hook.matcher-needs-review'].includes(d.code)) || (entry.async && !['Stop', 'SubagentStop'].includes(entry.event))
  if (blocked) return { diagnostics }
  const id = `codex-${createHash('sha256').update(JSON.stringify([sourceId, entry.sourceKey])).digest('hex').slice(0, 24)}`
  return { hook: { id, event: entry.event as HookEvent, command: entry.command as string, enabled: false, timeoutMs, ...(matcher ? { matcher } : {}), ...(entry.statusMessage ? { description: entry.statusMessage } : {}) }, diagnostics }
}
