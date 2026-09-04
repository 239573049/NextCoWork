/**
 * 「先渲染、后收起」—— 让**条件挂载**的面板也能播完退场动画。
 *
 * 面板的开关是一个布尔:`{open && <Panel/>}`。这种写法关掉的一瞬间节点就没了,
 * 再漂亮的 transition 也没有东西可以跑 —— 收起永远是「啪」的一下。这个 hook 把
 * 一个布尔拆成三个信号:
 *
 *   `mounted`    还要不要渲染。开 → 立刻 true;关 → 等动画播完才 false
 *   `shown`      视觉上的展开态,驱动 class / style。开的那一帧**故意还是 false**,
 *                下一帧才翻 true,浏览器才有「从 0 到 297」这段可插值的变化;
 *                直接 true 的话元素第一次布局就已经在终点上,transition 不触发
 *   `animating`  这一刻正在过渡。**这个不是给动画用的,是给拖拽用的** ——
 *                底部/右侧面板的尺寸同时被「开关」和「拖分隔条」两件事写,
 *                transition 常开的话每拖一帧都排一次 280ms 插值,手感像在拉皮筋。
 *                只在开关引起的那 280ms 里挂 transition,拖动期间它是 false
 *
 * 首帧不算一次变化(`first`):启动时侧边栏本来就开着,不该自己滑进来一次。
 */
import { useEffect, useRef, useState } from 'react'

export interface Presence {
  mounted: boolean
  shown: boolean
  animating: boolean
}

export function usePresence(open: boolean, ms: number): Presence {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const [animating, setAnimating] = useState(false)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setAnimating(true)
    // +80:进场要等两帧才真正开始跑,提前摘掉 transition 会让最后几像素是跳过去的
    const settle = setTimeout(() => setAnimating(false), ms + 80)

    if (open) {
      setMounted(true)
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        clearTimeout(settle)
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }

    setShown(false)
    const unmount = setTimeout(() => setMounted(false), ms)
    return () => {
      clearTimeout(settle)
      clearTimeout(unmount)
    }
  }, [open, ms])

  return { mounted, shown, animating }
}
