import { describe, expect, it } from 'vitest'
import { parsePartialJson } from '../partial-json'

describe('parsePartialJson', () => {
  it('完整 JSON 与原生 JSON.parse 保持一致', () => {
    expect(parsePartialJson('{"path":"a.ts","count":2,"ok":true,"empty":null}')).toEqual({
      path: 'a.ts',
      count: 2,
      ok: true,
      empty: null
    })
    expect(parsePartialJson('[1,"two",false]')).toEqual([1, 'two', false])
  })

  it('字符串尚未闭合时也暴露当前字段', () => {
    expect(parsePartialJson('{"file_path":"src/renderer/App')).toEqual({
      file_path: 'src/renderer/App'
    })
  })

  it('嵌套数组和对象未闭合时保留已经到达的结构', () => {
    expect(parsePartialJson(
      '{"todos":[{"content":"第一项","status":"completed"},{"content":"第二'
    )).toEqual({
      todos: [
        { content: '第一项', status: 'completed' },
        { content: '第二' }
      ]
    })
  })

  it('逗号后的下一个值尚未到达时保留之前的字段', () => {
    expect(parsePartialJson('{"query":"json parser",')).toEqual({ query: 'json parser' })
    expect(parsePartialJson('{"items":[1,2,')).toEqual({ items: [1, 2] })
    expect(parsePartialJson('{"enabled":tru')).toEqual({})
  })

  it('解码完整转义并忽略尚未完成的转义尾巴', () => {
    expect(parsePartialJson('{"text":"line\\nquote \\"ok')).toEqual({
      text: 'line\nquote "ok'
    })
    expect(parsePartialJson('{"text":"A\\u4e')).toEqual({ text: 'A' })
    expect(parsePartialJson('{"text":"A\\u4e2d')).toEqual({ text: 'A中' })
  })

  it('展示尚未结束的数字当前值', () => {
    expect(parsePartialJson('{"fraction":0.')).toEqual({ fraction: 0 })
    expect(parsePartialJson('{"count":12')).toEqual({ count: 12 })
    expect(parsePartialJson('{"scale":1e')).toEqual({ scale: 1 })
  })

  it('空输入与确定畸形的输入不伪造结果', () => {
    expect(parsePartialJson('')).toBeUndefined()
    expect(parsePartialJson('{"x":}')).toBeUndefined()
    expect(parsePartialJson('{"x":01')).toBeUndefined()
    expect(parsePartialJson('{"x":"bad\\q')).toBeUndefined()
  })

  it('嵌套深度超过展示上限时安全退出', () => {
    expect(parsePartialJson('['.repeat(256))).toBeUndefined()
  })

  it('__proto__ 保持普通数据字段且不改对象原型', () => {
    const value = parsePartialJson('{"__proto__":{"polluted":true')
    const record = typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : undefined
    expect(Object.keys(record ?? {})).toEqual(['__proto__'])
    expect(record?.['__proto__']).toEqual({ polluted: true })
    expect(record === undefined ? null : Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})
