import { describe, expect, it } from 'vitest'
import { computeDiff, type DiffRow } from '../diff'

/** 把行拍平成便于断言的紧凑形式。 */
const shape = (rows: DiffRow[]): string[] =>
  rows.map((r) => `${r.type[0]}:${r.spans.map((s) => s.text).join('')}`)

/** 取某一行里被高亮(hi)的文本片段。 */
const hi = (rows: DiffRow[], type: DiffRow['type']): string[] =>
  rows.filter((r) => r.type === type).flatMap((r) => r.spans.filter((s) => s.hi).map((s) => s.text))

describe('computeDiff', () => {
  it('完全相同的文本只产出 context 行', () => {
    const rows = computeDiff('a\nb', 'a\nb')
    expect(shape(rows)).toEqual(['c:a', 'c:b'])
    expect(hi(rows, 'del')).toEqual([])
    expect(hi(rows, 'add')).toEqual([])
  })

  it('改动的一对行做词级高亮,未变的词不高亮', () => {
    const rows = computeDiff(
      'import { locales } from "@/config";',
      'import { locales, hasLocale } from "@/config";'
    )
    // 一删一增,且拼回去就是原文
    expect(shape(rows)).toEqual([
      'd:import { locales } from "@/config";',
      'a:import { locales, hasLocale } from "@/config";'
    ])
    // 只有新增的词被高亮,公共部分不高亮
    expect(hi(rows, 'add').join('')).toContain('hasLocale')
    expect(hi(rows, 'add').join('')).not.toContain('locales')
    expect(hi(rows, 'del')).toEqual([])
  })

  it('保留上下文行,只把中间那行标成改动', () => {
    const rows = computeDiff('head\nfoo\ntail', 'head\nbar\ntail')
    expect(shape(rows)).toEqual(['c:head', 'd:foo', 'a:bar', 'c:tail'])
  })

  it('落单的新增行只靠行底色表达,不叠词级高亮', () => {
    const rows = computeDiff('a\nc', 'a\nb\nc')
    expect(shape(rows)).toEqual(['c:a', 'a:b', 'c:c'])
    // 整行都是新增时,再把整行标成高亮等于没标 —— 还会糊成一块实心底
    expect(hi(rows, 'add')).toEqual([])
  })

  it('落单的删除行同样不叠词级高亮', () => {
    const rows = computeDiff('a\nb\nc', 'a\nc')
    expect(shape(rows)).toEqual(['c:a', 'd:b', 'c:c'])
    expect(hi(rows, 'del')).toEqual([])
  })

  it('配对的两行几乎毫不相干时,抹平词级高亮', () => {
    const rows = computeDiff('<ModelStatusStrip model={model} />', '                <Suspense')
    // 只是被 LCS 按位置凑成一对,逐词标注会把整行标满 —— 退回行级表达
    expect(hi(rows, 'add')).toEqual([])
    expect(hi(rows, 'del')).toEqual([])
  })

  it('改动占比不高时保留词级高亮', () => {
    const rows = computeDiff('const a = foo(x)', 'const a = bar(x)')
    expect(hi(rows, 'add')).toEqual(['bar'])
    expect(hi(rows, 'del')).toEqual(['foo'])
  })

  it('增删行数不等时不做词级配对,按先删后增排列', () => {
    const rows = computeDiff('x1\nx2', 'y1')
    expect(shape(rows)).toEqual(['d:x1', 'd:x2', 'a:y1'])
    // 凑不成对,就不标词级高亮
    expect(hi(rows, 'del')).toEqual([])
    expect(hi(rows, 'add')).toEqual([])
  })
})
