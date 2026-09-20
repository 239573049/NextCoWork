/**
 * 草稿态输入框的共用壳 —— 逐键写入等于每个字符一次 IPC + 一次全窗口广播,
 * 而且中间态(打到一半的地址)不该被存进设置。
 *
 * 回灌用**渲染期比对**,不用 `useEffect([value])` —— 后者正是 `Composer.tsx`
 * 注释点名的那个 bug(广播回来时把用户正在打的字冲掉)。有焦点时不回灌:
 * 别的窗口在你打字期间改了同一字段也冲不掉你,你失焦提交时最后写,你赢。
 *
 * ## 它为什么住在这里
 *
 * 实现原本私有在 `pages/connection/NetworkPane.tsx` 里。内置搜索那一小节要的是
 * 同一个东西(一个写进 `AppSettings` 的地址输入框),复制第二份的话,
 * 上面那条「渲染期比对」的规矩迟早在其中一份里退化成 `useEffect` ——
 * 而那正是这段注释在防的 bug。所以提到设置层公用,两处共用同一份。
 */
import { useRef, useState, type ReactNode } from 'react'
import { TextInput } from '../components/ui/TextInput'

export function DraftInput({
  value,
  disabled,
  invalid = false,
  ariaLabel,
  placeholder,
  onCommit,
  transform
}: {
  value: string
  disabled: boolean
  invalid?: boolean
  ariaLabel: string
  placeholder?: string
  onCommit: (v: string) => void
  /** 提交前的最后一次加工。返回 `null` = 别提交,还原成 `value` */
  transform?: (draft: string) => string | null
}): ReactNode {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  const focused = useRef(false)

  if (value !== seen && !focused.current) {
    setSeen(value)
    setDraft(value)
  }

  const commit = (): void => {
    focused.current = false
    const next = transform === undefined ? draft.trim() : transform(draft)
    if (next === null) {
      setDraft(value)
      return
    }
    setDraft(next)
    if (next !== value) onCommit(next)
  }

  return (
    <div onFocusCapture={() => (focused.current = true)}>
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        onRevert={() => {
          focused.current = false
          setDraft(value)
        }}
        invalid={invalid}
        disabled={disabled}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
      />
    </div>
  )
}
