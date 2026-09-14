import { describe, expect, it } from 'vitest'
import { heatColor, seriesColor, seriesPalette } from '../charts/colors'

/*
 * 这些断言看着琐碎,守的是一件具体的事:色值必须留成 `var(--color-*)` 表达式
 * 交给浏览器算。一旦有人改成在 JS 里解析成 `#36d285`,切主题后图表颜色就不动了 ——
 * 而那是只有肉眼才能发现的失效。
 */
describe('heatColor', () => {
  it('每一档都引用主题变量,不写死色值', () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      expect(heatColor(level)).toContain('var(--color-')
      expect(heatColor(level)).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
  })

  it('第 0 档是槽色 —— 「没发生」不是「发生得很少」', () => {
    expect(heatColor(0)).toBe('var(--color-tint)')
    expect(heatColor(0)).not.toContain('accent')
  })

  it('档位越高 accent 占比越大', () => {
    const mix = (level: 1 | 2 | 3 | 4): number =>
      Number(/accent\) (\d+)%/.exec(heatColor(level))![1])
    expect(mix(1)).toBeLessThan(mix(2))
    expect(mix(2)).toBeLessThan(mix(3))
    expect(mix(3)).toBeLessThan(mix(4))
  })

  it('最高档是纯 accent', () => {
    expect(heatColor(4)).toContain('100%')
  })
})

describe('seriesColor', () => {
  it('单项时直接用 accent', () => {
    expect(seriesColor(0, 1)).toBe('var(--color-accent)')
  })

  it('首项最浓、末项最淡', () => {
    const mix = (i: number, n: number): number =>
      Number(/accent\) (\d+)%/.exec(seriesColor(i, n))![1])
    expect(mix(0, 5)).toBe(100)
    expect(mix(4, 5)).toBe(24)
    expect(mix(1, 5)).toBeGreaterThan(mix(3, 5))
  })

  // 再淡就和空槽分不开了
  it('最淡的一档仍高于 24%', () => {
    for (const n of [2, 5, 9, 20]) {
      const mix = Number(/accent\) (\d+)%/.exec(seriesColor(n - 1, n))![1])
      expect(mix).toBeGreaterThanOrEqual(24)
    }
  })

  it('越界序号被夹住,不产生负百分比', () => {
    expect(seriesColor(99, 5)).toBe(seriesColor(4, 5))
  })
})

describe('seriesPalette', () => {
  it('长度与请求一致且各不相同', () => {
    const palette = seriesPalette(6)
    expect(palette).toHaveLength(6)
    expect(new Set(palette).size).toBe(6)
  })

  it('0 与负数返回空数组而不是抛错', () => {
    expect(seriesPalette(0)).toEqual([])
    expect(seriesPalette(-3)).toEqual([])
  })
})
