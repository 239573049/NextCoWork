/**
 * 忙碌指示器。
 *
 * ★★ **这个组件收口的不是样式,是一个可访问性缺陷。**
 *
 * 改造前全仓库有 47 处 `className="animate-spin"`,其中**只有 8 处**写了
 * `motion-reduce:animate-none`。也就是说勾了「减弱动态效果」的用户,在设置页、
 * 文件树、导入向导、标签页里仍然会看到 39 个转个不停的圈 —— 前庭敏感的人对
 * 旋转最敏感,而这恰恰是全应用出现频率最高的一种动画。
 *
 * 顺带修掉两个一致性问题:
 *
 * - **图标名混用。** 40 处 `Loader2`、24 处 `LoaderCircle` —— 这俩在 lucide 里
 *   是同一个字形,`Loader2` 是已废弃的别名。谁都没写错,但它让「搜一下哪里有
 *   loading」这件事必须搜两个词。
 * - **尺寸散落。** 11/12/13/14/15/20 六种,没有规律可循,同一个对话框里
 *   经常出现两种。这里收成三档。
 *
 * ## 减弱动态效果时**不是**直接静止
 *
 * 直接停下会把「正在忙」这个信息一起删掉 —— 用户看到的是一个卡住的圈,
 * 分不清是在转还是崩了。所以降级成**不透明度呼吸**:它不含旋转、不含位移,
 * 不触发前庭反应,但仍然在说「这里还活着」。只有明确选了「关闭动效」的那一档
 * 才真的静止 —— 那是用户直说了「我什么都不要」。
 *
 * ★ 呼吸用 Motion 而不是 CSS 动画:`theme.css` 里 `animation-duration: 0ms
 *   !important` 会把 reduced/off 两档的**所有** CSS 动画压成 0,包括这个呼吸。
 *   (那条规则是对的 —— 它的前提是「CSS 动画都是装饰性的」。这里是个例外:
 *   呼吸本身就是降级方案,不能再被降一次。)
 */
import { LoaderCircle } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { useMotionLevel } from '../../theme/useMotionLevel'

/**
 * 三档尺寸。数字是 lucide 的 `size`:
 *   xs 11 —— 标签页标题旁、列表行内联,不能把行高撑开
 *   sm 13 —— 按钮里替换图标位的那个,和 `Button` 的图标同尺寸
 *   md 20 —— 空状态/整块占位的居中指示器
 */
const SIZE = { xs: 11, sm: 13, md: 20 } as const

export function Spinner({
  size = 'sm',
  label,
  className
}: {
  size?: keyof typeof SIZE
  /**
   * 屏幕阅读器念出来的状态。**只在这个圈是页面上唯一的忙碌提示时才给** ——
   * 按钮内联的那种不要给:按钮本身已经有 `aria-label` 了,再加一个
   * `role="status"` 会让同一件事被念两遍。
   */
  label?: string
  className?: string
}): ReactNode {
  const level = useMotionLevel()
  const px = SIZE[size]

  const a11y =
    label !== undefined
      ? ({ role: 'status' as const, 'aria-label': label })
      : ({ 'aria-hidden': true })

  if (level === 'off') {
    return <LoaderCircle {...a11y} size={px} className={cn('shrink-0', className)} />
  }

  if (level === 'reduced') {
    return (
      <motion.span
        {...a11y}
        className={cn('inline-flex shrink-0', className)}
        animate={{ opacity: [1, 0.4, 1] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <LoaderCircle size={px} />
      </motion.span>
    )
  }

  return (
    <motion.span
      {...a11y}
      className={cn('inline-flex shrink-0', className)}
      animate={{ rotate: 360 }}
      // `ease: 'linear'` + `repeat: Infinity` —— 匀速。带缓动的旋转会在每圈
      // 接缝处顿一下,一排里同时转着五个的时候尤其明显。
      // `soft` 那一档转得慢一点,和它「柔一点」的语义一致。
      transition={{ duration: level === 'soft' ? 1.4 : 1, repeat: Infinity, ease: 'linear' }}
    >
      <LoaderCircle size={px} />
    </motion.span>
  )
}
