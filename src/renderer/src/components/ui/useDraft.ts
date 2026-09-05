import { useRef, useState } from 'react'

/**
 * 「输入框里正在打的那一半」—— 只答一次。
 *
 * ★ 设置页的规矩是**绝不镜像 `settings`**(镜像会让控件「点下去闪一下又弹回」,
 * 见 `settings/props.ts`)。文本框是那条规矩唯一的例外,而例外的理由很具体:
 * **它有中间态**。用户打到「我是一名前」的那一刻,这既不是上一个值也不是
 * 下一个值 —— 逐键 `patch` 等于每敲一个字一次 IPC + 一次全窗口广播 + 一次落盘,
 * 而且半截的值真的会被存进设置。
 *
 * 所以草稿留在本地,失焦(或 Enter)时才提交一次。
 *
 * ★ **回灌只在没有焦点时发生。** 这一条是这个 hook 的全部难点:主进程对
 * **所有**窗口广播 `settings:changed`,包括发起写入的那个,所以每次提交都会
 * 有一份新的 `value` 回来。正在打字时接受回灌 = 光标跳到末尾、或者用户刚打的
 * 几个字被一份路上的旧值盖掉。别的窗口改了、或从磁盘读回来了,才该覆盖草稿。
 *
 * 渲染期同步而不是 `useEffect`:后者会多渲染一帧,那一帧框里显示的还是旧值。
 */
export function useDraft(value: string): {
  draft: string
  setDraft: (v: string) => void
  /** 绑到输入框的 `onFocus` */
  onFocus: () => void
  /**
   * 绑到输入框的 `onBlur`。传入真正的提交函数 —— 只在草稿**确实和外部值不同**
   * 时才调它:每次失焦都提交的话,一次纯粹的「点进去又点出来」也会写一次盘。
   */
  commit: (onCommit: (v: string) => void) => void
} {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  const focused = useRef(false)

  if (value !== seen && !focused.current) {
    setSeen(value)
    setDraft(value)
  }

  return {
    draft,
    setDraft,
    onFocus: () => {
      focused.current = true
    },
    commit: (onCommit) => {
      focused.current = false
      if (draft !== value) onCommit(draft)
    }
  }
}
