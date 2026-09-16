/**
 * 瞬时通知(toast)。
 *
 * ★★ **为什么要新起一套,而不是继续用内联错误。**
 *
 * 全仓库有 162 处 `setError` / `setNotice` 之类的局部状态,它们把失败信息画在
 * 触发它的那块 UI 旁边。对**表单校验**那是对的 —— 「这个字段填错了」必须紧挨着
 * 那个字段。但对另一类场景是错的:
 *
 *   - 操作完成后触发它的 UI **已经不在了**(对话框保存后即关闭);
 *   - 操作是**后台**的,用户此刻在看别的地方(同步、导入、定时任务);
 *   - 结果是**成功**,而成功没有一块「错误区」可以借住 —— 于是现状是
 *     成功时什么都不说,用户只能靠列表有没有变来猜。
 *
 * 这三种情况下内联提示无处安放,所以它们现在**根本没有提示**。toast 补的是
 * 这个洞,不是去取代那 162 处 —— 表单校验继续留在原地。
 *
 * ## 三条设计约束
 *
 * 1. **`error` 不自动消失。** 成功可以一闪而过(用户不需要对它做什么),失败
 *    必须等用户看见并自己关掉。自动消失的错误等于没报过错。
 * 2. **同 `key` 的通知是替换而不是堆叠。** 「保存失败」连点五次应该是一条
 *    (计数 +1),不是五条把屏幕铺满。不给 key 的才各自独立。
 * 3. **最多同时 3 条**,超出时挤掉最老的。再多就不是通知而是日志了。
 */
import { create } from 'zustand'
import { ulid } from '../../../shared/util/id'

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  /** 已经翻译好的正文。**store 不碰 i18n** —— 它拿到的就是最终文案 */
  message: string
  /** 同 key 去重;不给则每条独立 */
  key?: string | undefined
  /** 同一条被重复触发的次数,≥2 时界面上显示角标 */
  count: number
  /** 毫秒;`null` 表示不自动消失 */
  duration: number | null
}

const MAX = 3
const DEFAULT_MS = 4000

interface ToastState {
  toasts: Toast[]
  push: (t: { tone: ToastTone; message: string; key?: string; duration?: number | null }) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: ({ tone, message, key, duration }) => {
    // 约束 1:错误默认不自动消失
    const ms = duration !== undefined ? duration : tone === 'error' ? null : DEFAULT_MS
    let id = ulid()

    set((s) => {
      // 约束 2:同 key 已在场就地更新,并把计数 +1
      const at = key !== undefined ? s.toasts.findIndex((x) => x.key === key) : -1
      if (at >= 0) {
        const prev = s.toasts[at]!
        id = prev.id
        const next = [...s.toasts]
        next[at] = { ...prev, tone, message, duration: ms, count: prev.count + 1 }
        return { toasts: next }
      }
      // 约束 3:满了就挤掉最老的
      const kept = s.toasts.length >= MAX ? s.toasts.slice(s.toasts.length - MAX + 1) : s.toasts
      return { toasts: [...kept, { id, tone, message, key, count: 1, duration: ms }] }
    })

    return id
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))

/**
 * 在 React 之外也能发通知(service 层、事件回调里)。
 *
 * ★ 直接 `getState()` 而不是做成 hook:调用点大多在 `catch` 里,
 *   那里没有 hook 的位置。zustand 的 store 本来就允许这样用。
 */
export const toast = {
  success: (message: string, key?: string): string =>
    useToastStore.getState().push({ tone: 'success', message, ...(key !== undefined && { key }) }),
  error: (message: string, key?: string): string =>
    useToastStore.getState().push({ tone: 'error', message, ...(key !== undefined && { key }) }),
  info: (message: string, key?: string): string =>
    useToastStore.getState().push({ tone: 'info', message, ...(key !== undefined && { key }) })
}
