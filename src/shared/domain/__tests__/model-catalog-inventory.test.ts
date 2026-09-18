import { describe, expect, it } from 'vitest'
import { defaultProtocolForModel } from '../model-catalog-inventory'

/*
 * 「厂商默认协议」这张表钉的是规则本身,不是某一行的取值 ——
 * 它被三处消费(种子 / 拉取列表 / 老库回填),这里防的是「表被改空或匹配
 * 悄悄失效」之后,三个入口各自回到「跟随供应商」而无人报错。
 */
describe('厂商默认协议', () => {
  it('claude 系模型默认走 anthropic 线形,聚合站前缀 ID 与裸名等价', () => {
    expect(defaultProtocolForModel('claude-fable-5-1')).toBe('anthropic')
    expect(defaultProtocolForModel('claude-opus-5')).toBe('anthropic')
    expect(defaultProtocolForModel('anthropic/claude-fable-5-1')).toBe('anthropic')
    // ★ 点号拼写是预设侧真实在用的形式(anthropic / openrouter 的 suggestedModels),
    // 漏登记的话这两处错过目录 —— 元数据和协议钉一起失效
    expect(defaultProtocolForModel('claude-fable-5.1')).toBe('anthropic')
    expect(defaultProtocolForModel('anthropic/claude-fable-5.1')).toBe('anthropic')
    expect(defaultProtocolForModel('claude-opus-4.8')).toBe('anthropic')
  })

  it('未登记厂商与目录外模型返回 undefined,含义是跟随供应商协议', () => {
    expect(defaultProtocolForModel('gpt-5.6-sol')).toBeUndefined()
    expect(defaultProtocolForModel('glm-5.3')).toBeUndefined()
    expect(defaultProtocolForModel('deepseek-v4-pro')).toBeUndefined()
    expect(defaultProtocolForModel('totally-unknown-model')).toBeUndefined()
  })
})
