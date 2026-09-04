import { cn } from '../../lib/cn'

/**
 * 纯图标按钮。`active` 走的是「挖暗」那一档,悬停走「偏暖」那一档 ——
 * 两个维度分开,所以「悬停在一个已激活的项上」不会互相盖掉。
 *
 * ★ 静息色是 `icon`、激活色是 `accent`,**这两个 token 是分开的**。
 * 一度写成「静息就是 accent」,那是只看深色参考(docs/images)得出的结论:
 * 那一版里 chrome 图标确实全是橙的。但 docs/image-new 那一版量下来,静息图标是
 * 中性灰 #7e7f7e、只有**激活**的才变强调色 —— 量得最干净的一处是外层 Tab 条右侧
 * 那两个面板按钮:「工作区文件」面板打开的那张里,`PanelRight` 是 底 #dbd8d1 +
 * 图标 #2d4739,而同一张里 `PanelBottom` 还是 底 #e8e4dd + 图标 #7e7f7e。
 *
 * 所以语义是:**`icon` = 「这是个可点的东西」,`accent` = 「这个正开着」**。
 * 深色那套两者同值,合并了也看不出来;浅色合并就错。
 */
export function IconButton({
  children,
  label,
  onClick,
  active = false,
  disabled = false,
  size = 28,
  width,
  className,
  title
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  /** 边长(方形)。给了 `width` 时它只当高度用 */
  size?: number
  /**
   * 单独指定宽度 —— 标题栏那条上的开关**不是方的**:量 docs/image-new,
   * 「展开侧边栏」和「工作区文件」两个盒子都是 x 跨 38px、y 跨 28px,
   * 且圆角等于半高(y=13 那一行只剩 x92..117,正是 r=14 的药丸轮廓)。
   * 按方形画出来会比参考窄一圈,和红绿灯也对不齐。
   */
  width?: number
  className?: string
  title?: string
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      style={{ width: width ?? size, height: size }}
      className={cn(
        'app-no-drag flex shrink-0 items-center justify-center rounded-[8px] transition-colors',
        'text-icon hover:bg-tint-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent',
        active && 'bg-surface-sunken text-accent hover:text-accent',
        className
      )}
    >
      {children}
    </button>
  )
}
