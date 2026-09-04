/**
 * 外层 Tab 的拖动重排 —— 方案 §8「顶部 Tab 可拖动排序」。
 *
 * **用 pointer 事件手写,不引 dnd 库**,理由不是轻量,是这块区域特殊:
 * macOS `titleBarStyle: 'hiddenInset'` 让外层 Tab 条落在
 * `-webkit-app-region: drag` 里,OS 会吞掉该区域的 pointer 事件。
 * 每个 Tab 必须显式 `.app-no-drag`(见 OuterTabBar),而 HTML5 拖放的
 * `dragstart` 在这种半吞半放的区域里行为随 Electron 版本漂移。
 * pointer 事件 + `setPointerCapture` 是可预测的那一条路。
 *
 * ★ **两个方向都支持,默认横向。** 参考图的搜索服务优先级列表是**竖着**拖的,
 * 而外层 Tab 是横着。两套几乎一样的实现摆在仓库里,一定会有一份先修好 bug、
 * 另一份留着 —— 所以在这里加一个 `axis` 参数,把「哪个坐标轴」抽出去,
 * 判定逻辑一份。默认 `'x'` 是为了让 `OuterTabBar` 的行为一个字都不变。
 *
 * 1. **4px 起拖阈值**。没有它,每一次点 Tab 切换都会被算成一次零距离拖动 ——
 *    `reorder(i, i)` 本身是 no-op,但那一趟会把 activeTab 的写入和布局落盘全走一遍。
 * 2. **落点按拖起时的位置快照算,不按实时 DOM 算**。拖动中其它 Tab 正在 translate,
 *    实时 `getBoundingClientRect()` 读到的是动画中间态,判定会来回跳。
 * 3. **监听挂在元素上而不是 document 上**。`setPointerCapture` 之后,后续
 *    pointermove/up 一律派发到捕获元素,所以挂在它身上就够,且天然不会
 *    和别的拖动源打架。cancel 也要收 —— 只写 up 的话,拖到一半系统抢走指针,
 *    这个 Tab 就永久捕获着它。
 */
import { useCallback, useRef, useState } from 'react'

const THRESHOLD_PX = 4

export type DragAxis = 'x' | 'y'

interface DragState {
  /** 被拖的那个的原始下标 */
  index: number
  /** 相对起点的位移(沿 axis 那个方向) */
  dx: number
  /** 此刻松手会落到的下标 */
  over: number
  /** 让位时其它项的位移量:被拖元素的宽(或高)+ 间隙 */
  step: number
}

/** 沿某个轴看一个矩形:起点、长度、中心 */
function along(r: DOMRect, axis: DragAxis): { start: number; size: number; center: number } {
  return axis === 'x'
    ? { start: r.left, size: r.width, center: r.left + r.width / 2 }
    : { start: r.top, size: r.height, center: r.top + r.height / 2 }
}

export interface DragReorder {
  dragging: boolean
  onPointerDown: (e: React.PointerEvent<HTMLElement>, index: number) => void
  styleFor: (index: number) => React.CSSProperties
}

/** 被拖元素的中心落在谁的槽位里,就是谁 */
function slotAt(centers: readonly number[], from: number, center: number): number {
  let i = from
  while (i + 1 < centers.length) {
    const c = centers[i + 1]
    if (c === undefined || center <= c) break
    i += 1
  }
  while (i - 1 >= 0) {
    const c = centers[i - 1]
    if (c === undefined || center >= c) break
    i -= 1
  }
  return i
}

export function useDragReorder(
  onReorder: (from: number, to: number) => void,
  axis: DragAxis = 'x'
): DragReorder {
  const [drag, setDrag] = useState<DragState | null>(null)
  const armed = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, index: number) => {
      if (e.button !== 0) return
      const handle = e.currentTarget
      /*
        ★ **抓手不一定就是被拖的那一项。** 搜索服务那页的抓手是行里的一个
        小把手,`currentTarget` 是它,`parentElement` 是行内那个 flex ——
        照它算几何,快照里躺着的是「把手 / 序号 / 正文 / 开关」四个盒子,
        于是 `step` 是把手到序号的距离、`rects[index]` 从第五行起直接 undefined。
        表现就是拖起来行与行互相压住、中间空出一大块,而且第五行往后拖不动。

        约定用 `data-drag-item` 标出「哪个元素是一项」:标了就按它算,
        没标就还是 `currentTarget`(外层/内层 Tab 条那两处把监听直接挂在项上,
        行为一个字不变)。
      */
      const el = handle.closest<HTMLElement>('[data-drag-item]') ?? handle
      const parent = el.parentElement
      if (parent === null) return

      // ★ 快照:此刻各项沿 axis 的中心与一格的尺寸。之后全程用它判定,不再读 DOM
      const rects = [...parent.children].map((c) => along(c.getBoundingClientRect(), axis))
      const self = rects[index]
      if (self === undefined) return
      const centers = rects.map((r) => r.center)
      const next = rects[index + 1]
      const prev = rects[index - 1]
      const step =
        next !== undefined
          ? next.start - self.start
          : prev !== undefined
            ? self.start - prev.start
            : self.size

      const selfCenter = centers[index]
      if (selfCenter === undefined) return
      const startX = axis === 'x' ? e.clientX : e.clientY
      armed.current = false

      const move = (ev: PointerEvent): void => {
        const dx = (axis === 'x' ? ev.clientX : ev.clientY) - startX
        if (!armed.current) {
          if (Math.abs(dx) < THRESHOLD_PX) return
          armed.current = true
        }
        setDrag({ index, dx, over: slotAt(centers, index, selfCenter + dx), step })
      }

      const done = (ev: PointerEvent): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', done)
        handle.removeEventListener('pointercancel', done)
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
        setDrag(null)
        if (!armed.current) return
        armed.current = false
        // pointercancel 表示这次拖动作废,不应用重排
        if (ev.type === 'pointercancel') return
        const to = slotAt(centers, index, selfCenter + ((axis === 'x' ? ev.clientX : ev.clientY) - startX))
        if (to !== index) onReorder(index, to)
      }

      // 捕获挂在**收到 pointerdown 的那个**元素上 —— 捕获之后
      // 后续 move/up 一律派发到它,所以监听也挂它身上就够
      handle.setPointerCapture(e.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', done)
      handle.addEventListener('pointercancel', done)
    },
    [onReorder, axis]
  )

  const styleFor = useCallback(
    (index: number): React.CSSProperties => {
      if (drag === null) return {}
      const move = (d: number): string => (axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`)
      if (index === drag.index) {
        return {
          transform: move(drag.dx),
          // ★ `position` 不能省 —— `zIndex` 对 static 元素无效,
          // 少了它被拖的那一项会**钻到邻居下面**去
          position: 'relative',
          zIndex: 30,
          transition: 'none',
          cursor: 'grabbing'
        }
      }
      // 让位:被拖的从前往后穿过时,中间那些整体前移一格,反之后移
      let shift = 0
      if (drag.over > drag.index && index > drag.index && index <= drag.over) shift = -drag.step
      else if (drag.over < drag.index && index >= drag.over && index < drag.index) shift = drag.step
      return { transform: move(shift) }
    },
    [drag, axis]
  )

  return { dragging: drag !== null, onPointerDown, styleFor }
}
