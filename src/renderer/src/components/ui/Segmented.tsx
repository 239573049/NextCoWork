/**
 * 分段控件 —— 设置页里出现了 2/3/4/8 路四种(权限模式、资源模式、重复类型、
 * 思考模式「自动|极低|低|中|高|超高|最高|关闭」)。8 路那个决定了尺寸:
 * 一行要塞得下八个中文词,所以 `sm` 的内边距压得很紧。
 *
 * 配色是 theme.css 里那条规律的最直接体现:**槽是暖的(tint),选中项是暗的
 * (surface-sunken)** —— 选中不是被点亮,是被挖下去。
 *
 * ★ **选中态是一块会滑的指示器,不是挂在按钮上的背景。** 切换时那块「挖下去」
 * 的凹槽从旧项滑到新项,而不是原地闪一下。代价是得测量:各项标签是中文,宽度
 * 天差地别(「自动」vs「最高」还好,`ModelPage` 那种就不一定),没法靠 `1/N`
 * 百分比推位置,只能读选中按钮的 `offsetLeft/offsetWidth`。
 *
 * 测量的三个坑,分别对应下面三段代码:
 * 1. **首帧不能有动画** —— 否则每次挂载都会看到指示器从最左边滑进来。所以先
 *    量、再放开过渡(`ready`)。
 * 2. **量在 `useLayoutEffect` 里** —— 浏览器绘制前同步跑完,首帧就是对的位置,
 *    不会闪。用 `useEffect` 会先画一帧错的。
 * 3. **容器尺寸会变** —— 设置浮层未打开时整棵子树是 `display:none`,量出来全是
 *    0;字体加载完宽度也会变。`ResizeObserver` 兜住这两种,并且宽度为 0 时不
 *    置 `ready`,免得浮层一打开指示器从 0 展开一次。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  label,
  disabled = false
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
  label?: string
  disabled?: boolean
}): React.ReactNode {
  const slotRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef(new Map<T, HTMLButtonElement>())
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = btnRefs.current.get(value)
      // 量不到(value 不在 options 里)就收起指示器,别停在上一个位置骗人
      if (!el) return setRect(null)
      setRect({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()

    const slot = slotRef.current
    if (!slot) return
    const ro = new ResizeObserver(measure)
    ro.observe(slot)
    return () => ro.disconnect()
  }, [value, options])

  // 有了第一个**非零**的位置之后才放开过渡 —— 见文件头第 1、3 条
  useEffect(() => {
    if (!ready && rect && rect.width > 0) setReady(true)
  }, [ready, rect])

  return (
    <div
      ref={slotRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('relative inline-flex rounded-[9px] bg-tint p-[3px]', className)}
    >
      {rect && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-[3px] bottom-[3px] left-0 rounded-[7px]',
            'bg-surface-sunken shadow-sm shadow-black/20',
            // 首帧、以及 prefers-reduced-motion 下不滑,直接到位
            ready && 'transition-[transform,width] duration-200 ease-out motion-reduce:transition-none'
          )}
          style={{ transform: `translateX(${rect.left}px)`, width: rect.width }}
        />
      )}
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            ref={(el) => {
              if (el) btnRefs.current.set(o.value, el)
              else btnRefs.current.delete(o.value)
            }}
            className={cn(
              // z-10:压在指示器上面,否则文字被那块凹槽盖住
              'app-no-drag relative z-10 rounded-[7px] whitespace-nowrap transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]',
              disabled
                ? 'cursor-not-allowed text-fg-faint'
                : on
                  ? 'text-fg'
                  : 'text-fg-muted hover:text-fg'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
