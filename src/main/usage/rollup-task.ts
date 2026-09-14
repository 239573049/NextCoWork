/**
 * `usage_daily` 的后台定时刷新。
 *
 * 形状照搬 `imports/sync.ts`(单飞 + `unref` 定时器 + 启动先跑一次 + 失败只 warn)
 * —— 这是本仓库内部维护型后台任务的既定写法。`scheduled/scheduler.ts` 不是通用
 * 框架,那是用户可配的 Agent 定时任务,和这里没关系。
 *
 * ## 定时器不是唯一入口,也不该是
 *
 * 两条 usage 概览 IPC 在查询前**各自也会刷一次**。定时器的职责是把长时间积累的
 * 增量摊薄(否则开着聊一整天,第一次打开统计页要一次性重算一大坨);查询前那一次
 * 保证「刚聊完就点开统计」看到的是最新数字,而不是最多等五分钟。
 *
 * 两个入口共用同一个幂等函数,所以重叠调用不会算错,只会做重复功;`inFlight`
 * 把重复功也省掉。
 */
import { store } from '../state/store'

/** 五分钟。★ `refreshUsageRollup` 是**同步**的,会阻塞主进程 —— 间隔太短就是
 *  拿界面卡顿换一个没人盯着的数字的新鲜度。查询前的那次刷新兜住了实时性,
 *  所以这里可以放心取大。 */
const INTERVAL_MS = 5 * 60 * 1000

let timer: NodeJS.Timeout | null = null
/** ★ 进程内单飞。定时器本身不保证上一轮跑完了 —— 首次全量汇总在大库上会超过间隔。 */
let inFlight = false

export function startUsageRollup(): void {
  if (timer !== null) return
  timer = setInterval(tick, INTERVAL_MS)
  // 不拖住进程退出:这活儿下次启动补上就行,没有任何理由为它多等一个周期。
  timer.unref?.()
  // 启动后先来一次,但丢进 microtask 队列,不占用启动路径。
  queueMicrotask(tick)
}

export function stopUsageRollup(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/** 系统唤醒后补一次。休眠期间定时器只补触发一次,而这段时间可能跨了好几天。 */
export function resumeUsageRollup(): void {
  tick()
}

function tick(): void {
  if (inFlight) return
  inFlight = true
  try {
    store.refreshUsageRollup()
  } catch (err) {
    // 一轮失败不该让定时器停掉:下一轮会从同一个水位重来,而重算是幂等的。
    console.warn('[usage] 汇总刷新失败,下一轮重试:', err)
  } finally {
    inFlight = false
  }
}
