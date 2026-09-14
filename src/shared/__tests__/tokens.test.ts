import { describe, expect, it } from 'vitest'
import { formatTokenCount } from '../agent/tokens'

describe('formatTokenCount', () => {
  it('三位数以内原样显示,不硬凑单位', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(842)).toBe('842')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('尾数小于 100 留一位小数,否则取整', () => {
    expect(formatTokenCount(1000)).toBe('1K')
    expect(formatTokenCount(1471)).toBe('1.5K')
    expect(formatTokenCount(53_561)).toBe('53.6K')
    expect(formatTokenCount(534_561)).toBe('535K')
  })

  it('M / B 两档', () => {
    expect(formatTokenCount(1_234_567)).toBe('1.2M')
    expect(formatTokenCount(12_345_678)).toBe('12.3M')
    expect(formatTokenCount(123_456_789)).toBe('123M')
    expect(formatTokenCount(1_234_567_890)).toBe('1.2B')
  })

  /*
    ★ 这一组是这个函数唯一真正容易写错的地方。取整之前判断进位,999_999 会输出
    `1000K` —— 合法数字组成的非法读数。
  */
  it('取整进位后晋到上一档', () => {
    expect(formatTokenCount(999_499)).toBe('999K')
    expect(formatTokenCount(999_500)).toBe('1M')
    expect(formatTokenCount(999_999)).toBe('1M')
    expect(formatTokenCount(999_999_999)).toBe('1B')
    // 一位小数那一档同样会进位:99.96K → 100.0 → `100K`,不该变成 `100.0K`
    expect(formatTokenCount(99_960)).toBe('100K')
  })

  it('非有限值给「—」,不给 NaN', () => {
    expect(formatTokenCount(Number.NaN)).toBe('—')
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('负数带符号 —— 时钟/计数回退时不显示成一串乱码', () => {
    expect(formatTokenCount(-5000)).toBe('-5K')
  })
})
