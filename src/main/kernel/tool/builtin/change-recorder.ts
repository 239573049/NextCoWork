/**
 * 「这次运行里改了哪些文件、改前改后各是什么」—— 回复底部审查卡与撤销/恢复的采集侧。
 *
 * 与 `read-tracker.ts` 同款:状态按 **runId** 分桶、`MAX_RUNS` 封顶(没有可靠的
 * run 结束钩子来精确回收,靠上限兜底)、纯内存零 store —— 保持内核纯净。
 *
 * ★ 采集只发生在写盘处(`fs.ts` 的 Write / Edit),写盘**之后**记一条。
 *   `runtime.ts` 的 run 收尾用 `takeChanges(runId)` 读走并清空,落盘成快照。
 *
 * ★ 合并规则(同一轮多次改同一文件):
 *   - **首个** before 黏住 —— A→B 再 B→C,before 要是最初的 A,不是中途的 B。
 *   - **最后一个** after 覆盖 —— after 要是最终的 C。
 *   - `changeKind` 一旦是 `created` 就不被后续的 modify 翻转(这一轮里新建的文件,
 *     撤销时应当整个删掉,而不是回退到某个中间版本)。
 */

/** 最多记住几次运行。超了丢最旧的 —— 和 read-tracker 同一个理由。 */
const MAX_RUNS = 64

export interface PendingChange {
  /** 解析后的绝对路径,内核 host.fs 读写用。 */
  abs: string
  /** 工作区相对路径(区外为绝对),撤销回写的 workspace:* IPC 用。 */
  relPath: string
  /** 首个 before;新建文件为 null。 */
  before: string | null
  /** 最后一个 after。 */
  after: string
  changeKind: 'created' | 'modified'
  /** false = 改到了工作区外的文件。 */
  inWorkspace: boolean
}

const changesByRun = new Map<string, Map<string, PendingChange>>()

function bucket(runId: string): Map<string, PendingChange> {
  let m = changesByRun.get(runId)
  if (m === undefined) {
    m = new Map()
    // Map 保持插入序,第一个 key 就是最旧的那次运行
    if (changesByRun.size >= MAX_RUNS) {
      const oldest = changesByRun.keys().next()
      if (!oldest.done) changesByRun.delete(oldest.value)
    }
    changesByRun.set(runId, m)
  }
  return m
}

/**
 * 记一次写盘。`before === null` 表示这次是新建;后续对同一文件的写入只更新
 * `after`,`before` 与 `created` 保持首次的值。
 */
export function recordChange(
  runId: string,
  entry: { abs: string; relPath: string; before: string | null; after: string; inWorkspace: boolean }
): void {
  const m = bucket(runId)
  const existing = m.get(entry.abs)
  if (existing === undefined) {
    m.set(entry.abs, {
      abs: entry.abs,
      relPath: entry.relPath,
      before: entry.before,
      after: entry.after,
      changeKind: entry.before === null ? 'created' : 'modified',
      inWorkspace: entry.inWorkspace
    })
    return
  }
  // 已见过:只把 after 推进到最新,first-before 与 created 黏住不动。
  existing.after = entry.after
}

/** 读走并清空某次运行的采集结果 —— 供 run 收尾封包一次性取。 */
export function takeChanges(runId: string): PendingChange[] {
  const m = changesByRun.get(runId)
  if (m === undefined) return []
  changesByRun.delete(runId)
  return [...m.values()]
}

/** 测试专用:让每个用例从同一个起点开始。 */
export function resetChangeRecorderForTest(): void {
  changesByRun.clear()
}
