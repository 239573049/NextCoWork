/**
 * 分段控件 —— 设置页里出现了 2/3/4/8 路四种(权限模式、资源模式、重复类型、
 * 思考模式「自动|极低|低|中|高|超高|最高|关闭」)。8 路那个决定了尺寸:
 * 一行要塞得下八个中文词,所以 `sm` 的内边距压得很紧。
 *
 * 配色是 theme.css 里那条规律的最直接体现:**槽是暖的(tint),选中项是暗的
 * (surface-sunken)** —— 选中不是被点亮,是被挖下去。
 *
 * ★ **选中态是一块会滑的指示器,不是挂在按钮上的背景。** 切换时那块「挖下去」
 * 的凹槽从旧项滑到新项,而不是原地闪一下。
 *
 * ## 为什么这里不再自己测量
 *
 * 这个文件以前有一整套 `useLayoutEffect` + `ResizeObserver` + `offsetLeft`
 * 的测量代码,外加一个 `ready` 标志,用来绕开三个坑:
 *
 *   1. 首帧不能有动画,否则每次挂载都看到指示器从最左边滑进来;
 *   2. 必须量在 `useLayoutEffect` 里,用 `useEffect` 会先画一帧错的;
 *   3. 设置浮层没打开时整棵子树是 `display:none`,量出来全是 0,
 *      字体加载完宽度还会再变一次 —— 得靠 `ResizeObserver` 兜。
 *
 * 这三个坑**都是「我选了一个错误的时机去读 DOM」的不同表现**。改成 `layoutId`
 * 之后它们一起消失,因为 Motion 根本不在渲染时测量:它只在**指示器真的要从
 * A 移到 B 的那一刻**,分别读一次两边的 box,然后用 transform 把差值补上
 * (FLIP)。没有「过早测量」这个时机,也就没有量到 0、量到旧字体宽度的可能。
 *
 * 对应地:
 *   坑 1 → `layoutId` 首次出现时没有前一个 box 可配对,直接就位,天然无动画;
 *   坑 2 → 不存在渲染期测量;
 *   坑 3 → `display:none` 期间不会有切换发生,等到真的切换时容器已经可见了。
 *
 * ★ **`layoutRoot` 不能省。** FLIP 记的是元素在**页面**里的绝对位置。这个控件
 *   有好几处装在 `overflow-y-auto` 里(设置页内容区就是),如果在动画进行中
 *   容器滚了一下,那段滚动位移会被当成「元素移动了」一起播出去 —— 表现为指示器
 *   莫名其妙地斜着飞。`layoutRoot` 把坐标系钉在这个控件自己身上,滚动因此不参与。
 *
 * ★ **`layoutId` 必须每个实例唯一**(所以用 `useId`)。同一个 id 在页面上出现
 *   两次的话,Motion 会认为那是「同一块指示器换了位置」,于是权限模式的凹槽会
 *   横跨半个设置页飞到思考模式那一排去。
 */
import { motion } from 'motion/react'
import { useId, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { motionScale, useMotionLevel } from '../../theme/useMotionLevel'

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  shape = 'rounded',
  className,
  label,
  disabled = false
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: ReactNode }>
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  shape?: 'rounded' | 'pill'
  className?: string
  label?: string
  disabled?: boolean
}): React.ReactNode {
  const layoutId = `segmented-${useId()}`
  const scale = motionScale(useMotionLevel())

  return (
    <motion.div
      layoutRoot
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        'relative inline-flex rounded-[9px] bg-tint p-[3px]',
        shape === 'pill' && 'rounded-pill',
        className
      )}
    >
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
            className={cn(
              'app-no-drag relative rounded-[7px] whitespace-nowrap transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              shape === 'pill' && 'rounded-pill',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]',
              disabled
                ? 'cursor-not-allowed text-fg-faint'
                : on
                  ? 'text-fg'
                  : 'text-fg-muted hover:text-fg'
            )}
          >
            {on && (
              <motion.span
                aria-hidden
                layoutId={layoutId}
                className={cn(
                  'absolute inset-0 rounded-[7px] bg-surface-sunken shadow-sm shadow-black/20',
                  shape === 'pill' && 'rounded-pill bg-canvas shadow-none'
                )}
                transition={
                  // ★ 归零那一档必须换成普通 `duration: 0`,不能写 `spring` 配
                  // `duration: 0` —— 弹簧求解器拿到 0 时长会退化成一个永不收敛的
                  //  振荡,指示器会一直抖。这里要的是「立刻到位」。
                  scale === 0
                    ? { duration: 0 }
                    : {
                        // 弹一点点(`bounce: 0.15`)而不是纯缓动:凹槽有「被推过去」的重量感。
                        // 再高就会在 8 路那种窄格子里过冲到隔壁,看着像点错了。
                        type: 'spring',
                        bounce: 0.15,
                        duration: 0.3 * scale
                      }
                }
              />
            )}
            {/* z-10:压在指示器上面,否则文字被那块凹槽盖住 */}
            <span className="relative z-10">{o.label}</span>
          </button>
        )
      })}
    </motion.div>
  )
}
