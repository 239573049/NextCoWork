import { describe, expect, it } from 'vitest'
import { findPricing } from '../../shared/domain/pricing'
import { PRICING_SEED } from '../../shared/domain/pricing-seed'
import { resolveUsagePricing, resolveUsagePricingModelId } from '../runtime'

describe('resolveUsagePricingModelId', () => {
  it('resolves an aggregator-prefixed Kimi alias to its official pricing model id', () => {
    const modelId = resolveUsagePricingModelId('moonshot/kimi-k3')

    expect(modelId).toBe('kimi-k3')
    expect(findPricing(PRICING_SEED, 'moonshot', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      modelId: 'kimi-k3',
    })
  })

  it('resolves a case-normalized MiniMax alias to the canonical pricing model id', () => {
    const modelId = resolveUsagePricingModelId('minimax-m3')

    expect(modelId).toBe('MiniMax-M3')
    expect(findPricing(PRICING_SEED, 'minimax', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      modelId: 'MiniMax-M3',
    })
  })

  it('resolves Doubao endpoint versions to the official pricing product id', () => {
    const modelId = resolveUsagePricingModelId('doubao-seed-2-1-pro-260628')

    expect(modelId).toBe('doubao-seed-2.1-pro')
    expect(findPricing(PRICING_SEED, 'volcengine', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      providerId: null,
      modelId: 'doubao-seed-2.1-pro',
      currency: 'CNY',
    })
  })

  it('resolves ERNIE version aliases to their shared official price row', () => {
    const modelId = resolveUsagePricingModelId('ernie-5.0-thinking-latest')

    expect(modelId).toBe('ernie-5.0')
    expect(findPricing(PRICING_SEED, 'qianfan', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      providerId: null,
      modelId: 'ernie-5.0',
      currency: 'CNY',
    })
  })

  it('resolves the former lowercase LongCat id to the official canonical price row', () => {
    const modelId = resolveUsagePricingModelId('longcat-2.0')

    expect(modelId).toBe('LongCat-2.0')
    expect(findPricing(PRICING_SEED, 'longcat', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      providerId: null,
      modelId: 'LongCat-2.0',
      currency: 'USD',
      tiers: [{ upToInputTokens: null, rate: { input: 0.3, output: 1.2, cacheRead: 0.006 } }],
    })
  })

  it('resolves DeepSeek release aliases to the connection-independent official price', () => {
    const modelId = resolveUsagePricingModelId('DeepSeek-V4-Pro-0813')

    expect(modelId).toBe('deepseek-v4-pro')
    expect(findPricing(PRICING_SEED, 'deepseek', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      providerId: null,
      modelId: 'deepseek-v4-pro',
      currency: 'USD',
      tiers: [
        {
          rate: {
            input: 0.66,
            output: 1.98,
            cacheRead: 0.022,
          },
        },
      ],
    })
  })

  it('resolves a prefixed openPangu id to the connection-independent official Flash price', () => {
    const modelId = resolveUsagePricingModelId('huaweicloud/openpangu-2.0-flash')

    expect(modelId).toBe('openpangu-2.0-flash')
    expect(findPricing(PRICING_SEED, 'huaweicloud', modelId, Date.parse('2026-09-05T00:00:00Z'))).toMatchObject({
      providerId: null,
      modelId: 'openpangu-2.0-flash',
      currency: 'CNY',
      tiers: [{ upToInputTokens: null, rate: { input: 0.8, output: 1.6, cacheRead: 0.2 } }],
    })
  })

  it('keeps an unknown upstream model id unchanged', () => {
    expect(resolveUsagePricingModelId('custom/vendor-model')).toBe('custom/vendor-model')
  })
})

describe('resolveUsagePricing', () => {
  const at = Date.parse('2026-09-05T00:00:00Z')
  const modelId = resolveUsagePricingModelId('deepseek-v4-pro')

  /*
    ★ `findPricing` 查不到 `(providerId, modelId)` 会退回 `(null, modelId)` 那条
    通用价 —— 自建供应商都走这条路。这个回退是**故意**的,钉住它是为了
    「查不到价」那条测试不至于因为回退悄悄没了而变成测了个寂寞。
  */
  it('自建供应商查不到自己的价,会命中通用价行', () => {
    const generic = resolveUsagePricing('custom-my-relay', modelId, at)
    expect(generic).not.toBeNull()
    expect(generic?.providerId).toBeNull()
  })

  it('查不到价时是 null,而不是一个看着挺像样的 0', () => {
    expect(resolveUsagePricing('custom-my-relay', '不存在的模型', at)).toBeNull()
    expect(findPricing(PRICING_SEED, 'custom-my-relay', '不存在的模型', at)).toBeNull()
  })
})
