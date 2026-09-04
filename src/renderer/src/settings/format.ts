/** 「数据」页把 `StorageStats` 的裸字节数变成人看的样子。纯函数,有测试。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * `formatBytes(undefined)` 走 `—` 而不是 `NaN B` —— 步骤 6 之前
 * `storage:getStats` 还没实现,拿不到数;而 `NaN MB` 出现在界面上时,
 * 没人能一眼看出它是「没实现」还是「算错了」。
 */
export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${UNITS[i]}`
}

export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return '—'
  return String(Math.round(n))
}
