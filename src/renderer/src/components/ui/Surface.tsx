/**
 * 转录流里所有「块」共用的那一个盒子。
 *
 * ★★ **为什么要有这个文件。** 改造之前,聊天流里并排堆着七套各写各的卡片配方:
 *
 *     ThinkingBlock       rounded-card bg-surface-raised/60          ← 没有描边
 *     ToolCallCard        rounded-card border border-border …/60
 *     SubagentNode        rounded-card border border-border …/40     ← 底色又差一档
 *     SubagentReportRow   rounded-card border-dashed border-accent/35
 *     WorkspaceBlock      rounded-card border border-border …/40
 *     PlanPanel           rounded-card border border-border bg-surface-raised(不透明)
 *     CompactionDivider   rounded-card border border-hairline …/40
 *
 * 七套里有三种底色不透明度、三种描边、两种「有没有描边」。单看每一张都说得过去,
 * 可它们是**上下紧挨着出现的** —— 一屏里「深度思考」是平的、命令卡是描边的、
 * 子代理卡又浅一档,读起来就是「这个界面有点乱」,而没有任何一条单独的规则写错了。
 * 这正是那种不会有人当 bug 报、却谁都看得见的问题。
 *
 * 所以收敛成两个轴,别的都不给:
 *
 *     tone   default | accent | danger    —— 这张卡**是什么性质**
 *     rail   accent  | danger  | 无        —— 左侧竖条,一个正交的强调位
 *
 * 密度、圆角、底色不透明度不开放为参数。要的就是它们在所有调用点上一模一样;
 * 开一个口子,半年后就会长回七套。
 *
 * ★ 描边一律走 `border-stroke` 而**不是** `border-border` —— 那是两个 token,
 *   区别不在颜色而在「谁会改它」,`theme.css` 里 `--color-stroke` 那段有完整说明。
 *   一句话:`border` 受可读性护栏保护(输入框轮廓要够 3:1),卡片描边跟着它走的话,
 *   护栏一开每张卡就都镶上一圈中灰实线。
 */
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { motionScale, useMotionLevel } from '../../theme/useMotionLevel'

export type SurfaceTone = 'default' | 'accent' | 'danger'
export type SurfaceRail = 'accent' | 'danger'

/**
 * 三种性质各自的底色与描边。
 *
 * 底色统一压到 `/55`:转录区在图片主题下是**透明的**(见 `theme.css` 里
 * `.app-canvas::before` 那段 —— 壁纸就铺在这一层),实心底色会把壁纸整块挡掉。
 * 半透明让卡片浮在图上,同时在没有壁纸时和 `bg-surface-raised` 拉开一点层次。
 */
const TONE: Record<SurfaceTone, string> = {
  default: 'border-stroke bg-surface-raised/55',
  accent: 'border-accent/25 bg-accent/[0.045]',
  danger: 'border-danger/35 bg-danger/[0.05]'
}

/**
 * 左侧竖条。
 *
 * ★ 统一用 `border-l-2`,不用「flex 里塞一个 `w-[2px]` 的 span」——
 *   后者要求外层必须是 flex,于是每个想要竖条的卡片都得为它改结构。
 *   改造前 ToolCallCard 用的是 span、SubagentNode 用的是 border-l,
 *   同一个视觉语言两套实现,正是上面那份清单的缩影。
 */
const RAIL: Record<SurfaceRail, string> = {
  accent: 'border-l-2 border-l-accent/70',
  danger: 'border-l-2 border-l-danger'
}

export function Surface({
  tone = 'default',
  rail,
  dashed = false,
  className,
  children,
  ...rest
}: {
  tone?: SurfaceTone
  rail?: SurfaceRail | undefined
  /** 只给「这不是一张真的卡片,是一条回执」这类用 —— 目前只有后台子代理的汇报行 */
  dashed?: boolean
  className?: string
  children: ReactNode
  // React 19 起 `ref` 就是一个普通 prop,跟着 `...rest` 一起落到 div 上 ——
  // 所以这里要用 `WithRef` 而不是 `WithoutRef`,否则 WorkspaceBlock 那个
  // 滚动定位用的 ref 会在类型上被挡掉。
} & React.ComponentPropsWithRef<'div'>): ReactNode {
  return (
    <div
      {...rest}
      className={cn(
        'overflow-hidden rounded-card border',
        // 描边和底色的过渡:工具从 running 变 error 时整张卡换 tone,
        // 硬切会在一屏十几行里显得「闪了一下」
        'transition-[background-color,border-color] duration-200',
        TONE[tone],
        dashed && 'border-dashed',
        rail !== undefined && RAIL[rail],
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * 卡片**内部**的次级行(运行状态、错误摘要、汇报状态那几条)。
 *
 * 分隔线走 `hairline` 而不是 `stroke` —— 前者是「一张卡里面的横线」,
 * 后者是「一张卡的外轮廓」,两者在设计上本来就差一档亮度。
 */
export function SurfaceRow({
  className,
  children,
  ...rest
}: {
  className?: string
  children: ReactNode
} & React.ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...rest}
      className={cn(
        'flex items-center gap-2 border-t border-hairline px-3 py-2 text-[11.5px]',
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * 卡片的展开区(工具详情、思考正文、汇报全文)。
 *
 * ★★ **这是这次「加动效」里唯一真正需要 Motion 的地方。**
 * 展开区的高度是内容决定的,事先不知道 —— CSS 没法从 0 过渡到一个未知值。
 * (`grid-template-rows: 0fr → 1fr` 那个技巧能做到,但它在内容里有
 * `overflow` 或绝对定位时会裁错,而这里装的是 Markdown 和 diff。)
 * Motion 的 `height: 'auto'` 会在每次动画前实测目标高度,这正是它存在的理由。
 *
 * ★ `AnimatePresence` 收着退场动画:不套它的话 `{open && …}` 一旦转 false,
 *   React 当场卸载,收起是硬切 —— 展开有动画、收起没有,比两边都没有更难受。
 *
 * ★ padding 挂在**内层**。挂外层的话 `height: 0` 仍然留着上下内边距,
 *   收起后会剩一条几像素的空带。
 */
export function SurfaceReveal({
  open,
  divider = true,
  className,
  children
}: {
  open: boolean
  /**
   * 展开区顶上那道分隔线。默认有 —— 卡片是「标题行 + 展开区」两段式的时候需要它。
   * 关掉是给**内边距已经在外壳上**的卡片用的(PlanPanel 就是这种):
   * 那种卡片的展开区是正文的延续,不是第二个区段,再画一道线等于把它切成两半。
   */
  divider?: boolean
  className?: string
  children: ReactNode
}): ReactNode {
  const scale = motionScale(useMotionLevel())
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="reveal"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          // 和 `--ease-panel` 同一条曲线:起步快、尾巴长。
          // 三处面板开合用的就是它,展开区跟着走,整套界面的手感才是一套。
          transition={{
            duration: 0.22 * scale,
            ease: [0.32, 0.72, 0, 1],
            opacity: { duration: 0.14 * scale }
          }}
          style={{ overflow: 'hidden' }}
        >
          <div
            className={cn(
              divider ? 'border-t border-hairline px-3 py-2' : 'pt-2',
              className
            )}
          >
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
