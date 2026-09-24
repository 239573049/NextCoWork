/**
 * 「收着没人碰,过一阵就缩成一颗小球」的计时逻辑。
 *
 * 需求:输入框上方那条任务清单即使收起,也仍占着正文和输入框之间一整行;
 * 用户已经不看它时,它应该自己让出这一行,缩到最左边只留一颗进度球,点一下再恢复。
 *
 * 不变式:**只有「收起 + 没被指着 + 没被键盘聚焦」持续满 `afterMs` 才缩**。
 * 任何一个条件被打破都会清掉计时器,条件恢复后从头计 —— 所以「操作」就是这三件事的变化,
 * 不需要另外一个活动计数器。
 *
 * 故意不做的事:
 * - 清单内容更新(TodoWrite 落地)**不会**把小球弹回来。小球本身画着进度环和完成数,
 *   进度照样看得见;每次更新都弹开会让它在一次运行里反复伸缩,比不缩更吵。
 * - 鼠标点击留下的焦点不算「在用」。Chromium 点按钮会把焦点留在按钮上,
 *   若把它也算进去,用户点完收起、鼠标移走后它永远不会缩 —— 表现为「功能时灵时不灵」。
 *   只有 `:focus-visible`(键盘过来的焦点)才暂停,键盘用户的焦点不会被凭空抽走。
 */
import { useCallback, useEffect, useState, type FocusEvent } from 'react'

export type IdleMinimizeBindings = {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: (event: FocusEvent<HTMLElement>) => void
}

export function useIdleMinimize({
  enabled,
  afterMs
}: {
  /** 此刻是否允许缩(调用方传「列表是收起的」);展开态绝不缩。 */
  enabled: boolean
  /** 连续无操作多久后缩成小球。 */
  afterMs: number
}): { minimized: boolean; restore: () => void; bindings: IdleMinimizeBindings } {
  const [minimized, setMinimized] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)

  useEffect(() => {
    if (!enabled || minimized || hovered || keyboardFocused) return
    const timer = window.setTimeout(() => setMinimized(true), afterMs)
    return () => window.clearTimeout(timer)
  }, [enabled, minimized, hovered, keyboardFocused, afterMs])

  /*
    ★ 恢复时把 hovered / keyboardFocused 一并归零:卡片缩走时被卸载,
    它的 pointerleave / blur 不会再触发。不归零的话,上一次残留的 `true`
    会让计时器永远不起 —— 表现为点开一次之后再也不会自动缩。
  */
  const restore = useCallback(() => {
    setHovered(false)
    setKeyboardFocused(false)
    setMinimized(false)
  }, [])

  const bindings: IdleMinimizeBindings = {
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onFocus: (event) => setKeyboardFocused(event.target.matches(':focus-visible')),
    onBlur: (event) => {
      // 焦点只是在卡片内部换了个元素,不算离开
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) return
      setKeyboardFocused(false)
    }
  }

  return { minimized, restore, bindings }
}
