/**
 * 浮层菜单 —— 截图里出现了五处,形状完全一样:工作区下拉(3de216d8)、内层 Tab 的
 * `+` 菜单(7674f2f5)、权限档位(fe1554f3)、模型选择器(348b43e1)、
 * 输入框的 `+` 菜单(08254887)。所以它值得一个组件,而不是抄五遍。
 *
 * **不用 radix 的 DropdownMenu**,一个具体理由:外层 Tab 条落在
 * `-webkit-app-region: drag` 区里,菜单面板和触发器都必须显式 `.app-no-drag`,
 * 而 radix 把面板 portal 到 body 下、类名由我们够不着的地方生成。
 * 自己写的这版只有 60 行,且 `.app-no-drag` 就在手边。
 *
 * 关闭时机三条:面板外 pointerdown、Esc、选中某一项。第三条由 `onSelect` 自动做 ——
 * 每个调用点自己记得 close() 的话,总有一处会忘。
 *
 * ## 面板是 `position: fixed`,不是 `absolute`(方案 §7 第 1 条)
 *
 * 原来是 `absolute top-full`,于是任何一个 `overflow` 祖先都会把它**裁掉半截** ——
 * 设置浮层的内容区正是 `overflow-y-auto`,而模型页会长到需要滚动。
 * 现在改成脱离文档流、由触发器的 `getBoundingClientRect()` 定位,
 * 空间不够就向上翻;落点算法在 `menu-position.ts`(纯函数,那边有测试)。
 *
 * ⚠️ **`fixed` 能对齐视口有个前提:祖先里不能有 `transform` / `filter` /
 * `backdrop-filter` / `will-change` / `contain`** —— 有的话它会退化成相对那个祖先定位,
 * 而我们喂进去的是视口坐标,面板会跑到离触发器很远的地方。
 * 改这条的成本落在别处:给设置浮层加一个 `scale` 入场动画就会让五处菜单一起错位。
 * 当前五个调用点(外层 Tab / 内层 Tab / 权限档位 / 模型选择器 / 文件视图)的
 * 祖先链上都没有,唯一的 `backdrop-blur` 在遮罩上,而遮罩是内容的**兄弟**。
 *
 * 仍然**不 portal** —— 上面那条 `.app-no-drag` 的理由没变,而 `fixed` 已经够用了。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import { placeMenu, type Placement } from './menu-position'

export function Menu({
  trigger,
  children,
  align = 'start',
  width = 240,
  label,
  className,
  triggerClassName,
  disabled = false
}: {
  /** 触发按钮的**内容**;按钮本身由 Menu 渲染,免得每个调用点重复写 no-drag */
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  width?: number
  label: string
  className?: string
  triggerClassName?: string
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Placement | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  /*
    ★ `useLayoutEffect` 而不是 `useEffect`:它在**浏览器绘制之前**跑完,
    所以「先渲染出来量高度、再挪到正确位置」这两步用户看不到。
    用 useEffect 的话面板会在左上角闪一帧。
  */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const measure = (): void => {
      const t = triggerRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (t === undefined || panel === null) return
      /*
        ★ 量 `scrollHeight` 而不是 `offsetHeight`。后者在限高之后就等于 maxHeight,
        于是「面板多高」和「该给多少高」互为因果,滚动时会一路收缩到最小值。
        scrollHeight 始终是内容的真实高度,不受我们自己设的 maxHeight 影响。
      */
      setPos(
        placeMenu(t, panel.scrollHeight, width, align, {
          width: window.innerWidth,
          height: window.innerHeight
        })
      )
    }
    measure()
    /*
      脱离了文档流就不会跟着滚动容器走,所以得自己跟。
      scroll 用 capture —— 真正在滚的是设置浮层的内容区,不是 window,
      而 scroll 事件不冒泡到 document,只有捕获阶段抓得到。
    */
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  }, [open, width, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // ★ 宣告这次 Escape 被消费掉了。设置浮层也在 document 上等 Escape,
      // 不标记的话「在设置里打开模型选择器再按 Esc」会**同时**关掉菜单和整个面板。
      e.preventDefault()
      setOpen(false)
    }
    // capture:面板里的控件可能 stopPropagation,冒泡阶段会漏掉外部点击
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className={cn('relative flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn('app-no-drag disabled:opacity-40', triggerClassName)}
      >
        {trigger}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          style={{
            width,
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            maxHeight: pos?.maxHeight,
            // 还没量到高度的那一帧:先渲染出来(否则量不到),但别让人看见
            visibility: pos === null ? 'hidden' : undefined
          }}
          className={cn(
            'app-no-drag scroll-thin fixed z-50 overflow-y-auto rounded-card',
            'border border-border bg-surface-raised p-1 shadow-2xl shadow-black/40'
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  children,
  icon,
  accelerator,
  description,
  checked,
  danger = false,
  disabled = false,
  onSelect
}: {
  children: ReactNode
  icon?: ReactNode
  accelerator?: string
  description?: string
  /** undefined = 这一项不参与勾选;false 时仍占位,免得勾上勾下整列跳动 */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13px]',
        'transition-colors hover:bg-tint-strong disabled:opacity-40 disabled:hover:bg-transparent',
        danger ? 'text-danger' : 'text-fg'
      )}
    >
      {icon !== undefined && (
        <span className={cn('shrink-0', danger ? 'text-danger' : 'text-accent-soft')}>{icon}</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description !== undefined && (
          <span className="mt-0.5 block truncate text-[11px] text-fg-faint">{description}</span>
        )}
      </span>
      {accelerator !== undefined && (
        <kbd className="shrink-0 font-sans text-[11px] text-fg-faint">{accelerator}</kbd>
      )}
      {checked !== undefined && (
        <Check size={14} className={cn('shrink-0 text-accent', !checked && 'invisible')} />
      )}
    </button>
  )
}

export function MenuSeparator(): ReactNode {
  return <div role="separator" className="my-1 h-px bg-border" />
}

export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-2.5 pt-2 pb-1 text-[11px] text-fg-faint">{children}</div>
}
