import { useRef, useState } from 'react'
import { cn } from '../../lib/cn'

/**
 * 离散刻度滑杆 —— 参考图 c44ef6d3(通用 → 任务)里「Agent 资源调度」下的
 * 「单对话子代理上限」和「并发上限」用的就是这个:accent 填充的槽 + 刻度点 +
 * 药丸滑块,上方一行「当前 N · 推荐 M」的小字。
 *
 * 0–10 这种档数用 `Segmented` 一行塞不下,用 `NumberInput` 又和参考对不上。
 *
 * ★ **`onChange` 与 `onCommit` 必须分开。** 拖动中每帧一次 `updateSettings`
 * 就是每帧一次 IPC + 一次全窗口广播 + (步骤 6 之后)一次磁盘写。
 * 所以拖动只动本地草稿,松手 / 松键才写回去。
 *
 * 实现是「自绘的槽 + 盖在上面的透明原生 range」:原生 range 负责键盘、
 * 触摸、无障碍语义,自绘部分负责长相。给 `::-webkit-slider-thumb` 写样式也能做,
 * 但那条路上刻度点没地方画。
 */
export function Slider({
  value,
  onCommit,
  onPreview,
  min,
  max,
  step = 1,
  ariaLabel,
  disabled = false,
  className
}: {
  value: number
  onCommit: (v: number) => void
  /**
   * 拖动过程中每一次取值变化。**只用来更新同屏的读数**(比如标题里那行「· 高」),
   * 不要在里面写回存储 —— 那正是 `onCommit` 存在的理由,上面那段注释算过这笔账。
   *
   * 为什么需要它:滑杆自己没有刻度文字(两头各一个端点标签而已),
   * 不给实时读数的话,拖动中你看不出停在了哪一档,只能松手试。
   */
  onPreview?: (v: number) => void
  min: number
  max: number
  step?: number
  ariaLabel: string
  disabled?: boolean
  className?: string
}): React.ReactNode {
  // 拖动中的本地值。null = 没在拖,显示外部值
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef(value)
  const shown = dragging ?? value
  const pct = max === min ? 0 : ((shown - min) / (max - min)) * 100

  // 刻度点太密就不画 —— 12 个以上会糊成一条实线,反而看不出是离散的
  const ticks = Math.round((max - min) / step) + 1
  const showTicks = ticks <= 12

  const commit = (): void => {
    setDragging(null)
    if (latest.current !== value) onCommit(latest.current)
  }

  /*
    ★ 只在**没拖**的时候给过渡。点轨道跳档、方向键换档都该滑过去,
    而拖动中加过渡 = 滑块永远慢光标半拍,那正是「手感黏」的来源。
  */
  const glide = dragging === null ? 'transition-[left,width] duration-150 ease-out' : ''

  return (
    <div
      className={cn(
        'group app-no-drag relative flex h-6 select-none items-center',
        disabled && 'opacity-40',
        className
      )}
    >
      {/* 槽 */}
      <div className="absolute inset-x-0 h-1.5 rounded-pill bg-tint" />
      {/* 已填充 */}
      <div
        className={cn('absolute left-0 h-1.5 rounded-pill bg-accent', glide)}
        style={{ width: `${pct}%` }}
      />
      {showTicks && (
        <div className="pointer-events-none absolute inset-x-0 flex justify-between px-[1px]">
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className="size-[3px] rounded-pill bg-fg-faint/60" />
          ))}
        </div>
      )}
      {/*
        滑块。白色沿用 Toggle 的旋钮(参考图里这两处看着是同一颗,没有单独量)。

        ★ **位置和缩放必须分两层。** 一个元素上只有一条 `transition-property`,
        后写的那条整个顶掉前一条 —— 位移的 `left` 和反馈的 `scale` 挂在同一个
        div 上,就会变成「要么跳档不滑、要么按下去不放大」,而且哪个赢取决于
        Tailwind 把哪条工具类排在后面,改个无关的类就可能翻转。
        外层只管位移,内层只管反馈,两条过渡各归各的。
      */}
      <div
        className={cn('pointer-events-none absolute', glide)}
        style={{ left: `calc(${pct}% - ${(pct / 100) * 14}px)` }}
      >
        <div
          className={cn(
            'size-[14px] rounded-pill bg-white shadow-sm shadow-black/30',
            'transition-transform duration-100 group-hover:scale-110',
            // 按住时再放大一点 = 「抓住了」的反馈;键盘聚焦时给环,
            // 否则 Tab 到这根杠上**屏幕上没有任何变化**(原生 input 是全透明的)。
            'group-has-[:active]:scale-125 group-has-[:focus-visible]:ring-2',
            'group-has-[:focus-visible]:ring-accent/60 group-has-[:focus-visible]:ring-offset-0'
          )}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          const v = Number(e.target.value)
          latest.current = v
          setDragging(v)
          onPreview?.(v)
        }}
        onPointerUp={commit}
        // 拖出控件外再松手 / 被系统打断时,pointerup 不一定回到这里
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={() => dragging !== null && commit()}
        /*
          ★ `appearance-none` + 显式 14px 的 thumb 不是为了长相(它是全透明的),
          是为了**落点对齐**:浏览器把光标 x 映射成取值时,两端各留出半个 thumb 的
          余量,而那个 thumb 宽度由 UA 定(Chromium ≈16px)。自绘的是 14px,
          两个数不一样,于是越靠边光标和白点偏得越明显。统一成 14px 就没有这个缝。
        */
        className={cn(
          'absolute inset-x-0 h-6 w-full cursor-pointer appearance-none bg-transparent opacity-0',
          '[&::-webkit-slider-thumb]:size-[14px] [&::-webkit-slider-thumb]:appearance-none',
          'active:cursor-grabbing'
        )}
      />
    </div>
  )
}
