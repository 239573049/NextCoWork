/**
 * 插话 —— 在**不中断当前 run** 的前提下,把用户消息塞进正在跑的那个循环。
 *
 * ## 为什么它不是 `queued-input.ts` 的一部分
 *
 * 队列是渲染层的东西:草稿、编辑、删除、落盘,主进程一概不需要知道。
 * 主进程只需要知道两件事 —— **发什么内容**、**发完之后回执给谁**。
 * 这个文件就是那两件事,`ContentPart[]` + 一个 id,再无其他。
 *
 * ## `id` 就是最终那条用户消息的 id
 *
 * 这不是巧合,是**刻意让它们相等**。相等之后,「这条排队消息被消费了没有」
 * 不需要任何新事件类型来回答:渲染层看见一条 `message_commit`,
 * 消息 id 在自己的队列里,就把它移出队列。
 *
 * 这条设计换来三件事:
 * 1. **重放安全** —— ⌘R 之后 attach 重放 `message_commit`,队列照样收敛,
 *    不必额外持久化「已注入」标记;
 * 2. **幂等** —— 同一条 commit 收两次,第二次是 no-op;
 * 3. **恰好一次** —— 唯一决定「消费」的地方是主进程的注入点。run 在注入前
 *    结束的话主进程什么都不发,条目原封不动留在队列里,由 run 结束后的
 *    `drainQueue` 正常发出去。两条路径不可能同时命中同一个 id。
 */
import type { ContentPart } from './message'

export interface InterjectItem {
  /** ★ 渲染层排队条目的 id;注入后**直接用作**那条用户消息的 id(见上) */
  id: string
  parts: ContentPart[]
  /** Coordination messages are sent to the model but hidden from the chat UI. */
  internal?: boolean
}
