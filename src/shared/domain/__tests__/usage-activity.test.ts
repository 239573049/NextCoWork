import { describe, expect, it } from 'vitest'
import {
  computeStreaks,
  dayFromIndex,
  dayIndex,
  dayRange,
  weekdayOf
} from '../usage-activity'

describe('日期序号', () => {
  it('相邻日期的序号差 1', () => {
    expect(dayIndex('2026-09-14') - dayIndex('2026-09-13')).toBe(1)
  })

  it('跨月跨年也差 1', () => {
    expect(dayIndex('2026-10-01') - dayIndex('2026-09-30')).toBe(1)
    expect(dayIndex('2027-01-01') - dayIndex('2026-12-31')).toBe(1)
  })

  it('闰日不被跳过', () => {
    expect(dayIndex('2028-03-01') - dayIndex('2028-02-29')).toBe(1)
    expect(dayIndex('2028-02-29') - dayIndex('2028-02-28')).toBe(1)
  })

  /*
   * 这条是整个文件存在的理由:美国夏令时在 3 月第二个周日跳过一小时、
   * 11 月第一个周日多一小时。按本地时间戳相减除以 86400000 的实现会在这两天
   * 得到 0.958 / 1.042,于是「连续天数」每年断两次。
   */
  it('夏令时切换日仍然只差 1 天', () => {
    expect(dayIndex('2026-03-09') - dayIndex('2026-03-08')).toBe(1)
    expect(dayIndex('2026-11-02') - dayIndex('2026-11-01')).toBe(1)
  })

  it('与 dayFromIndex 互为逆运算', () => {
    for (const day of ['1970-01-01', '2026-09-14', '2026-03-08', '2099-12-31']) {
      expect(dayFromIndex(dayIndex(day))).toBe(day)
    }
  })

  it('非法输入返回 NaN 而不是碰巧算出一个数', () => {
    expect(dayIndex('')).toBeNaN()
    expect(dayIndex('2026-9-14')).toBeNaN()
    expect(dayIndex('not-a-date')).toBeNaN()
  })
})

describe('weekdayOf', () => {
  it('1970-01-01 是周四', () => {
    expect(weekdayOf('1970-01-01')).toBe(4)
  })

  it('认得周日与周六', () => {
    expect(weekdayOf('2026-09-13')).toBe(0)
    expect(weekdayOf('2026-09-19')).toBe(6)
  })
})

describe('dayRange', () => {
  it('含两端', () => {
    expect(dayRange('2026-09-12', '2026-09-14')).toEqual([
      '2026-09-12',
      '2026-09-13',
      '2026-09-14'
    ])
  })

  it('单日返回一个元素', () => {
    expect(dayRange('2026-09-14', '2026-09-14')).toEqual(['2026-09-14'])
  })

  it('起点晚于终点返回空,不是倒序也不是死循环', () => {
    expect(dayRange('2026-09-14', '2026-09-12')).toEqual([])
  })
})

describe('computeStreaks', () => {
  it('空输入两个数都是 0', () => {
    expect(computeStreaks([], '2026-09-14')).toEqual({ current: 0, longest: 0 })
  })

  it('连到今天', () => {
    const days = ['2026-09-12', '2026-09-13', '2026-09-14']
    expect(computeStreaks(days, '2026-09-14')).toEqual({ current: 3, longest: 3 })
  })

  // 零点一过就把连胜清零的话,用户会以为自己断签了
  it('连到昨天仍算延续', () => {
    const days = ['2026-09-12', '2026-09-13']
    expect(computeStreaks(days, '2026-09-14')).toEqual({ current: 2, longest: 2 })
  })

  it('断到前天则当前归零,但最长仍在', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03']
    expect(computeStreaks(days, '2026-09-14')).toEqual({ current: 0, longest: 3 })
  })

  it('最长取历史最优,不是最近那一段', () => {
    const days = [
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
      '2026-09-13', '2026-09-14'
    ]
    expect(computeStreaks(days, '2026-09-14')).toEqual({ current: 2, longest: 5 })
  })

  it('乱序与重复都不影响结果', () => {
    const days = ['2026-09-14', '2026-09-12', '2026-09-13', '2026-09-13', '2026-09-14']
    expect(computeStreaks(days, '2026-09-14')).toEqual({ current: 3, longest: 3 })
  })

  it('跨月连续', () => {
    const days = ['2026-08-30', '2026-08-31', '2026-09-01']
    expect(computeStreaks(days, '2026-09-01')).toEqual({ current: 3, longest: 3 })
  })

  it('跨夏令时连续', () => {
    const days = ['2026-03-07', '2026-03-08', '2026-03-09']
    expect(computeStreaks(days, '2026-03-09')).toEqual({ current: 3, longest: 3 })
  })

  it('只活跃一天', () => {
    expect(computeStreaks(['2026-09-14'], '2026-09-14')).toEqual({ current: 1, longest: 1 })
  })
})
