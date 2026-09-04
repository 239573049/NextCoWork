/**
 * 分段控件 —— 设置页里出现了 2/3/4/8 路四种(权限模式、资源模式、重复类型、
 * 思考模式「自动|极低|低|中|高|超高|最高|关闭」)。8 路那个决定了尺寸:
 * 一行要塞得下八个中文词,所以 `sm` 的内边距压得很紧。
 *
 * 配色是 theme.css 里那条规律的最直接体现:**槽是暖的(tint),选中项是暗的
 * (surface-sunken)** —— 选中不是被点亮,是被挖下去。
 */
import { cn } from '../../lib/cn'

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  label
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
  label?: string
}): React.ReactNode {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-[9px] bg-tint p-[3px]', className)}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'app-no-drag rounded-[7px] whitespace-nowrap transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]',
              on
                ? 'bg-surface-sunken text-fg shadow-sm shadow-black/20'
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
