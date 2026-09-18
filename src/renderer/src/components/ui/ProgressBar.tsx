import { cn } from '../../lib/cn'

/**
 * 一条进度。**两种形态,一个组件。**
 *
 * ## 「不知道还要多久」不是「0%」
 *
 * 装插件有两段是报不出百分比的:向市场要授权、把包解开写盘。`value: null`
 * 就是这两段 —— 画的是滚动斜纹,不是一条停在 0% 的条子。后者在界面上和
 * 「卡死了」完全分不开,而这两段恰恰是最容易让人以为卡住的地方(它们之间
 * 夹着一段有百分比的下载,前后对比之下,停住的那一格格外显眼)。
 *
 * ## 形状是抄来的,不是新发明的
 *
 * 外层 `overflow-hidden rounded-pill bg-tint` + 内层 `bg-accent transition-[width]`,
 * 同 `ChatView.tsx` 的任务清单、`CompactionDivider.tsx`、`StatusLine.tsx`。
 * 仓库里已经有三处这个写法了 —— 这个组件是把它们的形状收口,不是第四种。
 *
 * ## a11y:indeterminate 就是**不给** aria-valuenow
 *
 * 这是 ARIA 规范里表达「不确定」的方式,不是漏写。给一个 0 的话,读屏会念
 * 「0%」——那是一句确切的假话。两种形态都给 `aria-valuetext`,因为用户真正
 * 要听的是「正在下载 63%」这句话,不是一个孤零零的数。
 */
export function ProgressBar({
  value,
  label,
  className
}: {
  /** 0..1;`null` = 不确定(画滚动斜纹) */
  value: number | null
  /** 读屏念的那句话,同时也是这条进度当前在做什么 */
  label: string
  className?: string
}): React.ReactNode {
  // ★ clamp 是必需的:`total` 来自 content-length,而服务端哪天上了 gzip,
  //   它报的就是压缩后的大小 —— 百分比会冲破 100,条子溢出圆角。
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
      aria-valuetext={label}
      className={cn('h-1.5 overflow-hidden rounded-pill bg-tint', className)}
    >
      {percent === null ? (
        <span aria-hidden className="progress-stripes block h-full w-full rounded-pill bg-accent/20" />
      ) : (
        <span
          aria-hidden
          className="block h-full rounded-pill bg-accent transition-[width] duration-200"
          style={{ width: `${String(percent)}%` }}
        />
      )}
    </div>
  )
}
