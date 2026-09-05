/**
 * WindowRegistry —— 方案 §3 规则 5:事件按订阅**定向推送**,绝不广播。
 *
 * ⌥Space 快捷小窗不该收到主窗的 token 流。即使现在只有一个主窗,这也是**正确性问题**,
 * 不是多窗口特性 —— 等真开了第二个窗再来补,要动每一个 emit 点。
 *
 * 规则在这里是**类型级**的,不是约定:
 * - `emitToTopic` 只接受 TargetedEventChannel(run / 终端流)
 * - `emitToAll`   只接受 GlobalEventChannel(设置、主题、工作区列表这类真·全局变更)
 * 想拿 emitToAll 推 agent:event,编译期就过不去。
 */
import type { WebContents } from 'electron'
import type { EventChannel, IpcEventMap } from '../../shared/ipc/contract'
import type { WindowKind } from '../../shared/domain/tab'

/** 必须按订阅推送的频道:一个窗口只该收到它自己在看的那个 run / 终端 */
export type TargetedEventChannel = 'agent:event' | 'terminal:data' | 'terminal:exit'
/** 真·全局状态变更,所有窗口都该知道 */
export type GlobalEventChannel = Exclude<EventChannel, TargetedEventChannel>

export interface WindowContext {
  id: number
  kind: WindowKind
  sender: WebContents
}

export const runTopic = (runId: string): string => `run:${runId}`
export const terminalTopic = (terminalId: string): string => `term:${terminalId}`

class WindowRegistry {
  private readonly windows = new Map<number, WindowContext>()
  /** topic → 订阅了它的 webContents id */
  private readonly topics = new Map<string, Set<number>>()

  register(sender: WebContents, kind: WindowKind): WindowContext {
    const ctx: WindowContext = { id: sender.id, kind, sender }
    this.windows.set(sender.id, ctx)
    // 窗口销毁时把它从所有 topic 里摘掉,否则 topics 会无限增长,
    // 且每次 emit 都要对着一堆死 webContents 做 isDestroyed 判断
    sender.once('destroyed', () => this.forget(sender.id))
    return ctx
  }

  /** 握手第一步 window:ready 时调用,确认这个窗口的 kind */
  markReady(sender: WebContents, kind: WindowKind): WindowContext {
    const existing = this.windows.get(sender.id)
    if (existing) {
      existing.kind = kind
      return existing
    }
    return this.register(sender, kind)
  }

  /** handler 里拿到 event.sender 后换成上下文;未注册的一律当主窗 */
  of(sender: WebContents): WindowContext {
    return this.windows.get(sender.id) ?? this.register(sender, 'main')
  }

  forget(id: number): void {
    this.windows.delete(id)
    for (const [topic, ids] of this.topics) {
      ids.delete(id)
      if (ids.size === 0) this.topics.delete(topic)
    }
  }

  // ─── 订阅 ───

  subscribe(topic: string, sender: WebContents): void {
    let set = this.topics.get(topic)
    if (!set) {
      set = new Set()
      this.topics.set(topic, set)
    }
    set.add(sender.id)
    this.of(sender)
  }

  unsubscribe(topic: string, sender: WebContents): void {
    const set = this.topics.get(topic)
    if (!set) return
    set.delete(sender.id)
    if (set.size === 0) this.topics.delete(topic)
  }

  /**
   * 把 `from` 这个主题的订阅者**原样复制**给 `to`。子 run 的订阅就是这么来的。
   *
   * ★ 不做这一步的表现极其隐蔽:一切正常、没有任何报错、只是界面上什么都不发生。
   * 因为 `RunPump.flush()` 在 `!hasSubscribers(topic)` 时**整批丢弃**事件 ——
   * 子 run 有自己的 runId,于是有自己的主题,而没有任何窗口订阅过那个主题。
   *
   * 是**复制而不是别名**:父 run 结束后它的订阅可能被清掉,而子 run 还在跑;
   * 别名会让子 run 跟着一起失聪。代价是父 run 之后新增的订阅者
   * (⌘R 重载后重新 attach 的窗口)看不到子 run —— 那条路由
   * `attachRun` 会走 `snapshot().children`,不靠这里。
   */
  inherit(from: string, to: string): void {
    const src = this.topics.get(from)
    if (!src || src.size === 0) return
    let dst = this.topics.get(to)
    if (!dst) {
      dst = new Set()
      this.topics.set(to, dst)
    }
    for (const id of src) dst.add(id)
  }

  /** 一个 run / 终端还有没有人在看。没人看时可以停掉合批泵,但**不停 run 本身**。 */
  hasSubscribers(topic: string): boolean {
    return (this.topics.get(topic)?.size ?? 0) > 0
  }

  isSubscribed(topic: string, sender: WebContents): boolean {
    return this.topics.get(topic)?.has(sender.id) === true
  }

  // ─── 推送 ───

  emitToTopic<K extends TargetedEventChannel>(
    topic: string,
    channel: K,
    payload: IpcEventMap[K]
  ): void {
    const ids = this.topics.get(topic)
    if (!ids) return
    for (const id of ids) this.send(id, channel, payload)
  }

  emitToAll<K extends GlobalEventChannel>(channel: K, payload: IpcEventMap[K]): void {
    for (const id of this.windows.keys()) this.send(id, channel, payload)
  }

  emitTo<K extends EventChannel>(sender: WebContents, channel: K, payload: IpcEventMap[K]): void {
    this.send(sender.id, channel, payload)
  }

  /**
   * ★ 每次 send 前判 isDestroyed()(方案 §3 规则 4)。
   * 窗口刚关掉、事件泵还有一批在路上 —— 不判就是一个 "Object has been destroyed"。
   */
  private send(id: number, channel: string, payload: unknown): void {
    const ctx = this.windows.get(id)
    if (!ctx) return
    if (ctx.sender.isDestroyed()) {
      this.forget(id)
      return
    }
    ctx.sender.send(channel, payload)
  }

  list(): WindowContext[] {
    return [...this.windows.values()]
  }
}

export const windows = new WindowRegistry()
