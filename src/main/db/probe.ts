/**
 * 步骤 0 的 node:sqlite 可用性探针(方案 §9)。
 *
 * Electron 编译自己的 Node 构建 —— 上游 Node 24 有 node:sqlite,不代表 Electron 的
 * Node 一定编进了它。所以这里用**动态** import 包在 try/catch 里:静态 import 会在
 * 模块加载时就抛,探针也就没得探了。
 *
 * 探针结论决定 §9 走哪条路:通了就零原生模块;不通就退回 better-sqlite3@13
 * (需要 rebuild + asarUnpack,和 node-pty 同一条链路)。
 */

export type SqliteProbeResult =
  | { ok: true; sqliteVersion: string; fts5: boolean; json1: boolean; rtree: boolean }
  | { ok: false; reason: string }

/** 跑一段 SQL,只关心成没成 —— 用来判断某个编译期特性在不在。 */
function supports(exec: (sql: string) => void, sql: string): boolean {
  try {
    exec(sql)
    return true
  } catch {
    return false
  }
}

export async function probeSqlite(): Promise<SqliteProbeResult> {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (err) {
    return { ok: false, reason: `import 失败: ${(err as Error)?.message ?? String(err)}` }
  }

  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(':memory:')
    const exec = (sql: string): void => db!.exec(sql)

    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v?: string } | undefined
    const sqliteVersion = row?.v ?? 'unknown'

    return {
      ok: true,
      sqliteVersion,
      // 全局搜索(conversations:searchAll)靠 FTS5,这一项是刚需
      fts5: supports(exec, 'CREATE VIRTUAL TABLE _probe_fts USING fts5(x)'),
      json1: supports(exec, "SELECT json_valid('{}')"),
      rtree: supports(exec, 'CREATE VIRTUAL TABLE _probe_rtree USING rtree(id, m0, m1)')
    }
  } catch (err) {
    return { ok: false, reason: `打开内存库失败: ${(err as Error)?.message ?? String(err)}` }
  } finally {
    try {
      db?.close()
    } catch {
      /* 探针关不掉也无所谓,进程退出会收 */
    }
  }
}
