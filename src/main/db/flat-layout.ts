/**
 * 扁平布局(应用数据与 Chromium profile 同层)→ `data/` 子目录的一次性收拢。
 *
 * ## 为什么要分层
 *
 * `~/.next-cowork` 一身二任:既是 Electron 的 userData(Chromium 把 30 来个
 * profile 条目扁平铺在根层),又是应用自己的数据根。两套命名风格互不相干
 * (Chromium 用 `Title Case` 带空格,我们用小写),Finder 一按字母排序就彻底
 * 交错 —— 用户分不出哪些是自己的数据、哪些是能随手删掉的缓存。
 *
 * 收拢之后 `data/` 归我们,根层归 Chromium。
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑要搬用户全部的真实数据,是启动路径上风险最高的一段。留在
 * `main/index.ts` 里它就是不可测的 —— 那个文件一被 import 就会跑整个 app 引导。
 * 这里只依赖 node 内置模块,测试可以直接调。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILENAME } from './index'
import { PROFILE_DIRECTORY_SEGMENT } from './config-profile'
import { GLOBAL_SETTINGS_FILENAME } from '../kernel/local-settings'

/**
 * 扁平布局时代留在 profile 根下的应用条目 —— 这次要收进 `data/`。
 *
 * ★ 不含 `themes`。根层的 `themes/` 是更老的遗留,`ipc/theme.ts` 的
 * `legacyThemesDir()` 仍按 `app.getPath('userData')`(= profile 根)去找它,
 * 由那条一次性迁移搬进 `attachments/themes`。这里插一手会让它扑空。
 *
 * ★ 不含 Chromium 的任何东西,也不含 `Partitions`:它们本来就该留在根层,
 * 原地不动就是正确结果。
 */
export const FLAT_LAYOUT_ENTRIES = [
  'attachments',
  'skills',
  'agents',
  'commands',
  'modes',
  'workspaces',
  'plugins',
  PROFILE_DIRECTORY_SEGMENT,
  'AGENTS.md',
  GLOBAL_SETTINGS_FILENAME
] as const

/**
 * 把 profile 根下的应用数据搬进 `targetDir`。
 *
 * ★ 用 `rename` 不用 copy。目标是同一个卷里的子目录,rename 是元数据操作:
 * 原子、瞬时、不需要第二份 399M 的空间。代价是成功之后旧布局不复存在,
 * 所以中途失败必须**逆序 rename 回原位** —— 半截搬运会让下一次启动看到一个
 * 没有库的 `data/`,然后一切从零开始,而用户的会话还散落在根层。
 *
 * ★ 目标已存在的条目跳过而不是覆盖:上一轮可能搬到一半崩了。
 *
 * ★ 没有库就什么都不搬。空目录、或者只有 Chromium 条目的根,不是「待迁移的
 * 旧布局」,而是一个全新的 profile —— 对它动手只会凭空造出一个 `data/`。
 *
 * @returns 是否真的搬了东西。
 */
export function migrateFlatLayout(profileRoot: string, targetDir: string): boolean {
  if (!existsSync(join(profileRoot, DB_FILENAME))) return false

  const moved: Array<{ from: string; to: string }> = []
  try {
    mkdirSync(targetDir, { recursive: true })
    const names = [DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`, ...FLAT_LAYOUT_ENTRIES]
    for (const name of names) {
      const from = join(profileRoot, name)
      const to = join(targetDir, name)
      if (!existsSync(from) || existsSync(to)) continue
      renameSync(from, to)
      moved.push({ from, to })
    }
  } catch (err) {
    for (const entry of [...moved].reverse()) {
      try {
        renameSync(entry.to, entry.from)
      } catch (rollbackError) {
        console.error('[db] 扁平布局迁移回滚失败:', entry.from, rollbackError)
      }
    }
    throw err
  }
  return moved.length > 0
}

/** `path` 是否就是 `root` 本身或它下面的一条。防止 `workspaces-backup` 被当成 `workspaces`。 */
function isUnder(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
}

/**
 * 工作区根路径的改写。
 *
 * ★ 它**不是一个列**。`workspaces` 表只有 `id` / `last_opened_at` / `json`,
 * `rootPath` 埋在 `json` 里 —— 所以这里不能像另外两张表那样用 `REPLACE(列, …)`,
 * 只能把行读出来、`JSON.parse`、改字段、写回去。
 *
 * 顺带也绕开了 JSON 转义:Windows 的 `C:\Users\…` 在 json 文本里是 `C:\\Users\\…`,
 * 拿原始路径去做字符串 REPLACE 一条都匹配不上,而且不会报错 —— 只会表现成
 * 「迁移之后工作区是空的」。
 */
function rewriteWorkspaceRoots(db: DatabaseSync, legacyRoot: string, targetDir: string): void {
  const from = join(legacyRoot, 'workspaces')
  const to = join(targetDir, 'workspaces')
  const update = db.prepare('UPDATE workspaces SET json = ? WHERE id = ?')
  for (const row of db.prepare('SELECT id, json FROM workspaces').all()) {
    if (typeof row.id !== 'string' || typeof row.json !== 'string') continue
    let parsed: { rootPath?: unknown }
    try {
      parsed = JSON.parse(row.json) as { rootPath?: unknown }
    } catch {
      // 存坏了的行不是迁移该管的事,原样留着。
      continue
    }
    const rootPath = parsed.rootPath
    if (typeof rootPath !== 'string' || !isUnder(from, rootPath)) continue
    parsed.rootPath = to + rootPath.slice(from.length)
    update.run(JSON.stringify(parsed), row.id)
  }
}

/**
 * 把库里存着的绝对路径从旧根改写到新根。
 *
 * ★ 工作区那一条原先是漏的。`runtime.ts` 建默认工作区时把绝对路径写了进去,
 * 不改的话迁移之后它指向一个已经不存在的目录 —— 而界面上只会表现成
 * 「我的文件都没了」。
 *
 * ★ 整段包在一个事务里。文件这时候**已经搬完了**,改到一半的路径表比一条没改
 * 更难收拾:前者是一半会话指着新根、一半指着旧根,后者至少还能整体重来。
 *
 * 失败只 warn 不抛:路径没改对是能在界面上看出来并纠正的问题,
 * 而让它掀掉整个启动不是。
 */
export function rewriteMigratedPaths(dbPath: string, legacyRoot: string, targetDir: string): void {
  // 表名/列名都是本文件里的字面量,不经过任何外部输入。
  const rewrites = [
    ['attachments', 'path', 'attachments'],
    ['sessions', 'root_path_at_creation', 'workspaces']
  ] as const
  let migrated: DatabaseSync | null = null
  try {
    migrated = new DatabaseSync(dbPath)
    migrated.exec('BEGIN')
    try {
      for (const [table, column, segment] of rewrites) {
        const from = join(legacyRoot, segment)
        migrated
          .prepare(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ?`)
          .run(from, join(targetDir, segment), `${from}%`)
      }
      rewriteWorkspaceRoots(migrated, legacyRoot, targetDir)
      migrated.exec('COMMIT')
    } catch (err) {
      migrated.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    console.warn(`[db] 旧数据库路径迁移未完成，将保留原数据并继续启动: ${String(err)}`)
  } finally {
    // ★ 一定要关。紧接着 openDatabase() 就要打开同一个文件,
    //   Windows 上一个漏掉的句柄就是一次启动失败。
    try {
      migrated?.close()
    } catch {
      /* 已经关掉或从没打开成功 */
    }
  }
}
