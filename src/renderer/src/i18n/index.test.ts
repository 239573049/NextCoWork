import { describe, expect, it } from 'vitest'
import { messagesFor } from './index'
import { whimsyEn, whimsyZh } from './agent'

describe('renderer i18n catalog', () => {
  it('has a complete English catalog for every Chinese key', () => {
    const zh = messagesFor('zh-CN')
    const en = messagesFor('en-US')
    for (const key of Object.keys(zh)) expect(en[key], key).toBeDefined()
  })

  it('keeps locale-independent language names readable', () => {
    expect(messagesFor('en-US')['locale.name.zhCN']).toBe('简体中文')
    expect(messagesFor('en-US')['locale.name.enUS']).toBe('English')
  })
})

/**
 * 轮换词**不进** Messages 表,也就绕开了上面那条键一致性校验 —— 它们是一串
 * 可以随便增删的料。这一组守的是那份自由的边界:每个相位都得有料(少一个相位
 * 就是那一档永远显示 undefined),而且每条都得短 —— 这句话右边紧跟着用量读数,
 * 词一长后面整排就跟着左右抖,而这种抖动在截图里根本看不出是文案造成的。
 */
describe('whimsy 轮换词', () => {
  const ZH_MAX = 6
  const EN_MAX = 14

  it('每个相位两种语言都有料', () => {
    for (const phase of Object.keys(whimsyZh) as Array<keyof typeof whimsyZh>) {
      expect(whimsyZh[phase].length, phase).toBeGreaterThan(0)
      expect(whimsyEn[phase].length, phase).toBeGreaterThan(0)
    }
  })

  it('长度压在预算内,免得状态行右边那串读数跟着抖', () => {
    for (const [phase, words] of Object.entries(whimsyZh)) {
      for (const word of words) expect([...word].length, `${phase}: ${word}`).toBeLessThanOrEqual(ZH_MAX)
    }
    for (const [phase, words] of Object.entries(whimsyEn)) {
      for (const word of words) expect([...word].length, `${phase}: ${word}`).toBeLessThanOrEqual(EN_MAX)
    }
  })

  it('同一相位内不重复 —— 重复项会让轮换看起来像卡住了', () => {
    for (const [phase, words] of [...Object.entries(whimsyZh), ...Object.entries(whimsyEn)]) {
      expect(new Set(words).size, phase).toBe(words.length)
    }
  })
})
