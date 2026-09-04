/**
 * 空会话首屏那句问候(截图 c6184031:「夜深了,有资料需要快速总结吗?」)。
 *
 * 放 shared/ 而不是写在 JSX 里,是因为它是个**纯函数,而且切点不止一个**:
 * 一天被分成四段,每个边界都是一次 off-by-one 的机会 —— 12 点整算上午还是下午、
 * 23 点和 0 点是不是同一段。这种东西在界面上只能靠改系统时间来验,
 * 写成纯函数几行就锁死了。
 *
 * ★ **入参是小时数,不是 `Date`。** 取「现在」那一下留给调用方,这个函数本身
 * 没有「今天」的概念 —— 测试于是不必冻结时钟,也不会在 CI 的 UTC 时区里翻车。
 */

export type DayPart = 'night' | 'morning' | 'afternoon' | 'evening'

/**
 * `hour` 取 0–23(`Date.prototype.getHours()` 的值域)。
 * 越界的输入按 24 取模归一化,让这个函数是**全函数** ——
 * 调用点少一个 `?.`,也少一种「问候语没了」的空白首屏。
 */
export function dayPartOf(hour: number): DayPart {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  if (h < 5) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

const GREETING: Record<DayPart, string> = {
  night: '夜深了,还在忙?',
  morning: '早上好,今天从哪儿开始?',
  afternoon: '下午好,要接着做点什么?',
  evening: '晚上好,有什么要收个尾的?'
}

export function greetingOf(hour: number): string {
  return GREETING[dayPartOf(hour)]
}
