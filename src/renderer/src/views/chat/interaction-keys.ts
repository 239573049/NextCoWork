/**
 * 交互卡里「一列行 + 数字快捷键」的键盘规则,与 React 无关的那一半。
 *
 * 抽出来的理由和 `./ask-user` 一样:规则条数不少,而每一条都要等「焦点在哪、
 * 展开没展开、带没带修饰键」几件事凑齐之后才显形 —— 留在组件里就只能靠手按来验。
 */

/** 只取真正参与判定的那几个字段,测试就不必造一个完整的 KeyboardEvent。 */
export interface RowKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export type RowKeyAction =
  | { kind: 'activate'; index: number }
  | { kind: 'run' }
  | { kind: 'collapse' }

/**
 * 焦点落在一颗**自己就会响应 Enter 的按钮**上(「取消」「暂不回答」)。这时这列
 * 行必须放手 —— 否则用户按 Enter 想点的是「取消」,实际执行的却是高亮那一行。
 * 行本身的按钮不算:它们身上有 `data-row-value`,Enter 打在它们身上本就是执行。
 */
export function isSelfHandlingButton(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const node = target as { tagName?: unknown; dataset?: { rowValue?: unknown } }
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag !== 'BUTTON' && tag !== 'A') return false
  return node.dataset?.rowValue === undefined
}

/** 焦点是不是落在能打字的东西上。`unknown` 入参是为了直接喂 `event.target`。 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const node = target as { tagName?: unknown; isContentEditable?: unknown }
  if (node.isContentEditable === true) return true
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 一次按键该让这列行做什么。`null` = 不关我事,放行给浏览器。
 *
 * ★ **输入框里的数字必须还是数字。** 这是整套快捷键最容易出事的地方:展开
 * 「要求修改」之后用户要在里面写「改成 3 步」,而那个 3 一旦被当成行号吃掉,
 * 用户会看见光标不动、行却跳了,完全无从解释。
 */
export function resolveRowKey(
  event: RowKeyEvent,
  context: {
    count: number
    active: number
    inEditable: boolean
    expanded: boolean
    /** 焦点在一颗自己会处理 Enter 的按钮上 —— 见 `isSelfHandlingButton`。 */
    onOtherButton?: boolean
  }
): RowKeyAction | null {
  const { count, active, inEditable, expanded } = context

  if (event.key === 'Escape') return expanded ? { kind: 'collapse' } : null

  if (event.key === 'Enter') {
    if (event.shiftKey === true) return null
    if (context.onOtherButton === true) return null
    // 输入框里的裸 Enter 是换行,发送要按 Cmd/Ctrl+Enter —— 与 Composer、
    // PendingQueue 同一套约定,不让这张卡自成一派。
    if (inEditable && event.metaKey !== true && event.ctrlKey !== true) return null
    return { kind: 'run' }
  }

  if (inEditable) return null
  // Cmd+1 / Ctrl+1 是外面的标签页切换,不能被一张卡截走。
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null
  // 没有行可点名时只有导航键没意义 —— Enter/Esc 上面已经各自表过态了。
  if (count <= 0) return null

  if (event.key === 'ArrowDown') return { kind: 'activate', index: (active + 1) % count }
  if (event.key === 'ArrowUp') return { kind: 'activate', index: (active - 1 + count) % count }

  if (!/^[1-9]$/.test(event.key)) return null
  const index = Number(event.key) - 1
  // 越界的数字**不能**回退成「最后一行」—— 那会让按错一个键变成执行了另一个动作。
  return index < count ? { kind: 'activate', index } : null
}
