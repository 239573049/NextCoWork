import { describe, expect, it } from 'vitest'
import { dayPartOf, greetingOf } from '../domain/greeting'

/**
 * 问候语的 bug 只有一种形状:**边界差一小时**。而它在界面上极难发现 ——
 * 要么等到那个点,要么改系统时间。所以这里逐个钉死切点,
 * 每一段都测「进入的第一小时」和「离开前的最后一小时」。
 */
describe('dayPartOf · 四个切点', () => {
  it('★ 每一段的首尾两小时都归位', () => {
    expect([0, 4].map(dayPartOf)).toEqual(['night', 'night'])
    expect([5, 11].map(dayPartOf)).toEqual(['morning', 'morning'])
    expect([12, 17].map(dayPartOf)).toEqual(['afternoon', 'afternoon'])
    expect([18, 23].map(dayPartOf)).toEqual(['evening', 'evening'])
  })

  it('★ 切点本身不落在上一段 —— 12 点整是下午,不是上午', () => {
    expect(dayPartOf(11)).toBe('morning')
    expect(dayPartOf(12)).toBe('afternoon')
    expect(dayPartOf(17)).toBe('afternoon')
    expect(dayPartOf(18)).toBe('evening')
  })

  it('一整天 24 个小时一个不漏,而且四段都用上了', () => {
    const all = Array.from({ length: 24 }, (_, h) => dayPartOf(h))
    expect(all).toHaveLength(24)
    expect(new Set(all)).toEqual(new Set(['night', 'morning', 'afternoon', 'evening']))
  })

  it('越界输入归一化,不返回 undefined —— 首屏不能因此空一块', () => {
    expect(dayPartOf(24)).toBe(dayPartOf(0))
    expect(dayPartOf(-1)).toBe(dayPartOf(23))
    expect(dayPartOf(25.7)).toBe(dayPartOf(1))
  })
})

describe('greetingOf', () => {
  it('每一段都有话说,且四句互不相同', () => {
    const said = [0, 8, 14, 20].map(greetingOf)
    expect(said.every((s) => s.length > 0)).toBe(true)
    expect(new Set(said).size).toBe(4)
  })
})
