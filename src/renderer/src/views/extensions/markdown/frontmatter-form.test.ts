import { describe, expect, it } from 'vitest'
import { readField, readListField, setField, setListField, validate } from './frontmatter-form'

describe('读字段', () => {
  it('字符串原样读出', () => {
    expect(readField({ description: 'x' }, 'description')).toBe('x')
  })

  it('缺失读成空串，而不是 undefined —— 它要直接喂给受控输入框', () => {
    expect(readField({}, 'description')).toBe('')
  })

  it('列表读成逗号串，好塞进单行输入框', () => {
    expect(readField({ tools: ['Read', 'Grep'] }, 'tools')).toBe('Read, Grep')
  })

  it('readListField 认逗号串也认数组 —— 用户会把 CC 的 agent 文件原样粘过来', () => {
    expect(readListField({ tools: 'Read, Grep' }, 'tools')).toEqual(['Read', 'Grep'])
    expect(readListField({ tools: ['Read', 'Grep'] }, 'tools')).toEqual(['Read', 'Grep'])
    expect(readListField({}, 'tools')).toEqual([])
  })
})

describe('写字段', () => {
  it('★ 空值删键，而不是写一个空值', () => {
    // `description:` 空着会被解析器当成「块式序列的头」，形状就变了。
    expect(setField({ description: 'x', other: 'y' }, 'description', '')).toEqual({ other: 'y' })
    expect(setField({ description: 'x' }, 'description', '   ')).toEqual({})
  })

  it('空列表同样删键', () => {
    expect(setListField({ tools: ['a'], other: 'y' }, 'tools', [])).toEqual({ other: 'y' })
  })

  it('★ 不认识的键在改动中原样留着 —— 表单只覆盖它认识的那几个', () => {
    const fm = { description: 'x', color: 'blue' }
    expect(setField(fm, 'description', 'y')).toEqual({ description: 'y', color: 'blue' })
    expect(setListField(fm, 'tools', ['Read'])).toEqual({ description: 'x', color: 'blue', tools: ['Read'] })
  })

  it('不改原对象', () => {
    const fm = { description: 'x' }
    setField(fm, 'description', 'y')
    expect(fm).toEqual({ description: 'x' })
  })
})

describe('validate', () => {
  it('正文为空拦下 —— 正文就是它的全部内容', () => {
    expect(validate('command', { description: 'x' }, '   ')).toBe('ext.error.emptyBody')
  })

  it('★ 子代理缺 description 必须拦下', () => {
    // `agent/load.ts` 会把没有 description 的整条作废，放过去的表现是
    // 「存完之后这个子代理消失了」，而界面上什么也没说。
    expect(validate('agent', {}, '正文')).toBe('ext.error.agentNeedsDescription')
    expect(validate('agent', { description: '  ' }, '正文')).toBe('ext.error.agentNeedsDescription')
  })

  it('命令不要求 description —— 缺了就拿正文第一行兜底', () => {
    expect(validate('command', {}, '正文')).toBeNull()
  })

  it('都齐了返回 null', () => {
    expect(validate('agent', { description: 'x' }, '正文')).toBeNull()
  })
})
