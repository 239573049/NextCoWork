import { useEffect, type RefObject } from 'react'

/**
 * 模态浮层的焦点处理:进入时把焦点收进面板、Tab 在面板内环绕、关闭时还回去。
 *
 * 不做的话有两处肉眼可见的坏:Tab 会走出模态,在遮罩底下点亮一圈焦点环
 * (桌面应用上这看着就是坏了);关掉之后焦点掉在 body 上,再按 Tab 会从
 * 侧边栏第一项重新开始。
 *
 * 单独成文件而不是写进 `SettingsOverlay`:`Dialog.tsx`(添加 MCP 服务器那个弹窗)
 * 已经在用同一套,步骤 5 的权限审批弹窗也要用。它因此从 `settings/` 搬到了
 * `components/ui/` —— 住在 settings 里的东西被 components 反向 import,
 * 下一个人会以为那是个疏漏。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  /** 打开时先聚焦到哪(设置浮层给搜索框 —— 打开就能直接打字过滤) */
  initial?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (root === null) return

    // 归还目标要在移动焦点**之前**存,否则存到的是我们自己刚聚焦的那个元素
    const previous = document.activeElement as HTMLElement | null
    ;(initial?.current ?? root).focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      // 焦点已经跑到面板外(比如上一次渲染把它挤掉了)也拉回来
      if (!root.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      previous?.focus?.({ preventScroll: true })
    }
  }, [ref, active, initial])
}
