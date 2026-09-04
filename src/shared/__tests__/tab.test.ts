import { describe, expect, it } from 'vitest'
import type { InnerTab, TabPane } from '../domain/tab'
import { paneOf, reorder, reorderInPane, tabsInPane } from '../domain/tab'

/**
 * 拖动重排的纯函数。看着平凡,但 splice 两次的「前移/后移偏移」
 * 是这类函数最经典的翻车点:从后往前拖和从前往后拖,
 * 同一个 `to` 的含义并不一样。
 */
describe('reorder', () => {
  const L = ['a', 'b', 'c', 'd'] as const

  it('往后拖:元素落在目标下标上', () => {
    expect(reorder(L, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('往前拖:元素落在目标下标上', () => {
    expect(reorder(L, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('相邻互换', () => {
    expect(reorder(L, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(reorder(L, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('拖到末尾', () => {
    expect(reorder(L, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('原地不动', () => {
    expect(reorder(L, 2, 2)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('to 越界时钳到末尾,不产生空洞', () => {
    expect(reorder(L, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  /**
   * ★ 负数 to 是真会发生的:指针拖到第一个 Tab 上方时,
   * 按坐标算出来的目标下标就是负的。而 splice 对负数的语义是「从末尾倒数」——
   * 不钳到 0 的话,拖到最前面会静默地插到倒数第二位。
   * (splice 自己会钳大于长度的下标,所以上一条测不出钳位是否存在,这一条能。)
   */
  it('to 为负时钳到 0 —— 拖到最前面就该落在最前面', () => {
    expect(reorder(L, 2, -1)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorder(L, 3, -5)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('from 越界时原样返回', () => {
    expect(reorder(L, 9, 0)).toEqual(['a', 'b', 'c', 'd'])
    expect(reorder(L, -1, 0)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('永不原地修改入参 —— store 里的数组必须保持不可变', () => {
    const src = ['a', 'b', 'c']
    const out = reorder(src, 0, 2)
    expect(src).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(src)
  })

  it('长度守恒(任意一对下标)', () => {
    for (let f = 0; f < L.length; f++) {
      for (let t = 0; t < L.length; t++) {
        expect(reorder(L, f, t)).toHaveLength(L.length)
      }
    }
  })
})

// ─── 三条 Tab 条共用一张表 ───

/**
 * 主区、底部面板、右侧面板是**同一张 `tabs` 数组**切出来的三段(见 InnerTabBase.pane)。
 * 下面这一批测的就是「切」和「只动其中一段」这两件事,而它们最容易错的地方
 * 都不在功能上,在**下标语义**上:UI 给的是那一格内的下标,表里存的是全局下标。
 */

const mk = (id: string, pane?: TabPane): InnerTab => ({
  id,
  title: id,
  kind: 'chat',
  ref: { sessionId: `s-${id}` },
  // 刻意用展开而不是 `pane: undefined` —— 要测的正是「字段根本不存在」的那种旧记录
  ...(pane === undefined ? {} : { pane })
})

const ids = (list: readonly InnerTab[]): string[] => list.map((x) => x.id)

/**
 * ★ 缺 `pane` 一律当主区。这不是防御性编程,是**升级路径**:
 * 加 `pane` 字段之前落盘的每一条内层 Tab 都没有它,当成 undefined 处理的话
 * 升级后第一次启动三条 Tab 条会全空。
 */
describe('paneOf', () => {
  it('没有 pane 字段的旧记录算主区', () => {
    expect(paneOf(mk('a'))).toBe('main')
  })

  it('有就用它自己的', () => {
    expect(paneOf(mk('a', 'main'))).toBe('main')
    expect(paneOf(mk('a', 'bottom'))).toBe('bottom')
    expect(paneOf(mk('a', 'right'))).toBe('right')
  })
})

describe('tabsInPane', () => {
  const mixed = [mk('a'), mk('b', 'bottom'), mk('c', 'right'), mk('d', 'bottom'), mk('e', 'main')]

  it('按格切,保持表内的相对顺序', () => {
    expect(ids(tabsInPane(mixed, 'main'))).toEqual(['a', 'e'])
    expect(ids(tabsInPane(mixed, 'bottom'))).toEqual(['b', 'd'])
    expect(ids(tabsInPane(mixed, 'right'))).toEqual(['c'])
  })

  it('三格加起来正好是全表,没有重复也没有漏', () => {
    const all = (['main', 'bottom', 'right'] as const).flatMap((p) => ids(tabsInPane(mixed, p)))
    expect(all.sort()).toEqual(ids(mixed).sort())
  })

  it('空格返回空数组', () => {
    expect(tabsInPane([mk('a')], 'right')).toEqual([])
    expect(tabsInPane([], 'main')).toEqual([])
  })
})

describe('reorderInPane', () => {
  /*
    刻意交错排:三格在全局表里彼此穿插,这样「拿全局数组直接 reorder」
    的错误实现一定会被下面任意一条抓住。
    全局下标:  0:a(main) 1:b(bottom) 2:c(right) 3:d(bottom) 4:e(main) 5:f(bottom)
    bottom 那一格自己看到的是 [b, d, f],占着 1 / 3 / 5 三个坑。
  */
  const mixed = [
    mk('a', 'main'),
    mk('b', 'bottom'),
    mk('c', 'right'),
    mk('d', 'bottom'),
    mk('e', 'main'),
    mk('f', 'bottom')
  ]

  /**
   * ★ 本组最重要的一条:`from` / `to` 是**那一格内的下标**。
   * 把 bottom 的第 0 个拖到第 2 个 —— 全局下标 1 → 5,但调用方只知道 0 → 2。
   */
  it('下标是本格内的,不是全局的', () => {
    const out = reorderInPane(mixed, 'bottom', 0, 2)
    expect(ids(tabsInPane(out, 'bottom'))).toEqual(['d', 'f', 'b'])
  })

  /** ★ 另外两格**一个元素都不许动**,连它们占的全局位置都不变 */
  it('只动本格,另外两格连位置都不变', () => {
    const out = reorderInPane(mixed, 'bottom', 0, 2)
    expect(ids(out)).toEqual(['a', 'd', 'c', 'f', 'e', 'b'])
    expect(out[0]?.id).toBe('a')
    expect(out[2]?.id).toBe('c')
    expect(out[4]?.id).toBe('e')
  })

  it('往前拖同样只影响本格', () => {
    expect(ids(reorderInPane(mixed, 'bottom', 2, 0))).toEqual(['a', 'f', 'c', 'b', 'e', 'd'])
  })

  it('单元素的格怎么拖都不变', () => {
    expect(ids(reorderInPane(mixed, 'right', 0, 3))).toEqual(ids(mixed))
  })

  it('空格不炸', () => {
    const onlyMain = [mk('a'), mk('b')]
    expect(ids(reorderInPane(onlyMain, 'bottom', 0, 1))).toEqual(['a', 'b'])
  })

  /** 缺 pane 的旧记录参与主区的重排,和显式写了 `main` 的混在一起 */
  it('旧记录(无 pane)和显式 main 一起参与主区重排', () => {
    const legacy = [mk('a'), mk('x', 'bottom'), mk('b', 'main'), mk('c')]
    expect(ids(reorderInPane(legacy, 'main', 0, 2))).toEqual(['b', 'x', 'c', 'a'])
  })

  it('长度守恒,且永不原地修改入参', () => {
    const src = [...mixed]
    const out = reorderInPane(src, 'bottom', 0, 2)
    expect(out).toHaveLength(src.length)
    expect(ids(src)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(out).not.toBe(src)
  })

  it('任意一对本格下标都不改变三格的成员归属', () => {
    for (let f = 0; f < 3; f++) {
      for (let to = 0; to < 3; to++) {
        const out = reorderInPane(mixed, 'bottom', f, to)
        expect(ids(tabsInPane(out, 'main')), `${f}→${to}`).toEqual(['a', 'e'])
        expect(ids(tabsInPane(out, 'right')), `${f}→${to}`).toEqual(['c'])
        expect(ids(tabsInPane(out, 'bottom')).sort(), `${f}→${to}`).toEqual(['b', 'd', 'f'])
      }
    }
  })
})
