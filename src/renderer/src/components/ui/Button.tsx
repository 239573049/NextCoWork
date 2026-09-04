import { cn } from '../../lib/cn'

/**
 * 文字按钮。仓库里在此之前只有 `IconButton` —— 设置浮层右下角那颗「完成」
 * 是第一个需要它的地方(量自 06cd7b3c:x1012..1077、h≈34、`rounded-pill`、
 * 底色 accent)。
 *
 * 三档而不是一档:「完成」是主动作(accent),「优化存储」是中性动作(ghost),
 * 「清空数据」这类是危险动作(danger)。三者共用同一个盒子,只有配色不同 ——
 * 分成三个组件的话,某一天改高度就会改漏一个。
 */
export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  icon,
  disabled = false,
  className
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'accent' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: React.ReactNode
  disabled?: boolean
  className?: string
}): React.ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'app-no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-pill',
        'whitespace-nowrap transition-colors disabled:opacity-40',
        size === 'sm' ? 'h-7 px-3 text-[12px]' : 'h-[34px] px-4 text-[13px]',
        variant === 'accent' && 'bg-accent text-accent-fg hover:opacity-90',
        // ghost 的静息态是「槽」,悬停往暖里偏 —— 和 theme.css 那条规律一致
        variant === 'ghost' && 'bg-tint text-fg hover:bg-tint-strong',
        variant === 'danger' && 'border border-danger text-danger hover:bg-danger/10',
        className
      )}
    >
      {icon !== undefined && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  )
}
