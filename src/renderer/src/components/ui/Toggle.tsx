import { cn } from '../../lib/cn'

/** 设置页每一行右侧那个开关。开 = 橙,关 = 暖灰槽。 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'app-no-drag relative h-[22px] w-[38px] shrink-0 rounded-pill transition-colors',
        'disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-tint'
      )}
    >
      <span
        className={cn(
          'absolute top-[3px] h-4 w-4 rounded-pill bg-white transition-[left] duration-150',
          checked ? 'left-[19px]' : 'left-[3px]'
        )}
      />
    </button>
  )
}
