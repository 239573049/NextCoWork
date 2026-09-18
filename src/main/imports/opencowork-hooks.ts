import { createHash } from 'node:crypto'
import type { ImportDiagnostic } from '../../shared/domain/import'
import {
  defaultTimeoutMs,
  HOOK_MAX_TIMEOUT_MS,
  HOOK_COMMAND_MAX,
  TOOL_SCOPED_HOOK_EVENTS,
  type HookDefinition,
  type HookEvent
} from '../../shared/domain/hook'

/**
 * `~/.open-cowork/hooks.json` 摊平后的一条 handler。
 *
 * ★ 顶层键已经是 PascalCase 事件名(`UserPromptSubmit` 等),和本项目
 * `HookEvent` 直接同名可交集映射 —— 不用像 Codex 那样做大小写/命名转换。
 * handler 上的 `env` 本项目 `CommandHook` 没有承接位置,非空时整条标
 * `hook.unsupported-handler`,不静默丢弃也不内联拼进 command。
 */
export interface OpencoworkHookEntry {
  event: string
  matcher?: string
  command?: string
  handlerType: string
  /** 秒,与源文件一致。 */
  timeout?: number
  statusMessage?: string
  hasEnv: boolean
  sourcePath: string
  sourceKey: string
}

const SUPPORTED_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']

export function mapOpencoworkHook(sourceId: string, entry: OpencoworkHookEntry): { hook?: HookDefinition; diagnostics: ImportDiagnostic[] } {
  const diagnostics: ImportDiagnostic[] = []
  if (!SUPPORTED_EVENTS.includes(entry.event)) diagnostics.push({ code: 'hook.unsupported-event', detail: entry.event })
  if (entry.handlerType !== 'command' || !entry.command || entry.command.length > HOOK_COMMAND_MAX) diagnostics.push({ code: 'hook.unsupported-handler', detail: entry.handlerType })
  if (entry.hasEnv) diagnostics.push({ code: 'hook.unsupported-handler', detail: 'env' })
  const matcher = entry.matcher && /^[A-Za-z0-9_.-]+$/.test(entry.matcher) ? entry.matcher : undefined
  if (entry.matcher && (!matcher || !TOOL_SCOPED_HOOK_EVENTS.includes(entry.event as HookEvent))) {
    diagnostics.push({ code: 'hook.matcher-needs-review', detail: entry.matcher })
  }
  const timeoutMs = entry.timeout === undefined ? defaultTimeoutMs(entry.event as HookEvent) : entry.timeout * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOOK_MAX_TIMEOUT_MS) diagnostics.push({ code: 'hook.unsupported-handler', detail: 'timeout' })
  const blocked = diagnostics.some((d) => ['hook.unsupported-event', 'hook.unsupported-handler', 'hook.matcher-needs-review'].includes(d.code))
  if (blocked) return { diagnostics }
  const id = `opencowork-${createHash('sha256').update(JSON.stringify([sourceId, entry.sourceKey])).digest('hex').slice(0, 24)}`
  return {
    hook: {
      id, type: 'command', event: entry.event as HookEvent, command: entry.command as string, enabled: false, timeoutMs,
      ...(matcher ? { matcher } : {}), ...(entry.statusMessage ? { description: entry.statusMessage } : {})
    },
    diagnostics
  }
}
