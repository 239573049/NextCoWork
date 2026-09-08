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

/**
 * ★★ 这一组守的是「用户自建的订阅制中转会被算出假账单」那个 bug。
 *
 * 前提是真的:`findPricing` 查不到 `(providerId, modelId)` 会退回
 * `(null, modelId)` 那条通用价 —— 第一条测试先把这个前提钉住,否则后面那条
 * 「订阅制返回 null」就可能只是因为这个模型压根查不到价,测了个寂寞。
 */
describe('resolveUsagePricing:订阅制供应商不计价', () => {
  const at = Date.parse('2026-09-05T00:00:00Z')
  const modelId = resolveUsagePricingModelId('deepseek-v4-pro')

  it('★ 前提:自建供应商查不到自己的价,会命中通用价行', () => {
    const generic = resolveUsagePricing(undefined, 'custom-my-relay', modelId, at)
    expect(generic).not.toBeNull()
    expect(generic?.providerId).toBeNull()
  })

  it('打了订阅制标记就返回 null —— 同一条查询,只差这个标记', () => {
    expect(
      resolveUsagePricing({ subscription: true }, 'custom-my-relay', modelId, at)
    ).toBeNull()
  })

  it('没打标记或显式关闭的照常计价', () => {
    expect(resolveUsagePricing({ subscription: false }, 'custom-my-relay', modelId, at)).not.toBeNull()
    expect(resolveUsagePricing({}, 'custom-my-relay', modelId, at)).not.toBeNull()
  })

  it('查不到价时仍是 null,不会被短路逻辑变成一个 0', () => {
    expect(resolveUsagePricing(undefined, 'custom-my-relay', '不存在的模型', at)).toBeNull()
    expect(
      findPricing(PRICING_SEED, 'custom-my-relay', '不存在的模型', at)
    ).toBeNull()
  })
})
