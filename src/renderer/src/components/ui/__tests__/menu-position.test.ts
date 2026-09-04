import { describe, expect, it } from 'vitest'
import { placeMenu, type TriggerRect } from '../menu-position'

/**
 * 这一组守的是方案 §7 第 1 条修掉的那个 bug:菜单原来是 `absolute`,
 * 落在 `overflow-y-auto` 的内容区靠下位置时会被**裁掉半截**。
 *
 * ★ 裁掉半截是个**看得见**的坏,所以它当初能被发现;
 * 而换成 `fixed` 之后新引入的坏全是**算错坐标** —— 面板出现在离触发器十万八千里的
 * 地方、或者刚好被推出视口。那些同样看得见,但只在特定窗口高度下才复现,
 * 手点很难覆盖到。所以边界情况在这里穷举,而不是靠开着应用拖窗口试。
 */

const vp = { width: 1440, height: 900 }
/** 视口正中的一个触发器:上下都宽敞,不该翻 */
const middle: TriggerRect = { top: 400, bottom: 432, left: 300, right: 580 }

describe('placeMenu · 竖直方向', () => {
  it('下方够用时挂在触发器下面,留 6px 空隙', () => {
    const p = placeMenu(middle, 200, 280, 'start', vp)
    expect(p.flipped).toBe(false)
    expect(p.top).toBe(432 + 6)
  })

  /** ★ 这就是原来会被裁掉的那种位置 */
  it('贴着视口底边、上面宽敞时向上翻,面板底缘落在触发器上方', () => {
    const low: TriggerRect = { top: 820, bottom: 852, left: 300, right: 580 }
    const p = placeMenu(low, 300, 280, 'start', vp)
    expect(p.flipped).toBe(true)
    expect(p.top + 300).toBe(820 - 6)
  })

  /**
   * ★ 判据是「上面更宽敞」而不是「下面放不下」。触发器在正中时上下一样挤,
   * 翻上去没有任何好处 —— 只会让面板每次出现在意料之外的一侧。
   */
  it('菜单很长但上下一样挤时不翻,改成限高内部滚动', () => {
    const p = placeMenu(middle, 5000, 280, 'start', vp)
    expect(p.flipped).toBe(false)
    expect(p.maxHeight).toBe(900 - 432 - 6 - 8)
    // 限了高就不该再被推出视口
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(900 - 8)
  })

  it('翻上去之后同样限高,不会长到视口上边之外', () => {
    const low: TriggerRect = { top: 700, bottom: 732, left: 300, right: 580 }
    const p = placeMenu(low, 5000, 280, 'start', vp)
    expect(p.flipped).toBe(true)
    expect(p.top).toBeGreaterThanOrEqual(8)
  })

  /**
   * ★ 视口极矮(窗口被拖成一条)时,可用高度可能只剩十几像素。
   * 那时宁可让面板盖住触发器,也不能给出一条谁也点不中的缝。
   */
  it('视口极矮时保底给出可用高度,且仍然留在视口里', () => {
    const tiny = { width: 1440, height: 180 }
    const t: TriggerRect = { top: 120, bottom: 152, left: 300, right: 580 }
    const p = placeMenu(t, 400, 280, 'start', tiny)
    expect(p.maxHeight).toBeGreaterThanOrEqual(120)
    expect(p.top).toBeGreaterThanOrEqual(8)
  })

  it('视口比面板还矮时上界不会算成负数', () => {
    const t: TriggerRect = { top: 10, bottom: 40, left: 300, right: 580 }
    const p = placeMenu(t, 400, 280, 'start', { width: 1440, height: 100 })
    expect(p.top).toBe(8)
  })
})

describe('placeMenu · 水平方向', () => {
  it("align='start' 左缘对齐触发器左缘", () => {
    expect(placeMenu(middle, 200, 280, 'start', vp).left).toBe(300)
  })

  it("align='end' 右缘对齐触发器右缘", () => {
    expect(placeMenu(middle, 200, 280, 'end', vp).left).toBe(580 - 280)
  })

  /** 触发器贴右边框时,右对齐算出来的位置本身是合法的,不该被误夹 */
  it('触发器贴着视口右边时面板不越界', () => {
    const right: TriggerRect = { top: 400, bottom: 432, left: 1300, right: 1432 }
    const p = placeMenu(right, 200, 280, 'start', vp)
    expect(p.left + 280).toBeLessThanOrEqual(1440 - 8)
  })

  it('触发器贴着视口左边、右对齐会算出负数时夹回边距', () => {
    const left: TriggerRect = { top: 400, bottom: 432, left: 4, right: 60 }
    expect(placeMenu(left, 200, 280, 'end', vp).left).toBe(8)
  })

  it('视口比面板还窄时贴左边距,不给负数', () => {
    const p = placeMenu(middle, 200, 280, 'start', { width: 200, height: 900 })
    expect(p.left).toBe(8)
  })
})
