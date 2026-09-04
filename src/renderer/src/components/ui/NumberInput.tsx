import { useRef, useState } from 'react'
import { TextInput } from './TextInput'

/**
 * 整数输入框 —— 设置浮层里只有网关端口一个用户(参考图「网络」页那个 `10808`
 * 小框)。**不做 stepper 加减按钮**:14 张参考图里一个都没有。
 *
 * ★ **内部状态是 string,不是 number。** `value={number}` 的受控数字框表达不了
 * 「用户刚把内容删空准备重打」这个中间态 —— 空串会变成 NaN、变成 0,或者干脆
 * 让光标跳回去。所以草稿是字符串,只在提交那一刻才解析。
 *
 * ★ **失焦/回车才提交,不逐键提交。** 逐键 = 每个字符一次 IPC + 一次全窗口广播,
 * 而且打 `19837` 的路上会经过 `1`、`19`、`198`,这些都不是合法端口。
 *
 * ★ **外部值只在没有焦点时回灌。** 用渲染期比对(和 `Composer.tsx` 里那段
 * `seenWorkspace` 同一个写法),不是 `useEffect([value])` —— 后者正是 Composer
 * 注释点名的那个 bug:广播回来时把用户正在打的字冲掉。
 */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  width = 96,
  ariaLabel,
  disabled = false
}: {
  value: number
  onCommit: (n: number) => void
  min: number
  max: number
  width?: number
  ariaLabel: string
  disabled?: boolean
}): React.ReactNode {
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  const focused = useRef(false)

  // 渲染期回灌:只在没有焦点时,且外部值确实变了
  if (value !== seen && !focused.current) {
    setSeen(value)
    setDraft(String(value))
  }

  const parsed = parseIntStrict(draft)
  const invalid = parsed === null || parsed < min || parsed > max

  const commit = (): void => {
    focused.current = false
    if (parsed !== null && parsed >= min && parsed <= max) {
      if (parsed !== value) onCommit(parsed)
      return
    }
    // 非法就原样还原 —— 悄悄夹到边界值上比还原更糟:用户看到的数字不是他打的
    setDraft(String(value))
  }

  return (
    <div style={{ width }} onFocusCapture={() => (focused.current = true)}>
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        onRevert={() => {
          focused.current = false
          setDraft(String(value))
        }}
        invalid={invalid}
        disabled={disabled}
        ariaLabel={ariaLabel}
        inputMode="numeric"
      />
    </div>
  )
}

/** `Number('')` 是 0、`Number('12abc')` 是 NaN、`parseInt('12abc')` 是 12 —— 三个都不对 */
function parseIntStrict(s: string): number | null {
  const t = s.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}
