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
  min,
  max,
  step = 1,
  ariaLabel,
  disabled = false,
  className
}: {
  value: number
  onCommit: (v: number) => void
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

  return (
    <div className={cn('app-no-drag relative flex h-6 items-center', disabled && 'opacity-40', className)}>
      {/* 槽 */}
      <div className="absolute inset-x-0 h-1.5 rounded-pill bg-tint" />
      {/* 已填充 */}
      <div
        className="absolute left-0 h-1.5 rounded-pill bg-accent"
        style={{ width: `${pct}%` }}
      />
      {showTicks && (
        <div className="pointer-events-none absolute inset-x-0 flex justify-between px-[1px]">
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className="size-[3px] rounded-pill bg-fg-faint/60" />
          ))}
        </div>
      )}
      {/* 滑块。白色沿用 Toggle 的旋钮(参考图里这两处看着是同一颗,没有单独量) */}
      <div
        className="pointer-events-none absolute size-[14px] rounded-pill bg-white shadow-sm shadow-black/30"
        style={{ left: `calc(${pct}% - ${(pct / 100) * 14}px)` }}
      />
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
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => dragging !== null && commit()}
        className="absolute inset-x-0 h-6 w-full cursor-pointer opacity-0"
      />
    </div>
  )
}
