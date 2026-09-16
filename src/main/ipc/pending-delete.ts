/**
 * 「删除并退出」留给下一次启动的补删清单。
 *
 * ## 为什么需要它
 *
 * `storage.ts` 的 `clearLocalData` 把数据根下的受管路径先 `rename` 进一棵
 * `.delete-safety-*` 暂存树，全部搬完才真删 —— 这样任何一步失败都能整体回滚，
 * 不会留下「删了一半」的库。
 *
 * ★ 但受管清单里包含 Chromium 的 profile 目录(`GPUCache` / `Cache` / `Cookies` /
 *   `Local Storage` / `Network` …),而**主进程还活着的时候 Chromium 一直持有它们的
 *   文件句柄**。Windows 不允许 rename 一棵内部有打开句柄的目录,于是第一个 profile
 *   目录就抛 `EPERM`,整体回滚 —— 用户点「删除并退出」,结果一个字节都没删掉。
 *   这在 Windows 上不是偶发,是必然。macOS/Linux 的 rename 不看打开句柄,所以从未复现。
 *
 * 出路是把这些目录记账、推迟到**下一次启动、Chromium 打开 profile 之前**再删。
 * 那个时刻文件还没被任何人打开,`rmSync` 删得掉。
 *
 * ## 这里不 import electron
 *
 * 扫描点在 `main/index.ts` 的 `app.whenReady()` **之前**(晚一步 Chromium 就把
 * profile 打开了,又回到删不掉的老问题)。那个时机能安全使用的只有 node 内置模块。
 */
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 补删清单的文件名。它就落在数据根下,和被推迟的那些目录做邻居。 */
export const PENDING_DELETE_FILENAME = '.pending-local-data-delete.json'

interface PendingDeleteRecord {
  recordedAt: number
  paths: string[]
}

/** `path` 是否落在 `root` 这棵树里(含 root 自身)。删除边界判据全仓库只此一份。 */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function recordPath(root: string): string {
  return join(root, PENDING_DELETE_FILENAME)
}

function readRecord(root: string): PendingDeleteRecord | null {
  let raw: string
  try {
    raw = readFileSync(recordPath(root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const paths = (parsed as { paths?: unknown }).paths
    if (!Array.isArray(paths)) return null
    return {
      recordedAt: Date.now(),
      paths: paths.filter((value): value is string => typeof value === 'string' && value !== '')
    }
  } catch {
    // 半截写入或被人手改坏的清单不是删除指令。忽略它,由后面的 sweep 顺手清掉。
    return null
  }
}

/**
 * 记下这一轮删不掉、要留到下次启动补删的路径。
 *
 * 已存在的清单做并集 —— 用户可能连点两次「删除并退出」中间没重启过,
 * 覆盖写会让上一轮记的账凭空消失。
 */
export function recordPendingDelete(root: string, paths: readonly string[]): void {
  const existing = readRecord(root)
  const merged = [...new Set([...(existing?.paths ?? []), ...paths].map((path) => resolve(path)))]
  if (merged.length === 0) return
  const record: PendingDeleteRecord = { recordedAt: Date.now(), paths: merged }
  writeFileSync(recordPath(root), JSON.stringify(record, null, 2), 'utf8')
}

export interface PendingDeleteResult {
  /** 本次删掉的条数。 */
  removed: number
  /** 仍然删不掉、继续留在清单里等下一次的条数。 */
  remaining: number
}

/**
 * 启动早期补删上一轮推迟的路径。
 *
 * ★ **必须在 `app.whenReady()` 之前调用。** 晚一步 Chromium 就重新打开了 profile,
 *   Windows 上又变成删不掉,这个清单会一轮一轮地攒下去。
 *
 * ★ 清单是**磁盘上的可写文件**,不能无条件当成删除指令执行。每一条都重新校验
 *   「落在数据根里」且「不是数据根本身」—— 否则一个被改过的 JSON 就能让启动路径
 *   去删任意目录。
 *
 * 任何失败都只 warn 不抛:补删是尽力而为的收尾,绝不能挡住应用启动。
 */
export function sweepPendingDelete(root: string): PendingDeleteResult {
  const record = readRecord(root)
  if (record === null) {
    // 没有清单,或清单已损坏。文件若还在就顺手清掉,别让它永远留在数据根下。
    try {
      if (existsSync(recordPath(root))) unlinkSync(recordPath(root))
    } catch {
      /* 删不掉一个标记文件不值得打扰启动 */
    }
    return { removed: 0, remaining: 0 }
  }

  const resolvedRoot = resolve(root)
  const remaining: string[] = []
  let removed = 0
  for (const path of record.paths) {
    const target = resolve(path)
    if (target === resolvedRoot || !isWithin(resolvedRoot, target)) {
      console.warn('[storage] 忽略补删清单里越界的路径:', target)
      continue
    }
    try {
      rmSync(target, { recursive: true, force: true })
      removed++
    } catch (err) {
      console.warn('[storage] 补删失败,留到下次启动:', target, err)
      remaining.push(target)
    }
  }

  try {
    if (remaining.length === 0) unlinkSync(recordPath(root))
    else writeFileSync(recordPath(root), JSON.stringify({ recordedAt: Date.now(), paths: remaining }, null, 2), 'utf8')
  } catch (err) {
    console.warn('[storage] 更新补删清单失败:', err)
  }

  if (removed > 0) console.log(`[storage] 启动时补删了 ${removed} 项上次残留的本机数据`)
  return { removed, remaining: remaining.length }
}
