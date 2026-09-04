/**
 * 「这次运行里读过哪些文件」—— `Write` / `Edit` 的前置条件。
 *
 * ★ 这是 Claude Code 的一条硬规则,照搬过来:**没 `Read` 过的已有文件不许写**。
 *
 * 它防的是一类具体的破坏:模型凭记忆(或凭文件名的猜测)整体覆盖一个文件,
 * 把它没看见的那些内容一起抹掉。这种错误在转录里看起来完全正常 ——
 * `Write` 报告「已写入」,模型报告「已完成」,只有用户几天后才发现少了东西。
 * 提示词里写「请先读」是拦不住的,必须是工具层的拒绝。
 *
 * 状态按 **runId** 分桶,不是全局:一次新的运行应当重新确认文件的当下内容,
 * 而不是继承上一次运行几分钟前读到的那一版。
 */

/** 最多记住几次运行。超了丢最旧的 —— 没有 run 结束的钩子,只能靠这个封顶。 */
const MAX_RUNS = 64

const readByRun = new Map<string, Set<string>>()

function bucket(runId: string): Set<string> {
  let s = readByRun.get(runId)
  if (s === undefined) {
    s = new Set()
    // Map 保持插入序,第一个 key 就是最旧的那次运行
    if (readByRun.size >= MAX_RUNS) {
      const oldest = readByRun.keys().next()
      if (!oldest.done) readByRun.delete(oldest.value)
    }
    readByRun.set(runId, s)
  }
  return s
}

export function markRead(runId: string, abs: string): void {
  bucket(runId).add(abs)
}

export function wasRead(runId: string, abs: string): boolean {
  return readByRun.get(runId)?.has(abs) === true
}

/** 测试专用:让每个用例从同一个起点开始。 */
export function resetReadTrackerForTest(): void {
  readByRun.clear()
}
