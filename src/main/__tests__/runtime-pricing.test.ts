import { describe, expect, it } from 'vitest'
import { findPricing } from '../../shared/domain/pricing'
import { PRICING_SEED } from '../../shared/domain/pricing-seed'
import { resolveUsagePricingModelId } from '../runtime'

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
