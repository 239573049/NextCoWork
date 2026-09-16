/**
 * toast 的显示层。整个应用只挂一次(`App.tsx`),内容从 `stores/toast` 来。
 *
 * ★ **堆叠方向朝上、新的在下。** 新通知出现在最靠近视觉重心的位置,旧的被
 *   往上顶。反过来(新的加在顶部)会让已经读到一半的旧通知突然往下跳。
 *
 * ★ **`layout` 让「上面一条被关掉」时下面的平滑补位**,而不是瞬间跳上去。
 *   这是这个组件里唯一真正需要 Motion 的部分 —— 退场时的位置重排,CSS 做不到。
 *
 * ★ **`pointer-events-none` 在容器上、`auto` 在每张卡上。** 容器是个铺满右下角
 *   的透明盒子,不这样写的话它会挡住底下真正的界面(输入框右下角那一片正好
 *   被盖住)。
 */
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { useToastStore, type Toast, type ToastTone } from '../../stores/toast'
import { motionScale, useMotionLevel } from '../../theme/useMotionLevel'

const TONE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'text-accent' },
  error: { icon: CircleAlert, cls: 'text-danger' },
  info: { icon: Info, cls: 'text-fg-muted' }
}

function ToastCard({ toast }: { toast: Toast }): ReactNode {
  const { t } = useI18n()
  const dismiss = useToastStore((s) => s.dismiss)
  const scale = motionScale(useMotionLevel())
  const { icon: Icon, cls } = TONE[toast.tone]

  /*
    ★ 计时器的依赖里带上 `toast.count`:同 key 的通知被再次触发时 count 会 +1,
    于是这个 effect 重跑、倒计时从头开始。不带的话「连续保存失败」的第二次
    提示会沿用第一次剩下的时间,可能刚冒出来就没了。
  */
  useEffect(() => {
    if (toast.duration === null) return
    const id = window.setTimeout(() => dismiss(toast.id), toast.duration)
    return () => window.clearTimeout(id)
  }, [toast.id, toast.duration, toast.count, dismiss])

  return (
    <motion.div
      layout
      // role 按语气分:错误要打断屏幕阅读器当前的朗读,成功/提示不该打断
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      data-testid="toast"
      data-toast-tone={toast.tone}
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // 退场往右滑出:和「关掉」这个动作的方向一致(关闭按钮在右边)
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={
        // 同 Segmented:弹簧配 `duration: 0` 不收敛,归零那档必须换普通缓动
        scale === 0 ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.35 * scale }
      }
      className={cn(
        'pointer-events-auto flex w-[min(380px,calc(100vw-32px))] items-start gap-2.5',
        'rounded-card border border-stroke bg-surface-raised px-3 py-2.5 shadow-lg shadow-black/25'
      )}
    >
      <Icon size={14} className={cn('mt-[1px] shrink-0', cls)} aria-hidden />
      <div className="selectable min-w-0 flex-1 text-[12px] leading-[1.5] break-words text-fg">
        {toast.message}
      </div>
      {toast.count > 1 && (
        <span
          data-testid="toast-count"
          className="mt-[1px] shrink-0 rounded-pill bg-tint px-1.5 text-[10px] leading-[16px] text-fg-muted"
        >
          {/* 纯数字,不翻译 —— 但 aria 上要有说明 */}
          <span aria-hidden>{toast.count}</span>
          <span className="sr-only">{t('toast.repeated', { count: String(toast.count) })}</span>
        </span>
      )}
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={() => dismiss(toast.id)}
        className="-mr-1 mt-[-2px] shrink-0 rounded-[6px] p-1 text-fg-faint transition-colors hover:bg-tint-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <X size={12} />
      </button>
    </motion.div>
  )
}

export function ToastViewport(): ReactNode {
  const toasts = useToastStore((s) => s.toasts)

  return createPortal(
    <div
      // z-[150]:和 Tooltip 同档 —— portal 到 body、必须压住 z-100 的模态。
      // 见 theme.css 末尾 z 轴那段。
      className="app-no-drag pointer-events-none fixed right-4 bottom-4 z-[150] flex flex-col items-end gap-2"
    >
      {/*
        `initial={false}` 的理由同 ToolTimeline:应用启动时如果 store 里已经有
        通知(HMR 恢复、或将来做了持久化),不该把它们当成刚发生的事再播一遍。

        `mode="popLayout"` 是这里的关键:退场中的那张卡会被移出布局流,于是
        下面的卡**立刻**开始往上补位,而不是等它淡完再跳一下。
      */}
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((x) => (
          <ToastCard key={x.id} toast={x} />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  )
}
