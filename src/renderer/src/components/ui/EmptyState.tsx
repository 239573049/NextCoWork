import { cn } from '../../lib/cn'

/**
 * 空状态 —— 截图里出现了七八次,形状始终是「淡图标 + 一行主句 + 一行灰副句」
 * (「还没有开始对话」「暂无自定义 MCP 服务器」「没有找到匹配的文件」…)。
 * 副句常常是缺的,所以它是可选的。
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className
}: {
  icon?: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
  className?: string
}): React.ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className
      )}
    >
      {icon !== undefined && <div className="text-fg-faint">{icon}</div>}
      <p className="text-[13px] text-fg-muted">{title}</p>
      {hint !== undefined && <p className="max-w-xs text-[12px] text-fg-faint">{hint}</p>}
      {action}
    </div>
  )
}
