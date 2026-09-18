/**
 * 改名撞上同名文件时的那一问。
 *
 * ★ 范式照搬 `stores/documents.ts` 的 `confirmDocumentChanges`:store 里存一个
 * `resolve`,发起方 `await` 一个 Promise,由挂在 shell 根部的对话框组件把它 resolve 掉。
 * 不用原生 `window.confirm` —— 它同步阻塞渲染进程,而且长得不是这个应用的样子。
 *
 * ★★ **对话框的 `onClose` 必须 `close(false)`。** 点遮罩 / 按 Esc 关掉时若不
 * resolve,那个 Promise 就永远挂着 —— 表现是「改名再也没有反应了」,而且此后
 * 每一次改名都会被 `pending !== null` 这一句直接判 false。这个故障复现性极差
 * (只有"点遮罩关"这一条路能触发),所以在这里写死。
 */
import { create } from 'zustand'

interface OverwriteConfirmState {
  /** 正在问的那一条;`null` = 没有对话框 */
  pending: { name: string; resolve: (proceed: boolean) => void } | null
}

export const useOverwriteConfirmStore = create<OverwriteConfirmState>(() => ({ pending: null }))

/**
 * 问用户要不要覆盖 `name`。`false` = 别动。
 *
 * ★ 已经有一个在问时直接返回 `false`,不排队:两个确认框叠在一起,用户根本
 * 分不清自己在回答哪一个。
 */
export function confirmOverwrite(name: string): Promise<boolean> {
  if (useOverwriteConfirmStore.getState().pending !== null) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    useOverwriteConfirmStore.setState({ pending: { name, resolve } })
  })
}

/** 由对话框组件调用 —— 先清状态再 resolve,顺序反了会多渲染一帧带着旧名字的框。 */
export function settleOverwrite(proceed: boolean): void {
  const { pending } = useOverwriteConfirmStore.getState()
  useOverwriteConfirmStore.setState({ pending: null })
  pending?.resolve(proceed)
}
