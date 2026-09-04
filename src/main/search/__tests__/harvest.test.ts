/**
 * 挖字段的用例。这个文件之所以能写得这么细,是因为 `harvest.ts` 是纯函数、
 * 零 import —— 它被拆成那样,就是为了让「响应长得不一样」这件事**离线可穷举**。
 *
 * 反着说更清楚:这里每条断言对应的线上症状都是同一个 ——
 * **HTTP 200、零条结果、没有任何报错**。那种故障除了穷举以外没有别的抓法。
 */
import { describe, expect, it } from 'vitest'
import { arrayAt, findResultArray, harvestAll, harvestItem, pick } from '../harvest'

describe('pick', () => {
  it('按候选顺序取第一个非空字符串', () => {
    expect(pick({ link: 'b', url: 'a' }, ['url', 'link'])).toBe('a')
    expect(pick({ link: 'b' }, ['url', 'link'])).toBe('b')
  })

  /** ★ 空串当没有 —— `{title: ''}` 落到后面的候选上,而不是产出一条没标题的结果 */
  it('空串和只有空白的串都当没有', () => {
    expect(pick({ title: '', name: '真名' }, ['title', 'name'])).toBe('真名')
    expect(pick({ title: '   ', name: '真名' }, ['title', 'name'])).toBe('真名')
  })

  it('顺手 trim', () => {
    expect(pick({ url: '  https://a.com  ' }, ['url'])).toBe('https://a.com')
  })

  it('非字符串的值不算数', () => {
    // 有的家会把 url 放成 {href: ...} 的对象,或者把 date 放成时间戳数字
    expect(pick({ url: { href: 'https://a.com' } }, ['url'])).toBeUndefined()
    expect(pick({ date: 1_700_000_000 }, ['date'])).toBeUndefined()
  })

  it('不是对象就直接没有', () => {
    expect(pick(null, ['url'])).toBeUndefined()
    expect(pick('https://a.com', ['url'])).toBeUndefined()
    expect(pick(['https://a.com'], ['url'])).toBeUndefined()
  })
})

describe('arrayAt', () => {
  it('按路径下钻', () => {
    expect(arrayAt({ web: { results: [1, 2] } }, ['web', 'results'])).toEqual([1, 2])
  })

  it('空路径就是根本身', () => {
    expect(arrayAt([1, 2], [])).toEqual([1, 2])
  })

  /** ★ 路径断了给空数组,不抛 —— 上层据此报「这家没有结果」并切下一家 */
  it('路径中途断掉给空数组', () => {
    expect(arrayAt({ web: {} }, ['web', 'results'])).toEqual([])
    expect(arrayAt({}, ['web', 'results'])).toEqual([])
    expect(arrayAt(null, ['web'])).toEqual([])
  })

  it('取到的不是数组也给空数组', () => {
    // 出错时不少家会把那个字段换成一个描述错误的对象
    expect(arrayAt({ results: { message: 'quota exceeded' } }, ['results'])).toEqual([])
  })
})

describe('findResultArray', () => {
  it('顶层就是数组时直接用', () => {
    const rows = [{ url: 'https://a.com' }]
    expect(findResultArray(rows)).toEqual(rows)
  })

  it('嵌一层能找到', () => {
    const rows = [{ link: 'https://a.com' }]
    expect(findResultArray({ data: rows })).toEqual(rows)
  })

  it('嵌两层能找到', () => {
    const rows = [{ url: 'https://a.com' }]
    expect(findResultArray({ data: { list: rows } })).toEqual(rows)
  })

  /**
   * ★ 只往下找两层。第三层往往是「相关搜索」「广告位」这类东西 ——
   * 把它们当成结果交给模型,比一条结果都没有更糟:模型会认真引用它们。
   */
  it('第三层不再往下找', () => {
    const rows = [{ url: 'https://a.com' }]
    expect(findResultArray({ a: { b: { c: rows } } })).toEqual([])
  })

  /** 没有 url 味道的数组不是结果列表 —— 这才是它区别于「随便找个数组」的地方 */
  it('元素里没有像 url 的字段就不算结果列表', () => {
    expect(findResultArray({ suggestions: ['北京天气', '上海天气'] })).toEqual([])
    expect(findResultArray({ related: [{ query: '北京天气', count: 3 }] })).toEqual([])
  })

  it('略过前面那些不像的,继续找后面的', () => {
    const rows = [{ url: 'https://a.com' }]
    const body = { suggestions: ['a', 'b'], meta: { took: 12 }, results: rows }
    expect(findResultArray(body)).toEqual(rows)
  })

  it('一个都没有时给空数组', () => {
    expect(findResultArray({ error: 'no permission' })).toEqual([])
    expect(findResultArray(null)).toEqual([])
  })
})

describe('harvestItem', () => {
  /** ★ 没有 url 就丢掉 —— 一条模型无法核实、无法引用的结果只会变成编造的素材 */
  it('没有 url 的整条丢掉', () => {
    expect(harvestItem({ title: '标题', content: '正文' })).toBeNull()
    expect(harvestItem({ title: '标题', url: '' })).toBeNull()
  })

  it('缺标题时退回用 url 当标题', () => {
    expect(harvestItem({ url: 'https://a.com' })?.title).toBe('https://a.com')
  })

  it('缺摘要时是空串,不是 undefined', () => {
    // 空串让渲染层可以无条件 .slice(),不必到处判空
    expect(harvestItem({ url: 'https://a.com' })?.snippet).toBe('')
  })

  it('六家的字段名都认', () => {
    // Tavily: content / Brave: description / Serper: link+snippet / Exa: text
    expect(harvestItem({ url: 'https://a.com', content: 'C' })?.snippet).toBe('C')
    expect(harvestItem({ url: 'https://a.com', description: 'D' })?.snippet).toBe('D')
    expect(harvestItem({ link: 'https://a.com', snippet: 'S' })?.snippet).toBe('S')
    expect(harvestItem({ url: 'https://a.com', text: 'T' })?.snippet).toBe('T')
  })

  it('日期能挖到就带上,挖不到就没有', () => {
    expect(harvestItem({ url: 'https://a.com', published_date: '2026-01-02' })?.publishedAt).toBe(
      '2026-01-02'
    )
    expect(harvestItem({ url: 'https://a.com' })?.publishedAt).toBeUndefined()
  })
})

describe('harvestAll', () => {
  it('丢掉挖不出 url 的,保留其余', () => {
    const out = harvestAll([{ url: 'https://a.com' }, { title: '没链接' }, { link: 'https://b.com' }])
    expect(out.map((i) => i.url)).toEqual(['https://a.com', 'https://b.com'])
  })

  /** 同一个 url 两次通常是「网页结果 + 精选摘要」,留第一条 */
  it('同一个 url 只留第一条', () => {
    const out = harvestAll([
      { url: 'https://a.com', title: '第一次' },
      { url: 'https://a.com', title: '第二次' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('第一次')
  })

  /** 去重按 trim 之后的 url 比 —— 首尾空白是排版噪音,不是不同的网页 */
  it('去重看的是 trim 之后的 url', () => {
    expect(harvestAll([{ url: 'https://a.com' }, { url: '  https://a.com  ' }])).toHaveLength(1)
  })

  it('保持原有顺序', () => {
    const out = harvestAll([
      { url: 'https://c.com' },
      { url: 'https://a.com' },
      { url: 'https://b.com' }
    ])
    expect(out.map((i) => i.url)).toEqual(['https://c.com', 'https://a.com', 'https://b.com'])
  })

  it('全是垃圾时给空数组,不抛', () => {
    expect(harvestAll([null, 42, 'string', {}, []])).toEqual([])
    expect(harvestAll([])).toEqual([])
  })
})
