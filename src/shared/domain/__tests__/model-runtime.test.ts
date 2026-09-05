import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../agent/message'
import type { ModelAlias, ThinkingConfig } from '../provider'
import { modelThinkingLevels, normalizeModelThinkingLevel, resolveModelThinking, validateModelRuntime } from '../model-runtime'

const message = (types: string[]): AgentMessage => ({
  id: 'm1',
  role: 'user',
  parts: types.map((type) => (
    type === 'text'
      ? { type: 'text', text: 'hello' }
      : type === 'image'
        ? { type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/themes/a.png' }
        : { type }
  )) as AgentMessage['parts'],
  createdAt: 1,
  schemaVersion: 1
})

function alias(over: Partial<ModelAlias> = {}): ModelAlias {
  return {
    alias: 'model-a',
    providerId: 'provider-a',
    upstreamModel: 'model-a',
    capabilities: { tools: true, vision: false, thinking: true, caching: false },
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    ...over
  }
}

describe('resolveModelThinking', () => {
  it('uses only declared efforts, maps none/xhigh to UI names, and clears a stale choice', () => {
    const model = alias({ thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'max' },
      reasoningEfforts: ['low', 'high', 'max'] })
    expect(modelThinkingLevels(model)).toEqual(['auto', 'low', 'high', 'max'])
    expect(normalizeModelThinkingLevel('medium', model)).toBe('auto')
    expect(normalizeModelThinkingLevel('off', model)).toBe('auto')
    expect(normalizeModelThinkingLevel('high', model)).toBe('high')
    expect(modelThinkingLevels({ ...model, reasoningEfforts: ['none', 'xhigh'] })).toEqual(['auto', 'higher', 'off'])
    expect(resolveModelThinking('auto', model.thinkingConfig, 32_000, model.reasoningEfforts)?.effort).toBe('max')
  })

  it('exposes only relevant controls for unsupported, always, toggle and budget modes', () => {
    expect(modelThinkingLevels(alias({ thinkingConfig: { mode: 'unsupported', defaultEnabled: false } }))).toEqual(['auto'])
    expect(modelThinkingLevels(alias({ thinkingConfig: { mode: 'always', defaultEnabled: true } }))).toEqual(['auto'])
    const toggle = { mode: 'toggle', defaultEnabled: false, defaultBudgetTokens: 4096 } as const
    expect(modelThinkingLevels(alias({ thinkingConfig: toggle }))).toEqual(['auto', 'medium', 'off'])
    expect(resolveModelThinking('medium', toggle, 32_000)?.budgetTokens).toBe(4096)
    expect(modelThinkingLevels(alias({ thinkingConfig: { mode: 'budget', defaultEnabled: true } }))).toContain('higher')
  })

  it('treats automatic default none as disabled and repairs an obsolete default within the accepted set', () => {
    expect(resolveModelThinking('auto', { mode: 'effort', defaultEnabled: true, defaultEffort: 'none' }, 32_000, ['none', 'high']))
      .toMatchObject({ enabled: false, explicit: false })
    expect(resolveModelThinking('auto', { mode: 'effort', defaultEnabled: true, defaultEffort: 'medium' }, 32_000, ['low', 'high'])?.effort)
      .toBe('low')
  })
  it('unsupported never produces a reasoning request', () => {
    expect(resolveModelThinking('max', { mode: 'unsupported', defaultEnabled: false }, 32_000))
      .toBeUndefined()
  })

  it('effort uses defaults and maps the UI higher notch to xhigh', () => {
    const config: ThinkingConfig = {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'low',
      parameterPath: 'reasoning_effort'
    }
    expect(resolveModelThinking('auto', config, 32_000)).toMatchObject({
      enabled: true,
      effort: 'low',
      explicit: false
    })
    expect(resolveModelThinking('higher', config, 32_000)).toMatchObject({
      enabled: true,
      effort: 'xhigh',
      explicit: true
    })
    expect(resolveModelThinking('off', config, 32_000)).toMatchObject({
      enabled: false,
      explicit: true
    })
  })

  it('budget is clamped below max output and always mode cannot be disabled', () => {
    expect(resolveModelThinking('max', {
      mode: 'budget',
      defaultEnabled: true,
      defaultBudgetTokens: 64_000
    }, 8_192)).toMatchObject({ enabled: true, budgetTokens: 7_168 })
    expect(resolveModelThinking('off', { mode: 'always', defaultEnabled: true }, 8_192))
      .toMatchObject({ mode: 'always', enabled: true })
  })
})

describe('validateModelRuntime', () => {
  it('honours explicit visionInput and legacy vision', () => {
    const legacy = validateModelRuntime({ alias: alias({ capabilities: { tools: true, vision: true, thinking: false, caching: false } }), messages: [message(['image'])] })
    expect(legacy).toEqual([])

    const explicit = validateModelRuntime({
      alias: alias({ capabilities: { tools: true, vision: true, visionInput: false, thinking: false, caching: false } }),
      messages: [message(['image'])]
    })
    expect(explicit.map((issue) => issue.code)).toContain('vision_input_unsupported')
  })

  it('checks file/media part kinds at the runtime boundary', () => {
    const issues = validateModelRuntime({
      alias: alias({ capabilities: { tools: true, vision: false, thinking: false, caching: false } }),
      messages: [message(['file', 'video', 'audio'])]
    })
    expect(issues.map((issue) => issue.code)).toEqual([
      'file_input_unsupported',
      'video_input_unsupported',
      'audio_input_unsupported'
    ])
  })

  it('checks tool history, web-search reachability, and configured limits', () => {
    const issues = validateModelRuntime({
      alias: alias({
        capabilities: { tools: false, vision: false, thinking: false, caching: false },
        contextWindow: 8_000,
        maxOutputTokens: 9_000
      }),
      messages: [message(['tool_call'])],
      webSearchRequested: true,
      estimatedInputTokens: 100
    })
    expect(issues.map((issue) => issue.code)).toEqual([
      'invalid_max_output_tokens',
      'tools_unsupported',
      'web_search_unsupported',
      'context_length'
    ])
  })

  it('uses input plus reserved output for the context-window check', () => {
    expect(validateModelRuntime({
      alias: alias({ contextWindow: 10_000, maxOutputTokens: 2_000 }),
      messages: [message(['text'])],
      estimatedInputTokens: 8_001
    }).map((issue) => issue.code)).toContain('context_length')
  })
})
