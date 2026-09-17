/**
 * 「每个工作区一份」的注册表分桶。
 *
 * ## 这个文件在修的是一类具体的串味
 *
 * Skill / 子代理 / 模式三张注册表原本是**进程内单例**,而每一次 run 开始前
 * 都会 `replaceAll()` 一遍(扫的是那个工作区的目录)。于是两个工作区同时有事
 * 发生时:
 *
 * - A 的 run 刚扫完,B 的 run 紧接着扫 —— A 这一轮拿到的是 **B 的** Skill 目录;
 * - 上下文预览(`ipc/context.ts`)读的是「最后一次扫描留下的那份」,
 *   打开 A 的预览,列的可能是 B 装的那些;
 * - 两件事都**没有任何症状**:提示词照发,界面照画,只是内容属于另一个工作区。
 *
 * `runtime.ts` 里那段「子 run 不重扫」的注释记的就是这个坑的一个局部补丁 ——
 * 它防的不是数据太旧,而是父 run 跑到一半时单例被换掉。分桶之后那条约束
 * 仍然成立(子 run 继承父 run 的快照),但它不再是唯一的防线。
 *
 * ## 为什么带上限
 *
 * 桶是按需建的,而 `workspaceId` 来自调用方 —— 没有上限的话,一个长期运行的
 * 进程会把每一个曾经查过的工作区都留在内存里。上限用 LRU 淘汰:被淘汰的桶
 * 下一次 run 开始前会重扫回来(`refreshSkills` 每次发送前都跑),**代价是一次
 * 目录扫描,不是错误数据** —— 这正是这里可以接受淘汰的原因。
 */

/** 最多同时留几份。远大于「一个人同时开着几个工作区」,又不至于无界增长。 */
export const MAX_REGISTRY_BUCKETS = 64

export class RegistryBuckets<T> {
  private readonly buckets = new Map<string, T>()

  constructor(
    private readonly create: () => T,
    private readonly max: number = MAX_REGISTRY_BUCKETS
  ) {}

  /** 取(必要时新建)这个工作区的那一份。 */
  get(workspaceId: string): T {
    const existing = this.buckets.get(workspaceId)
    if (existing !== undefined) {
      // 重新插一次 = 标记为最近使用。Map 的迭代顺序就是插入顺序,LRU 靠它。
      this.buckets.delete(workspaceId)
      this.buckets.set(workspaceId, existing)
      return existing
    }
    const created = this.create()
    this.buckets.set(workspaceId, created)
    while (this.buckets.size > this.max) {
      const oldest = this.buckets.keys().next()
      if (oldest.done === true) break
      this.buckets.delete(oldest.value)
    }
    return created
  }

  /** 已经建过吗。用来区分「这个工作区还没扫过」和「扫过但是空的」。 */
  has(workspaceId: string): boolean {
    return this.buckets.has(workspaceId)
  }

  /** 工作区被移除时调,别让它的那份留着占内存。 */
  drop(workspaceId: string): void {
    this.buckets.delete(workspaceId)
  }

  /**
   * 全部丢掉。
   *
   * ★ 切换配置作用域(换账户)时**必须**调它:上一个账户的文件根里扫出来的
   * 东西留在任何一个桶里,都是一次跨账户的串味。
   */
  clear(): void {
    this.buckets.clear()
  }

  /** 现有的那些桶。调用方用它做批量操作(比如整体清空内容)。 */
  values(): IterableIterator<T> {
    return this.buckets.values()
  }

  size(): number {
    return this.buckets.size
  }
}
