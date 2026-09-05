import { THINKING_BUDGET } from '../agent/run-request'
import type { ResolvedModelThinking } from './model-runtime'
import type { ReasoningEffort, RequestAdapterConfig, ThinkingConfig, UpstreamProtocol } from './provider'

export class ThinkingAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThinkingAdapterError'
  }
}

export interface ThinkingAdapterInput {
  protocol: UpstreamProtocol
  upstreamModel: string
  config: ThinkingConfig | undefined
  reasoning: ResolvedModelThinking | undefined
  maxOutputTokens: number
  preset?: RequestAdapterConfig['preset']
  reasoningEfforts?: readonly ReasoningEffort[]
}

type AdapterKind = 'anthropic' | 'openai-chat' | 'openai-responses' | 'deepseek' | 'glm' | 'hunyuan' | 'custom'

const THINKING_ROOTS = [
  'thinking',
  'reasoning',
  'reasoning_effort',
  'enable_thinking',
  'thinking_budget',
  'thinking_mode',
  'reasoning_split',
  'chat_template_kwargs',
  'thinkingConfig',
] as const

const CUSTOM_PATHS = new Set([
  'thinking',
  'thinking.enabled',
  'thinking.type',
  'thinking.budget_tokens',
  'thinkingConfig.thinkingLevel',
  'chat_template_kwargs.enable_thinking',
  'chat_template_kwargs.reasoning_effort',
  'reasoning',
  'reasoning.effort',
  'reasoning_effort',
  'reasoning_split',
  'enable_thinking',
  'thinking_budget',
  'thinking_mode',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ThinkingAdapterError('Think 适配要求请求体是 JSON 对象。')
  return structuredClone(body)
}

function stripThinking(body: Record<string, unknown>): void {
  for (const key of THINKING_ROOTS) delete body[key]
}

function kindFor(input: ThinkingAdapterInput): AdapterKind {
  switch (input.preset) {
    case 'anthropic':
      return 'anthropic'
    case 'openai-chat':
      return 'openai-chat'
    case 'openai-responses':
      return 'openai-responses'
    case 'custom':
      return 'custom'
    default:
      break
  }
  if (input.protocol === 'anthropic') return 'anthropic'
  if (/(?:^|\/)(?:deepseek|deep-seek)[/:._-]/iu.test(input.upstreamModel)) return 'deepseek'
  if (/(?:^|\/)(?:glm|chatglm)[/:._-]/iu.test(input.upstreamModel)) return 'glm'
  if (/(?:^|\/)(?:hy4-preview|hy3(?:-preview)?)(?:$|[/:._-])/iu.test(input.upstreamModel)) {
    return 'hunyuan'
  }
  if (
    input.config?.parameterPath !== undefined &&
    !['reasoning_effort', 'reasoning.effort'].includes(input.config.parameterPath)
  )
    return 'custom'
  return input.protocol
}

function budgetForEffort(
  effort: NonNullable<ResolvedModelThinking['effort']> | undefined,
  maxOutputTokens: number,
): number {
  const requested =
    effort === undefined
      ? THINKING_BUDGET.medium
      : effort === 'none'
        ? 0
        : effort === 'xhigh'
          ? THINKING_BUDGET.higher
          : THINKING_BUDGET[effort]
  const ceiling = Math.max(1024, Math.floor(maxOutputTokens) - 1024)
  return Math.min(requested, ceiling)
}

function effortForBudget(tokens: number | undefined): NonNullable<ResolvedModelThinking['effort']> {
  if (tokens === undefined || tokens <= THINKING_BUDGET.minimal) return 'minimal'
  if (tokens <= THINKING_BUDGET.low) return 'low'
  if (tokens <= THINKING_BUDGET.medium) return 'medium'
  if (tokens <= THINKING_BUDGET.high) return 'high'
  return 'max'
}

function customValue(config: ThinkingConfig, reasoning: ResolvedModelThinking, path: string): unknown {
  if (config.mode === 'effort') {
    if (!reasoning.enabled) return config.disabledValue ?? config.effortMap?.none
    if (reasoning.effort === undefined) {
      throw new ThinkingAdapterError(`Think effort 适配缺少推理强度: ${path}`)
    }
    return config.effortMap?.[reasoning.effort] ?? reasoning.effort
  }
  if (config.mode === 'budget') {
    const leaf = path.split('.').at(-1)
    if (
      leaf === 'enable_thinking' ||
      leaf === 'thinking_mode' ||
      path === 'thinking.enabled' ||
      path === 'reasoning_split'
    ) {
      throw new ThinkingAdapterError(`Token budget 不能写入开关参数: ${path}`)
    }
    if (!reasoning.enabled) return undefined
    if (reasoning.budgetTokens === undefined) {
      throw new ThinkingAdapterError(`Think budget 适配缺少 Token 预算: ${path}`)
    }
    return reasoning.budgetTokens
  }
  if (config.mode === 'toggle' && (path === 'thinking_budget' || path.endsWith('.budget_tokens'))) {
    throw new ThinkingAdapterError(`Think 开关不能写入 Token budget 参数: ${path}`)
  }
  if (reasoning.enabled && config.enabledValue !== undefined) return config.enabledValue
  if (!reasoning.enabled && config.disabledValue !== undefined) return config.disabledValue
  if (path.endsWith('.type')) return reasoning.enabled ? 'enabled' : 'disabled'
  if (path === 'thinking') return { type: reasoning.enabled ? 'enabled' : 'disabled' }
  return reasoning.enabled
}

function setDotted(body: Record<string, unknown>, path: string, value: unknown): void {
  if (!CUSTOM_PATHS.has(path)) {
    throw new ThinkingAdapterError(`Think 参数路径不在允许的白名单中: ${path}`)
  }
  const parts = path.split('.')
  let cursor = body
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part]
    if (current === undefined) {
      if (value === undefined) return
      const next: Record<string, unknown> = {}
      cursor[part] = next
      cursor = next
      continue
    }
    if (!isRecord(current)) {
      throw new ThinkingAdapterError(`Think 参数父路径不是对象: ${path}`)
    }
    cursor = current
  }
  const leaf = parts.at(-1)
  if (leaf === undefined) throw new ThinkingAdapterError('Think 参数路径不能为空。')
  if (value === undefined) delete cursor[leaf]
  else cursor[leaf] = value
}

/**
 * Convert provider-neutral reasoning into a concrete request-body shape.
 * Unsupported declarations remove every known Think field, even when a
 * legacy encoder or stale request supplied one.
 */
export function applyThinkingAdapter(body: unknown, input: ThinkingAdapterInput): unknown {
  if (input.config === undefined) return body
  const next = cloneBody(body)

  if (input.config.mode === 'unsupported') {
    stripThinking(next)
    return next
  }

  const reasoning = input.reasoning
  if (input.config.mode === 'always') {
    // The model id itself selects a reasoning-only model. Sending a vendor
    // switch is both redundant and rejected by several reasoning-only APIs.
    stripThinking(next)
    return next
  }
  if (reasoning === undefined) {
    throw new ThinkingAdapterError('模型声明支持 Think，但请求缺少已解析的 Think 配置。')
  }

  const kind = kindFor(input)
  if (
    reasoning.enabled &&
    reasoning.effort !== undefined &&
    input.reasoningEfforts !== undefined &&
    !input.reasoningEfforts.includes(reasoning.effort)
  ) {
    throw new ThinkingAdapterError(`模型不支持推理强度「${reasoning.effort}」。`)
  }
  if (
    !reasoning.enabled &&
    reasoning.explicit &&
    input.config.mode === 'effort' &&
    input.reasoningEfforts !== undefined &&
    !input.reasoningEfforts.includes('none')
  ) {
    throw new ThinkingAdapterError('该模型不支持关闭推理，不能把 Off 静默还原成默认强度。')
  }
  if (kind === 'anthropic') {
    delete next['reasoning']
    delete next['reasoning_effort']
    delete next['enable_thinking']
    delete next['thinking_budget']
    if (!reasoning.enabled) {
      // Compatible relays may default to thinking even when Anthropic itself
      // does not. Omitting the field does not express the user's Off choice.
      next['thinking'] = { type: 'disabled' }
      return next
    }
    const budget = reasoning.budgetTokens ?? budgetForEffort(reasoning.effort, input.maxOutputTokens)
    next['thinking'] = { type: 'enabled', budget_tokens: budget }
    return next
  }

  if (kind === 'openai-chat' || kind === 'openai-responses') {
    delete next['thinking']
    delete next['enable_thinking']
    delete next['thinking_budget']
    delete next['reasoning']
    delete next['reasoning_effort']
    if (!reasoning.enabled) {
      // Omitting effort lets current OpenAI reasoning models fall back to
      // their default (commonly medium), which violates an explicit Off.
      if (reasoning.explicit) {
        if (input.reasoningEfforts !== undefined && !input.reasoningEfforts.includes('none')) {
          throw new ThinkingAdapterError('该模型不支持关闭推理，不能把 Off 静默还原成默认强度。')
        }
        const off = input.config.effortMap?.none ?? 'none'
        if (kind === 'openai-responses') next['reasoning'] = { effort: off }
        else next['reasoning_effort'] = off
      }
      return next
    }
    const effort = reasoning.effort ?? effortForBudget(reasoning.budgetTokens)
    const mappedEffort = input.config.effortMap?.[effort] ?? effort
    if (kind === 'openai-responses') next['reasoning'] = { effort: mappedEffort }
    else next['reasoning_effort'] = mappedEffort
    return next
  }

  if (kind === 'deepseek') {
    delete next['reasoning']
    delete next['reasoning_effort']
    delete next['enable_thinking']
    delete next['thinking_budget']
    const thinking: Record<string, unknown> = {
      type: reasoning.enabled ? 'enabled' : 'disabled',
    }
    // DeepSeek's current OpenAI-compatible API uses a separate flat effort
    // field. It does not document `thinking.budget_tokens` as a request input.
    if (reasoning.enabled && input.config.mode === 'effort') {
      const effort = reasoning.effort ?? effortForBudget(reasoning.budgetTokens)
      next['reasoning_effort'] = input.config.effortMap?.[effort] ?? effort
    }
    next['thinking'] = thinking
    return next
  }

  if (kind === 'glm' || kind === 'hunyuan') {
    delete next['reasoning']
    delete next['reasoning_effort']
    delete next['enable_thinking']
    delete next['thinking_budget']
    next['thinking'] = { type: reasoning.enabled ? 'enabled' : 'disabled' }
    if (reasoning.enabled && input.config.mode === 'effort') {
      const effort = reasoning.effort ?? effortForBudget(reasoning.budgetTokens)
      next['reasoning_effort'] = input.config.effortMap?.[effort] ?? effort
    }
    return next
  }

  const path = input.config.parameterPath?.trim()
  if (path === undefined || path === '') {
    throw new ThinkingAdapterError('自定义 Think 适配必须配置参数路径。')
  }
  stripThinking(next)
  setDotted(next, path, customValue(input.config, reasoning, path))
  return next
}

/**
 * Final guard used after JSON Patch for models that must not receive a wire
 * switch. `always` models select reasoning through the model id itself, while
 * `unsupported` models reject every Think parameter. Also sanitize the common
 * `extra_body` passthrough container so a broad container patch cannot restore
 * a field removed at the top level.
 */
export function removeUnsupportedThinking(body: unknown, config: ThinkingConfig | undefined): unknown {
  if (config?.mode !== 'unsupported' && config?.mode !== 'always') return body
  const next = cloneBody(body)
  stripThinking(next)
  const extraBody = next['extra_body']
  if (isRecord(extraBody)) stripThinking(extraBody)
  return next
}

/** An explicit conversation Off takes precedence over saved model patches. */
export function enforceThinkingPreference(body: unknown, input: ThinkingAdapterInput): unknown {
  const guarded = removeUnsupportedThinking(body, input.config)
  if (input.config === undefined || input.config.mode === 'unsupported' || input.config.mode === 'always'
    || input.reasoning?.explicit !== true || input.reasoning.enabled) return guarded
  const next = cloneBody(guarded)
  stripThinking(next)
  if (isRecord(next['extra_body'])) stripThinking(next['extra_body'])
  return applyThinkingAdapter(next, input)
}
