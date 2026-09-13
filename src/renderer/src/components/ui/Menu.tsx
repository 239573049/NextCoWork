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
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  // ★ 必须起别名:下面 `onKey` 收的是 **DOM** 的 KeyboardEvent(document 上的监听),
  //   同名导入会把它整个遮住,报错还指在那一行,和这里看不出关系。
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import { usePresence } from '../../lib/usePresence'
import { placeMenu, type Placement } from './menu-position'

const MENU_MS = 180

export function Menu({
  trigger,
  children,
  align = 'start',
  width = 240,
  label,
  className,
  triggerClassName,
  panelClassName,
  disabled = false,
  onOpenChange,
  onTriggerDoubleClick,
  onTriggerKeyDown,
  containsTarget
}: {
  /** 触发按钮的**内容**;按钮本身由 Menu 渲染,免得每个调用点重复写 no-drag */
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  width?: number
  label: string
  className?: string
  triggerClassName?: string
  panelClassName?: string
  disabled?: boolean
  /** 在菜单打开/关闭时通知调用方，用于重置多级菜单的临时视图状态。 */
  onOpenChange?: (open: boolean) => void
  /**
   * 触发器上的双击 —— **只为上下文圆环存在**,不是一项可以随便加在任何菜单上的通用能力。
   *
   * 那个圆环在升级成菜单之前,双击就是「立刻压缩」,而这条肌肉记忆不该被拿走。
   * 但触发按钮每次 click 都 toggle,第二下会把刚开的面板又关上,看起来是闪一下。
   * 所以这里用 `e.detail >= 2`(浏览器给的点击计数,第二次 click 上它是 2)在
   * `onClick` 里短路 —— **不做延时消歧**,那要给每一次打开菜单都加 200ms,
   * 代价落在常用路径上,而受益的只有一个调用点。
   */
  onTriggerDoubleClick?: () => void
  /**
   * 触发器上的键盘事件 —— 和上面那条一样,是**为某个具体调用点开的口**,不是通用能力。
   *
   * 思考强度那颗药丸用它做「聚焦后 ↑/↓ 直接换一档,面板根本不用打开」。
   * 那颗药丸存在的全部理由就是把「改一个每轮都要动的旋钮」从四步压到一步,
   * 而「Tab 过去 → Enter 开面板 → 操作 → Esc」仍然是四步。
   *
   * ★ Menu **只转发,不解释** —— 它不知道哪些键有意义,也就不该替调用方
   * `preventDefault`。Enter / Space 是 button 打开菜单的原生路径,
   * 调用方在这里拦下它们就等于把菜单关死了,这是唯一需要自律的一条。
   */
  onTriggerKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
  /** 允许通过 portal 渲染的二级菜单参与“点击外部关闭”判断。 */
  containsTarget?: (target: Node) => boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Placement | null>(null)
  const presence = usePresence(open, MENU_MS)
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
    // Keep the last placement while the closing transition runs. Clearing it on
    // close would animate the panel back at (0, 0) instead of at its trigger.
    if (!open || !presence.mounted) return
    const measure = (): void => {
      const t = triggerRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (t === undefined || panel === null) return
      /*
        ★ 量 `scrollHeight` 而不是 `offsetHeight`。后者在限高之后就等于 maxHeight,
        于是「面板多高」和「该给多少高」互为因果,滚动时会一路收缩到最小值。
        scrollHeight 始终是内容的真实高度,不受我们自己设的 maxHeight 影响。
      */
      /*
        ★ 菜单该被哪块面夹住,由**那块面自己声明**(`data-menu-bounds`),
        不在这里按调用点写 if。壳层那几个菜单(外层 Tab / 输入框)的边界本来
        就是视口,声明不声明都对;而设置浮层里的必须夹在内容列里,
        否则 280px 的面板右对齐到一颗窄药丸上就会盖到左边的导航去。
        找不到就退回视口 —— 新加的调用点不会因为忘了声明而错位。
      */
      const box = triggerRef.current?.closest('[data-menu-bounds]')?.getBoundingClientRect()
      setPos(
        placeMenu(
          t,
          panel.scrollHeight,
          width,
          align,
          { width: window.innerWidth, height: window.innerHeight },
          box
        )
      )
    }
    measure()
    // 多级菜单切换视图时内容高度会变化；观察面板尺寸，保持向上翻转和底部对齐准确。
    const resizeObserver = new ResizeObserver(measure)
    if (panelRef.current !== null) resizeObserver.observe(panelRef.current)
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
      resizeObserver.disconnect()
    }
  }, [open, presence.mounted, width, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!wrapRef.current?.contains(target) && !containsTarget?.(target)) {
        setOpen(false)
        onOpenChange?.(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // ★ 宣告这次 Escape 被消费掉了。设置浮层也在 document 上等 Escape,
      // 不标记的话「在设置里打开模型选择器再按 Esc」会**同时**关掉菜单和整个面板。
      e.preventDefault()
      setOpen(false)
      onOpenChange?.(false)
    }
    // capture:面板里的控件可能 stopPropagation,冒泡阶段会漏掉外部点击
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange, containsTarget])

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
        onKeyDown={onTriggerKeyDown}
        onClick={(e) => {
          // 第二下点击:交给双击处理,面板保持当前状态(第一下已经把它打开了)。
          if (onTriggerDoubleClick !== undefined && e.detail >= 2) {
            onTriggerDoubleClick()
            return
          }
          const next = !open
          if (next) setPos(null)
          setOpen(next)
          onOpenChange?.(next)
        }}
        className={cn('app-no-drag disabled:opacity-40', triggerClassName)}
      >
        {trigger}
      </button>

      {presence.mounted && (
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
            'border border-border bg-surface-raised p-1 shadow-2xl shadow-black/40',
            'transition-[opacity,transform,translate,scale] duration-180 ease-panel motion-reduce:transition-none motion-reduce:transform-none motion-reduce:translate-y-0 motion-reduce:scale-100',
            presence.shown
              ? 'translate-y-0 scale-100 opacity-100'
              : 'pointer-events-none translate-y-1 scale-[.98] opacity-0',
            panelClassName
          )}
        >
          {children(() => {
            setOpen(false)
            onOpenChange?.(false)
          })}
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
  buttonRef,
  onHover,
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
  buttonRef?: Ref<HTMLButtonElement>
  onHover?: () => void
  onSelect: () => void
}): ReactNode {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      disabled={disabled}
      onPointerEnter={onHover}
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
