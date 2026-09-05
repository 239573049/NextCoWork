import { describe, expect, it } from 'vitest'
import type { ResolvedModelThinking } from '../model-runtime'
import { applyThinkingAdapter, removeUnsupportedThinking, ThinkingAdapterError } from '../thinking-adapter'

const effort: ResolvedModelThinking = {
  mode: 'effort',
  enabled: true,
  explicit: true,
  effort: 'xhigh',
}

describe('applyThinkingAdapter', () => {
  it('maps an Anthropic budget and removes incompatible fields', () => {
    expect(
      applyThinkingAdapter(
        { reasoning_effort: 'high' },
        {
          protocol: 'anthropic',
          upstreamModel: 'claude-sonnet-4',
          maxOutputTokens: 20_000,
          config: {
            mode: 'budget',
            defaultEnabled: true,
            parameterPath: 'thinking.budget_tokens',
          },
          reasoning: {
            mode: 'budget',
            enabled: true,
            explicit: true,
            budgetTokens: 8_000,
          },
        },
      ),
    ).toEqual({ thinking: { type: 'enabled', budget_tokens: 8_000 } })
  })

  it('maps OpenAI Responses effort and sends nested none for an explicit Off', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      parameterPath: 'reasoning_effort',
    } as const
    expect(
      applyThinkingAdapter(
        {
          reasoning_effort: 'high',
          reasoning: { effort: 'low' },
          thinking: { type: 'enabled' },
          temperature: 0.2,
        },
        {
          protocol: 'openai-responses',
          upstreamModel: 'gpt-6-astra',
          maxOutputTokens: 32_000,
          config,
          reasoning: effort,
        },
      ),
    ).toEqual({ temperature: 0.2, reasoning: { effort: 'xhigh' } })
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-responses',
          upstreamModel: 'gpt-5.6-sol',
          maxOutputTokens: 32_000,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ reasoning: { effort: 'none' } })
  })

  it('maps OpenAI Chat Completions effort to the flat field', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      parameterPath: 'reasoning_effort',
    } as const
    expect(
      applyThinkingAdapter(
        { reasoning: { effort: 'low' } },
        {
          protocol: 'openai-chat',
          upstreamModel: 'gpt-5.4',
          maxOutputTokens: 32_000,
          config,
          reasoning: effort,
        },
      ),
    ).toEqual({ reasoning_effort: 'xhigh' })
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'gpt-5.4',
          maxOutputTokens: 32_000,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ reasoning_effort: 'none' })
  })

  it('lets an explicit OpenAI preset override the provider protocol', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      parameterPath: 'reasoning_effort',
    } as const
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          preset: 'openai-responses',
          upstreamModel: 'gpt-model',
          maxOutputTokens: 32_000,
          config,
          reasoning: effort,
        },
      ),
    ).toEqual({ reasoning: { effort: 'xhigh' } })
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-responses',
          preset: 'openai-chat',
          upstreamModel: 'gpt-model',
          maxOutputTokens: 32_000,
          config,
          reasoning: effort,
        },
      ),
    ).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('maps DeepSeek and GLM toggles to their provider objects', () => {
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'deepseek-v3.2',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: false,
            parameterPath: 'thinking',
          },
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: true,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toEqual({ thinking: { type: 'enabled' } })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'glm-4.7',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: false,
            parameterPath: 'thinking.type',
          },
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('maps Hunyuan effort together with the official thinking toggle', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'high',
      parameterPath: 'reasoning_effort',
    } as const

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'hy4-preview',
          maxOutputTokens: 65_536,
          config,
          reasoning: {
            mode: 'effort',
            enabled: true,
            explicit: true,
            effort: 'low',
          },
          reasoningEfforts: ['none', 'low', 'high'],
        },
      ),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'tencent/hy3',
          maxOutputTokens: 131_072,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
          reasoningEfforts: ['none', 'low', 'high'],
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('maps DeepSeek V4 toggle and effort without sending unsupported budget_tokens', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'high',
      parameterPath: 'reasoning_effort',
    } as const

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'deepseek-v4-pro',
          maxOutputTokens: 384_000,
          config,
          reasoning: {
            mode: 'effort',
            enabled: true,
            explicit: true,
            effort: 'max',
          },
          reasoningEfforts: ['none', 'low', 'high', 'max'],
        },
      ),
    ).toEqual({
      reasoning_effort: 'max',
      thinking: { type: 'enabled' },
    })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'deepseek-v4-flash',
          maxOutputTokens: 384_000,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
          reasoningEfforts: ['none', 'low', 'high', 'max'],
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('keeps the GLM thinking switch and forwards its supported reasoning effort', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'max',
      parameterPath: 'reasoning_effort',
    } as const

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'glm-5.3-flash',
          maxOutputTokens: 128_000,
          config,
          reasoning: {
            mode: 'effort',
            enabled: true,
            explicit: true,
            effort: 'high',
          },
          reasoningEfforts: ['low', 'high', 'max'],
        },
      ),
    ).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })

    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'glm-5.3-flash',
          maxOutputTokens: 128_000,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
          reasoningEfforts: ['low', 'high', 'max'],
        },
      ),
    ).toThrow(/不支持关闭推理/u)
  })

  it('auto honours Qwen/Hunyuan-style declared paths instead of forcing OpenAI effort', () => {
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'qwen3-plus',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: false,
            parameterPath: 'enable_thinking',
          },
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: true,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toEqual({ enable_thinking: true })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'hunyuan-turbo',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: false,
            parameterPath: 'chat_template_kwargs.enable_thinking',
          },
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('supports declarative toggle values and effort mappings', () => {
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'MiniMax-M3',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: true,
            parameterPath: 'thinking',
            enabledValue: { type: 'adaptive' },
            disabledValue: { type: 'disabled' },
          },
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: false,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toEqual({ thinking: { type: 'adaptive' } })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'MiniMax-M3',
          maxOutputTokens: 16_000,
          config: {
            mode: 'toggle',
            defaultEnabled: true,
            parameterPath: 'thinking',
            enabledValue: { type: 'adaptive' },
            disabledValue: { type: 'disabled' },
          },
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-responses',
          upstreamModel: 'vendor-reasoner',
          maxOutputTokens: 16_000,
          config: {
            mode: 'effort',
            defaultEnabled: true,
            parameterPath: 'reasoning_effort',
            effortMap: { xhigh: 'extra_high' },
          },
          reasoning: effort,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      ),
    ).toEqual({ reasoning: { effort: 'extra_high' } })
  })

  it('maps MiMo nested toggle values from its catalogue declaration', () => {
    const config = {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    } as const
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'mimo-v2.5-pro',
          maxOutputTokens: 16_000,
          config,
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: false,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toEqual({ thinking: { type: 'enabled' } })
    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'mimo-v2.5-pro',
          maxOutputTokens: 16_000,
          config,
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('maps the official LongCat Think toggle to thinking.type without an effort or budget', () => {
    const config = {
      mode: 'toggle',
      defaultEnabled: false,
      parameterPath: 'thinking.type',
    } as const

    expect(
      applyThinkingAdapter(
        { reasoning_effort: 'high', thinking_budget: 8_192 },
        {
          protocol: 'openai-chat',
          upstreamModel: 'LongCat-2.0',
          maxOutputTokens: 131_072,
          config,
          reasoning: { mode: 'toggle', enabled: true, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'enabled' } })
    expect(
      applyThinkingAdapter(
        { thinking: { type: 'enabled' } },
        {
          protocol: 'openai-chat',
          upstreamModel: 'longcat-2.0',
          maxOutputTokens: 131_072,
          config,
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('maps the official openPangu Think toggle to thinking.type', () => {
    const config = {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
    } as const

    expect(
      applyThinkingAdapter(
        { reasoning_effort: 'high', thinking_budget: 8_192 },
        {
          protocol: 'openai-chat',
          upstreamModel: 'openpangu-2.0-pro',
          maxOutputTokens: 128_000,
          config,
          reasoning: { mode: 'toggle', enabled: true, explicit: false },
        },
      ),
    ).toEqual({ thinking: { type: 'enabled' } })

    expect(
      applyThinkingAdapter(
        { thinking: { type: 'enabled' } },
        {
          protocol: 'openai-chat',
          upstreamModel: 'openpangu-2.0-flash',
          maxOutputTokens: 128_000,
          config,
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('maps the official InternLM boolean thinking_mode switch both ways', () => {
    const config = {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    } as const

    expect(
      applyThinkingAdapter(
        { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        {
          protocol: 'openai-chat',
          upstreamModel: 'intern-s2-preview-397b',
          maxOutputTokens: 16_384,
          config,
          reasoning: { mode: 'toggle', enabled: true, explicit: false },
        },
      ),
    ).toEqual({ thinking_mode: true })
    expect(
      applyThinkingAdapter(
        { thinking_mode: true },
        {
          protocol: 'openai-chat',
          upstreamModel: 'intern-s1-mini',
          maxOutputTokens: 16_384,
          config,
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking_mode: false })
  })

  it('maps the SenseNova V6.5 nested thinking.enabled boolean switch', () => {
    const config = {
      mode: 'toggle',
      defaultEnabled: false,
      parameterPath: 'thinking.enabled',
    } as const

    expect(
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'SenseNova-V6-5-Pro',
          maxOutputTokens: 16_384,
          config,
          reasoning: { mode: 'toggle', enabled: true, explicit: true },
        },
      ),
    ).toEqual({ thinking: { enabled: true } })
    expect(
      applyThinkingAdapter(
        { thinking: { enabled: true } },
        {
          protocol: 'openai-chat',
          upstreamModel: 'SenseNova-V6-5-Turbo',
          maxOutputTokens: 16_384,
          config,
          reasoning: { mode: 'toggle', enabled: false, explicit: true },
        },
      ),
    ).toEqual({ thinking: { enabled: false } })
  })

  it('blocks unsupported effort and an Off choice when none is unavailable', () => {
    const config = {
      mode: 'effort',
      defaultEnabled: true,
      parameterPath: 'reasoning_effort',
    } as const
    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-responses',
          upstreamModel: 'gpt-model',
          maxOutputTokens: 16_000,
          config,
          reasoning: effort,
          reasoningEfforts: ['low', 'medium', 'high'],
        },
      ),
    ).toThrow(/不支持推理强度/u)
    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-responses',
          upstreamModel: 'gpt-model',
          maxOutputTokens: 16_000,
          config,
          reasoning: { mode: 'effort', enabled: false, explicit: true },
          reasoningEfforts: ['low', 'medium', 'high'],
        },
      ),
    ).toThrow(/不支持关闭推理/u)
  })

  it('strips stale or patched fields for unsupported models', () => {
    expect(
      applyThinkingAdapter(
        {
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          thinking_mode: true,
          temperature: 0.2,
        },
        {
          protocol: 'openai-chat',
          upstreamModel: 'plain-model',
          maxOutputTokens: 8_000,
          config: { mode: 'unsupported', defaultEnabled: false },
          reasoning: undefined,
        },
      ),
    ).toEqual({ temperature: 0.2 })
  })

  it.each(['unsupported', 'always'] as const)('prevents JSON Patch from restoring Think fields for %s models', (mode) => {
    expect(
      removeUnsupportedThinking(
        {
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          extra_body: {
            enable_thinking: true,
            thinking_budget: 4_096,
            thinking_mode: true,
            keep: 'value',
          },
          temperature: 0.2,
        },
        { mode, defaultEnabled: mode === 'always' },
      ),
    ).toEqual({ extra_body: { keep: 'value' }, temperature: 0.2 })
  })

  it('requires a whitelisted path for custom adapters', () => {
    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'vendor-model',
          maxOutputTokens: 8_000,
          preset: 'custom',
          config: {
            mode: 'toggle',
            defaultEnabled: true,
            parameterPath: 'dangerous.field',
          },
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: false,
            budgetTokens: 2_000,
          },
        },
      ),
    ).toThrow(ThinkingAdapterError)
  })

  it.each(['enable_thinking', 'chat_template_kwargs.enable_thinking', 'thinking_mode', 'thinking.enabled', 'reasoning_split'])('rejects budget mode on non-budget path %s', (parameterPath) => {
    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'vendor-model',
          maxOutputTokens: 16_000,
          config: { mode: 'budget', defaultEnabled: true, parameterPath },
          reasoning: {
            mode: 'budget',
            enabled: true,
            explicit: true,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toThrow(/Token budget 不能写入开关参数/u)
  })

  it.each(['thinking_budget', 'thinking.budget_tokens'])('rejects toggle mode on budget path %s', (parameterPath) => {
    expect(() =>
      applyThinkingAdapter(
        {},
        {
          protocol: 'openai-chat',
          upstreamModel: 'vendor-model',
          maxOutputTokens: 16_000,
          config: { mode: 'toggle', defaultEnabled: true, parameterPath },
          reasoning: {
            mode: 'toggle',
            enabled: true,
            explicit: true,
            budgetTokens: 4_096,
          },
        },
      ),
    ).toThrow(/开关不能写入 Token budget/u)
  })
})
