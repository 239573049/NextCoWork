import { describe, expect, it } from 'vitest'
import type { ModelAlias, UpstreamProvider } from '../provider'
import {
  modelBindingsFor,
  modelSelectionKey,
  parseModelSelectionKey,
  selectModelBinding,
  subagentModelSelection
} from '../model-selection'

function provider(id: string, priority: number, enabled = true): UpstreamProvider {
  return { id, name: id.toUpperCase(), protocol: 'openai-chat', baseUrl: 'https://local.invalid',
    credentialRef: '', priority, enabled }
}

function model(providerId: string, alias: string, enabled?: boolean): ModelAlias {
  return { alias, upstreamModel: alias, providerId, contextWindow: 100000, maxOutputTokens: 8192,
    capabilities: { tools: true, vision: true, thinking: true, caching: true },
    ...(enabled === undefined ? {} : { enabled }) }
}

// 复现用户报的那一幕:RoutinAI 的 priority 更小,Codex 更大,两家都有 gpt-5.6-sol。
const routin = provider('routin', 0)
const codex = provider('codex', 10)
const providers = [routin, codex]
const models = [model('routin', 'gpt-5.6-sol'), model('codex', 'gpt-5.6-sol')]

describe('模型绑定选择', () => {
  it('没指定供应商时按 priority 择优 —— 这是引入 providerId 之前的行为,必须逐字保留', () => {
    expect(selectModelBinding(models, providers, 'gpt-5.6-sol', undefined)?.providerId).toBe('routin')
  })

  it('指定了 priority 更大的那家时选中它,而不是被优先级推翻', () => {
    const picked = modelBindingsFor(models, providers, 'gpt-5.6-sol', 'codex')
    expect(picked.map((m) => m.providerId)).toEqual(['codex'])
  })

  it('指定的那家被停用时返回空,**不回退到同名的另一家**', () => {
    const disabled = [routin, { ...codex, enabled: false }]
    expect(modelBindingsFor(models, disabled, 'gpt-5.6-sol', 'codex')).toEqual([])
  })

  it('指定的那家不提供这个别名时返回空', () => {
    expect(modelBindingsFor(models, providers, 'gpt-5.6-sol', 'nobody')).toEqual([])
  })

  it('别名自身被禁用时不参与候选', () => {
    const off = [model('routin', 'gpt-5.6-sol', false), model('codex', 'gpt-5.6-sol')]
    expect(selectModelBinding(off, providers, 'gpt-5.6-sol', undefined)?.providerId).toBe('codex')
  })

  it('同 priority 时保留输入顺序(sort 稳定),避免和路由器的 tie-break 分家', () => {
    const tied = [provider('a', 5), provider('b', 5)]
    const rows = [model('b', 'x'), model('a', 'x')]
    expect(modelBindingsFor(rows, tied, 'x', undefined).map((m) => m.providerId)).toEqual(['b', 'a'])
  })
})

describe('下拉框复合键', () => {
  it('别名里的斜杠原样保留 —— 只切第一个分隔符', () => {
    const key = modelSelectionKey('openrouter', 'openrouter/claude-sonnet-4')
    expect(parseModelSelectionKey(key))
      .toEqual({ modelProviderId: 'openrouter', alias: 'openrouter/claude-sonnet-4' })
  })

  it('没指定供应商时往返一致', () => {
    expect(parseModelSelectionKey(modelSelectionKey(undefined, 'gpt-5.5')))
      .toEqual({ modelProviderId: undefined, alias: 'gpt-5.5' })
  })

  it('裸别名(旧的持久化值)按「没指定」解析,而不是崩掉', () => {
    expect(parseModelSelectionKey('gpt-5.5')).toEqual({ modelProviderId: undefined, alias: 'gpt-5.5' })
  })
})

describe('子代理选模型', () => {
  const parent = { model: 'gpt-5.6-sol', modelProviderId: 'codex' }
  const none = { model: '' }

  it('三档都空不下来时连供应商一起继承父亲', () => {
    expect(subagentModelSelection(undefined, none, parent))
      .toEqual({ model: 'gpt-5.6-sol', modelProviderId: 'codex' })
  })

  it('★ 自己声明了别名时供应商必须是「没指定」,不能沿用父亲那家', () => {
    // frontmatter 里只写得下裸别名。沿用父亲的锁会拼出「A 家的别名 + B 家的锁」,
    // 候选集为空,报错还指着一个跟这次调用无关的供应商。
    expect(subagentModelSelection('claude-fable-5', none, parent))
      .toEqual({ model: 'claude-fable-5', modelProviderId: undefined })
  })

  it('父亲没锁时不凭空多出一个锁', () => {
    expect(subagentModelSelection(undefined, none, { model: 'gpt-5.5' }))
      .toEqual({ model: 'gpt-5.5', modelProviderId: undefined })
  })

  it('★★ 设置里配了「默认子代理」时它盖过父亲 —— 这一栏就是为了别跟着主力模型走', () => {
    expect(subagentModelSelection(undefined, { model: 'deepseek-v4-flash', modelProviderId: 'routin' }, parent))
      .toEqual({ model: 'deepseek-v4-flash', modelProviderId: 'routin' })
  })

  it('设置里的别名和供应商成对生效,不会拼出「配置的别名 + 父亲的锁」', () => {
    expect(subagentModelSelection(undefined, { model: 'deepseek-v4-flash' }, parent))
      .toEqual({ model: 'deepseek-v4-flash', modelProviderId: undefined })
  })

  it('子代理自己声明的别名盖过设置 —— 越具体的越优先', () => {
    expect(
      subagentModelSelection('claude-fable-5', { model: 'deepseek-v4-flash', modelProviderId: 'routin' }, parent)
    ).toEqual({ model: 'claude-fable-5', modelProviderId: undefined })
  })

  it('设置里是空白串时当作没配,而不是拿一个空别名去发请求', () => {
    expect(subagentModelSelection(undefined, { model: '  ' }, parent))
      .toEqual({ model: 'gpt-5.6-sol', modelProviderId: 'codex' })
  })
})
