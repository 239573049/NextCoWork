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
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'

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
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

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
          id={panelId}
          role="menu"
          style={{ width }}
          className={cn(
            'app-no-drag absolute top-full z-50 mt-1.5 overflow-hidden rounded-card',
            'border border-border bg-surface-raised p-1 shadow-2xl shadow-black/40',
            align === 'start' ? 'left-0' : 'right-0'
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
