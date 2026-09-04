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
 * 三个不显然的点:
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

interface DragState {
  /** 被拖的那个的原始下标 */
  index: number
  /** 相对起点的水平位移 */
  dx: number
  /** 此刻松手会落到的下标 */
  over: number
  /** 让位时其它 Tab 的位移量:被拖元素的宽 + 间隙 */
  step: number
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

export function useDragReorder(onReorder: (from: number, to: number) => void): DragReorder {
  const [drag, setDrag] = useState<DragState | null>(null)
  const armed = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, index: number) => {
      if (e.button !== 0) return
      const el = e.currentTarget
      const parent = el.parentElement
      if (parent === null) return

      // ★ 快照:此刻各 Tab 的中心 x 与一格的宽度。之后全程用它判定,不再读 DOM
      const rects = [...parent.children].map((c) => c.getBoundingClientRect())
      const self = rects[index]
      if (self === undefined) return
      const centers = rects.map((r) => r.left + r.width / 2)
      const next = rects[index + 1]
      const prev = rects[index - 1]
      const step =
        next !== undefined
          ? next.left - self.left
          : prev !== undefined
            ? self.left - prev.left
            : self.width

      const selfCenter = centers[index]
      if (selfCenter === undefined) return
      const startX = e.clientX
      armed.current = false

      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        if (!armed.current) {
          if (Math.abs(dx) < THRESHOLD_PX) return
          armed.current = true
        }
        setDrag({ index, dx, over: slotAt(centers, index, selfCenter + dx), step })
      }

      const done = (ev: PointerEvent): void => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', done)
        el.removeEventListener('pointercancel', done)
        if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
        setDrag(null)
        if (!armed.current) return
        armed.current = false
        // pointercancel 表示这次拖动作废,不应用重排
        if (ev.type === 'pointercancel') return
        const to = slotAt(centers, index, selfCenter + (ev.clientX - startX))
        if (to !== index) onReorder(index, to)
      }

      el.setPointerCapture(e.pointerId)
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', done)
      el.addEventListener('pointercancel', done)
    },
    [onReorder]
  )

  const styleFor = useCallback(
    (index: number): React.CSSProperties => {
      if (drag === null) return {}
      if (index === drag.index) {
        return {
          transform: `translateX(${drag.dx}px)`,
          zIndex: 30,
          transition: 'none',
          cursor: 'grabbing'
        }
      }
      // 让位:被拖的从左往右穿过时,中间那些整体左移一格,反之右移
      let shift = 0
      if (drag.over > drag.index && index > drag.index && index <= drag.over) shift = -drag.step
      else if (drag.over < drag.index && index >= drag.over && index < drag.index) shift = drag.step
      return { transform: `translateX(${shift}px)` }
    },
    [drag]
  )

  return { dragging: drag !== null, onPointerDown, styleFor }
}
