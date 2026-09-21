/**
 * widget 内容帧的**推送节流器**。
 *
 * ## 需求
 *
 * 模型是按 token 吐 `widget_code` 的,而转录层的流式事件在渲染层被按帧合并
 * (`stores/session.ts` 的 drain 走 rAF),所以 `WidgetFrame` 在一次生成里会被
 * 重渲上百次。每次都把当前 HTML 推给 iframe 的话:
 *
 * - 跨进程 postMessage 要结构化克隆整段字符串(一份仪表盘几十 KB);
 * - iframe 里的 `syncInto` 每次都是 O(节点数) 的遍历。
 *
 * 两者叠起来,长 widget 的生成过程会**越写越卡** —— 而它看起来像是"模型变慢了"。
 * 所以按固定间隔发,间隔内的多次变更只保留最后一次。
 *
 * ## 为什么不是 debounce
 *
 * debounce 是"安静 N 毫秒之后才发",于是**最坏情况下整整一代内容都不会出现**
 * (token 连续不停,永远等不到那个安静窗口)。这里要的是 throttle:到点就发,
 * 发的是此刻最新的那一份。观感上才是"稳定地长",而不是"卡住——跳一大段"。
 *
 * ## 收尾那一帧必须立刻发
 *
 * `final` 帧决定脚本何时执行(图表何时画出来)。让它排在节流窗口后面,
 * 用户就会看到一张"内容都齐了但图还没画"的静态画面,长度取决于上一个 tick
 * 的余量 —— 一个谁也说不清为什么有时长有时短的空档。
 *
 * 纯逻辑(计时器从参数进来),所以 `__tests__/widget-push.test.ts` 能用假时钟
 * 把这几条规则逐个钉住 —— 它们是"会不会卡"的全部判据,不能靠盯屏幕验。
 */

/** 两次推送之间的最小间隔。约 8 帧:肉眼已经连续,而克隆与 diff 的次数降到 1/8。 */
export const PUSH_INTERVAL_MS = 120

export interface PushScheduler {
  /** 交一份新内容。立刻发出还是排队,由间隔决定。 */
  offer(html: string, final: boolean): void
  /** 立刻把待发的那份发出去(组件卸载前用 —— 否则最后一次内容会丢)。 */
  flush(): void
  /** 取消待发的定时器。卸载时必须调,否则定时器会在组件消失后触发一次 push。 */
  dispose(): void
}

export function createPushScheduler(
  push: (html: string, final: boolean) => void,
  intervalMs: number = PUSH_INTERVAL_MS
): PushScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 待发内容。`null` = 没有排队的东西。 */
  let pending: { html: string; final: boolean } | null = null

  const send = (): void => {
    const item = pending
    pending = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (item !== null) push(item.html, item.final)
  }

  return {
    offer(html, final) {
      // 收尾帧不走队列:见文件头最后一条。
      if (final) {
        pending = { html, final }
        send()
        return
      }
      pending = { html, final }
      if (timer !== null) return
      timer = setTimeout(send, intervalMs)
    },
    flush() {
      if (pending !== null) send()
    },
    dispose() {
      pending = null
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
