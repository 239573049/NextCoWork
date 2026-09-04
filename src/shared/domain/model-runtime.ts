import type { AgentMessage } from '../agent/message'
import {
  THINKING_BUDGET,
  type ThinkingLevel
} from '../agent/run-request'
import type { ModelAlias, ModelCapabilities, ThinkingConfig } from './provider'

export type ModelReasoningEffort = NonNullable<ThinkingConfig['defaultEffort']>

/**
 * Provider-neutral result of applying the conversation-level thinking choice
 * to one model's declaration.  Wire adapters consume this object; they never
 * need to guess what `auto`, `higher`, or a token budget means.
 */
export interface ResolvedModelThinking {
  mode: Exclude<ThinkingConfig['mode'], 'unsupported'>
  enabled: boolean
  /** True when the user explicitly chose `off` or a non-auto strength. */
  explicit: boolean
  effort?: ModelReasoningEffort
  budgetTokens?: number
}

const MIN_THINKING_BUDGET = 1024
const MIN_OUTPUT_HEADROOM = 1024

function effortFor(level: ThinkingLevel, fallback: ModelReasoningEffort): ModelReasoningEffort {
  switch (level) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return level
    case 'higher':
      // The persisted model schema intentionally has five portable levels.
      // `higher` is a UI-only notch, so map it to the nearest portable value.
      return 'high'
    default:
      return fallback
  }
}

function budgetFor(level: ThinkingLevel, fallback: number): number {
  if (level === 'auto') return fallback
  if (level === 'off') return 0
  return THINKING_BUDGET[level]
}

function clampBudget(wanted: number, maxOutputTokens: number): number | undefined {
  const ceiling = Math.floor(maxOutputTokens) - MIN_OUTPUT_HEADROOM
  if (ceiling < MIN_THINKING_BUDGET) return undefined
  return Math.max(MIN_THINKING_BUDGET, Math.min(Math.floor(wanted), ceiling))
}

/**
 * Resolve model defaults and a per-run choice without leaking provider field
 * names into the AgentSession. Unsupported models deliberately return
 * `undefined`, which guarantees that no reasoning field is emitted later.
 */
export function resolveModelThinking(
  level: ThinkingLevel,
  config: ThinkingConfig | undefined,
  maxOutputTokens: number
): ResolvedModelThinking | undefined {
  if (config === undefined || config.mode === 'unsupported') return undefined

  const explicit = level !== 'auto'
  const enabled = config.mode === 'always'
    ? true
    : level === 'off'
      ? false
      : level === 'auto'
        ? config.defaultEnabled
        : true

  const base: ResolvedModelThinking = { mode: config.mode, enabled, explicit }
  if (!enabled || config.mode === 'always') return base

  if (config.mode === 'effort') {
    return {
      ...base,
      effort: effortFor(level, config.defaultEffort ?? 'medium')
    }
  }

  // Budget is also useful to adapters such as Anthropic when a catalogue row
  // describes a simple toggle rather than exposing a budget in the UI.
  if (config.mode === 'budget' || config.mode === 'toggle') {
    const wanted = budgetFor(
      level,
      config.defaultBudgetTokens ?? THINKING_BUDGET.medium
    )
    const budgetTokens = clampBudget(wanted, maxOutputTokens)
    return budgetTokens === undefined ? { ...base, enabled: false } : { ...base, budgetTokens }
  }

  return base
}

export type ModelRuntimeIssueCode =
  | 'invalid_context_window'
  | 'invalid_max_output_tokens'
  | 'context_length'
  | 'text_input_unsupported'
  | 'vision_input_unsupported'
  | 'file_input_unsupported'
  | 'video_input_unsupported'
  | 'audio_input_unsupported'
  | 'tools_unsupported'
  | 'web_search_unsupported'

export interface ModelRuntimeIssue {
  code: ModelRuntimeIssueCode
  message: string
}

export interface ModelRuntimeValidationInput {
  alias: Pick<ModelAlias, 'alias' | 'capabilities' | 'contextWindow' | 'maxOutputTokens'>
  messages: readonly AgentMessage[]
  /** A tool call/result already present in history requires tool-capable input. */
  includeAdvertisedTools?: boolean
  /** The conversation asked for either built-in search or the app search tool. */
  webSearchRequested?: boolean
  /** Estimated prompt tokens after system/reminder decoration. */
  estimatedInputTokens?: number
}

function supports(capabilities: ModelCapabilities, key: keyof ModelCapabilities): boolean {
  if (key === 'textInput') return capabilities.textInput !== false
  if (key === 'textOutput') return capabilities.textOutput !== false
  if (key === 'vision') return capabilities.visionInput ?? capabilities.vision
  return capabilities[key] === true
}

function partKinds(messages: readonly AgentMessage[]): Set<string> {
  const kinds = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      const type = (part as { type?: unknown }).type
      if (typeof type === 'string') kinds.add(type)
    }
  }
  return kinds
}

/**
 * Validate the model declaration against the real canonical request.  The
 * function returns all deterministic issues so callers can show the most
 * useful one while tests and management UIs can inspect the full result.
 */
export function validateModelRuntime(input: ModelRuntimeValidationInput): ModelRuntimeIssue[] {
  const { alias, messages } = input
  const issues: ModelRuntimeIssue[] = []
  const kinds = partKinds(messages)

  if (!Number.isInteger(alias.contextWindow) || alias.contextWindow <= 0) {
    issues.push({
      code: 'invalid_context_window',
      message: `模型「${alias.alias}」的上下文窗口必须是正整数。`
    })
  }
  if (
    !Number.isInteger(alias.maxOutputTokens) ||
    alias.maxOutputTokens <= 0 ||
    (Number.isInteger(alias.contextWindow) && alias.maxOutputTokens > alias.contextWindow)
  ) {
    issues.push({
      code: 'invalid_max_output_tokens',
      message: `模型「${alias.alias}」的最大输出 Token 配置无效。`
    })
  }

  if (kinds.has('text') && !supports(alias.capabilities, 'textInput')) {
    issues.push({ code: 'text_input_unsupported', message: `模型「${alias.alias}」不支持文本输入。` })
  }
  if (kinds.has('image') && !supports(alias.capabilities, 'vision')) {
    issues.push({ code: 'vision_input_unsupported', message: `模型「${alias.alias}」不支持图片 / Vision 输入。` })
  }
  // These part kinds are intentionally recognized before they join the public
  // ContentPart union, so the runtime boundary is ready for file/media pipes
  // without silently accepting a hand-written/imported payload meanwhile.
  if (kinds.has('file') && !supports(alias.capabilities, 'fileInput')) {
    issues.push({ code: 'file_input_unsupported', message: `模型「${alias.alias}」不支持文件输入。` })
  }
  if (kinds.has('video') && !supports(alias.capabilities, 'videoInput')) {
    issues.push({ code: 'video_input_unsupported', message: `模型「${alias.alias}」不支持视频输入。` })
  }
  if (kinds.has('audio') && !supports(alias.capabilities, 'audioInput')) {
    issues.push({ code: 'audio_input_unsupported', message: `模型「${alias.alias}」不支持音频输入。` })
  }

  const historyUsesTools = kinds.has('tool_call') || kinds.has('tool_result')
  if ((historyUsesTools || input.includeAdvertisedTools === true) && !alias.capabilities.tools) {
    issues.push({ code: 'tools_unsupported', message: `模型「${alias.alias}」不支持工具调用。` })
  }
  if (
    input.webSearchRequested === true &&
    alias.capabilities.webSearch !== true &&
    alias.capabilities.tools !== true
  ) {
    issues.push({
      code: 'web_search_unsupported',
      message: `模型「${alias.alias}」既不支持内置 Web Search，也不支持通过工具搜索。`
    })
  }

  if (
    typeof input.estimatedInputTokens === 'number' &&
    Number.isFinite(input.estimatedInputTokens) &&
    input.estimatedInputTokens + alias.maxOutputTokens > alias.contextWindow
  ) {
    issues.push({
      code: 'context_length',
      message:
        `模型「${alias.alias}」的请求预计需要 ${String(Math.ceil(input.estimatedInputTokens))} 个输入 Token` +
        `，再加 ${String(alias.maxOutputTokens)} 个最大输出 Token，超过 ${String(alias.contextWindow)} 的上下文窗口。`
    })
  }

  return issues
}

/** Old aliases predate the detailed capability matrix. */
export function modelSupportsTools(alias: Pick<ModelAlias, 'capabilities'> | undefined): boolean {
  return alias?.capabilities.tools !== false
}
