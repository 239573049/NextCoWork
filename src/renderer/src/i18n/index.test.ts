import { describe, expect, it } from 'vitest'
import { messagesFor } from './index'

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
