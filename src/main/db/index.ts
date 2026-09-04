/**
 * SQLite 地基。**全应用唯一持有数据库句柄的地方。**
 *
 * ## 划界:这里做完的**不是**步骤 6
 *
 * 步骤 6(会话持久化)只做了一半地基,另一半仍然空着。下一个人接手时先看这张表,
 * 别以为转录已经落盘了 —— 它现在还在 `state/store.ts` 的一个内存 Map 里:
 *
 * | 已经做了 | 仍然留给步骤 6 |
 * |---|---|
 * | 开库、WAL、`migrations` 表、`schema_version` | — |
 * | `settings` / `kv` / `workspaces` / `providers` / `model_aliases` / `credentials` | — |
 * | `model_pricing` / `usage_records`(第 3 条迁移) | — |
 * | — | `conversations` / `messages` / `runs` / `messages_fts` + 三个触发器 |
 * | — | `sessions:*` 七条、`conversations:searchAll` |
 *
 * ## 规矩
 *
 * - **所有 SQL 收在 `src/main/db/` 内**,handler 和 `state/store.ts` 都不写 SQL。
 *   这不是风格洁癖:`DatabaseSync` 是**同步 API,会阻塞主进程**,将来把整个 Db
 *   挪进 `utilityProcess` 是唯一的出路,而那一步的前提就是调用点全走访问器。
 *   同样的理由:聚合查询一律带 LIMIT 和时间窗,`VACUUM` 只在空闲时跑。
 * - 迁移**只增不改**(见 `schema.ts`)。
 * - dev 用独立的 `userData` 路径 —— 已经由 `main/index.ts` 在 app ready 之前
 *   `app.setPath('userData', …-dev)` 处理掉了,这里不需要再判一次。
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { MIGRATIONS } from './schema'

/** 库文件名。`-wal` / `-shm` 是 SQLite 自己在同目录建的兄弟文件。 */
export const DB_FILENAME = 'nextcowork.db'

const MEMORY = ':memory:'

let handle: DatabaseSync | null = null
let handlePath: string | null = null

/**
 * 预备语句缓存。`prepare()` 每次都要过一遍解析器,而 `listProviders()` 是
 * **每次路由决策都会走的**热路径(`runtime.ts` 的 `providerConfig.providers`)。
 *
 * ★ `StatementSync` 绑在具体的库句柄上,换库必须整个丢掉 —— 所以清空这个 Map
 * 是 `closeDatabase()` 的一部分,不是可选的优化。
 */
const prepared = new Map<string, StatementSync>()

function openAt(path: string): DatabaseSync {
  const d = new DatabaseSync(path, {
    // 默认就是 true,写出来是因为 model_aliases 的 ON DELETE CASCADE 全靠它。
    // ★ 这是**连接级**开关,不是存在文件里的属性:换个连接忘了开,
    // 级联就静默失效,留下一堆指向已删 provider 的悬空别名。
    enableForeignKeyConstraints: true
  })

  // WAL:读不挡写。`:memory:` 上这句是无害的空转(内存库没有日志文件)。
  d.exec('PRAGMA journal_mode = WAL')
  // WAL 下 NORMAL 是标准搭配:崩溃不会坏库,最坏丢掉最后几个已提交事务。
  d.exec('PRAGMA synchronous = NORMAL')
  /*
    单实例锁(`main/index.ts`)保证同一时刻只有一个进程开这个文件,所以争用
    几乎只会来自外面挂着的一个 sqlite3 CLI。超时取 2 秒而不是常见的 5 秒:
    `DatabaseSync` 是同步的,**等待期间整个主进程连同界面一起冻住** ——
    冻 5 秒比直接抛一个能看见的错更糟。
  */
  d.exec('PRAGMA busy_timeout = 2000')

  migrate(d)
  return d
}

/**
 * 迁移。**SQLite 的 DDL 本身是事务性的**,所以一条迁移要么整条生效、要么整条回滚,
 * 不会留下「建了三张表少建两张」的半截库 —— 这是下面那个 BEGIN/ROLLBACK 真正管用的原因。
 */
function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    d
      .prepare('SELECT version FROM migrations')
      .all()
      .map((r) => Number(r['version']))
  )

  const insert = d.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    d.exec('BEGIN')
    try {
      d.exec(m.sql)
      // 审计时间戳走 Date.now() 而不是 `host.clock` 端口:数据库层够不着宿主,
      // 而这个值只用于「什么时候升的级」,没有任何测试或计价逻辑读它。
      insert.run(m.version, m.name, Date.now())
      d.exec('COMMIT')
    } catch (err) {
      d.exec('ROLLBACK')
      // `cause` 必须挂上:迁移失败时真正有用的是 SQLite 抛的原始错(哪条语句、哪一列),
      // 只保留 String(err) 的话,栈就断在这里了
      throw new Error(`迁移 ${m.version}(${m.name})失败,库已回滚到升级前: ${String(err)}`, {
        cause: err
      })
    }
  }

  /*
    `migrations` 表是权威记录(哪些跑过、什么时候跑的);`user_version` 是它的镜像,
    存在的意义是**不懂我们表结构的工具也能回答「这个文件是第几版」** ——
    随手一个 `sqlite3 nextcowork.db 'PRAGMA user_version'` 就够了。
    PRAGMA 不能用占位符,只能拼字符串;拼进去的是我们自己常量表里的整数,不是外部输入。
  */
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
  d.exec(`PRAGMA user_version = ${latest}`)
}

/**
 * 把库开在 `dir/nextcowork.db`。由 `main/index.ts` 在 app ready 时调**一次**,
 * 且必须排在 `initRuntime()` 之前 —— seed 会往 providers 表写东西。
 *
 * ★ 已经开着就抛错,不静默换库。看起来严厉,但它挡的正是本步骤要消灭的那个 bug:
 * 有人把这句挪到 `initRuntime()` 后面 → seed 写进了那个兜底的内存库 → 换成文件库时
 * 那些行凭空消失 → 症状是「配置重启后没了」,而这恰恰是**没有持久化时的原症状**,
 * 所以没人会怀疑到调用顺序上去。
 */
export function openDatabase(dir: string): void {
  if (handle !== null) {
    throw new Error(
      handlePath === MEMORY
        ? '数据库已经以内存兜底方式打开过了 —— openDatabase() 必须排在任何读写 store 的代码之前(见 main/index.ts)'
        : `数据库已经打开:${handlePath}`
    )
  }
  /*
    ★ 目录不存在时 `DatabaseSync` 是**建不出文件**的,它只会抛
    `unable to open database file` —— 一条完全不提目录的错。全新安装、以及 dev 那个
    `…-dev` 后缀的路径都可能还没被谁建出来过,所以这一句管的是**首次启动那一次**,
    不是异常分支。
  */
  mkdirSync(dir, { recursive: true })
  handlePath = join(dir, DB_FILENAME)
  handle = openAt(handlePath)
}

/**
 * 库句柄。没人指定过位置就开一个内存库。
 *
 * ★ 这**不是测试替身**,是「没声明位置」的正确答案 —— 和 `kernel/host.ts` 把
 * `nodeHost()` 定义成真实默认值同一个思路。于是无头测试跑的是和生产完全同一条
 * 装配路径,只是库落在内存里;而不是一条「测试专用」的分支。
 *
 * @internal 只给 `src/main/db/` 内部用。外面拿到句柄就等于外面开始写 SQL 了。
 */
export function db(): DatabaseSync {
  if (handle === null) {
    handlePath = MEMORY
    handle = openAt(MEMORY)
  }
  return handle
}

/**
 * 预备语句(带缓存)。
 * @internal 同 `db()`。
 */
export function stmt(sql: string): StatementSync {
  const cached = prepared.get(sql)
  if (cached !== undefined) return cached
  const s = db().prepare(sql)
  prepared.set(sql, s)
  return s
}

/**
 * 事务。
 *
 * ★ 嵌套时借用外层事务而不是再 BEGIN 一次 —— SQLite 不支持嵌套 BEGIN,
 * 硬来会抛「cannot start a transaction within a transaction」。
 * 于是访问器可以放心地互相调用,不必各自知道自己是不是最外层。
 *
 * @internal 同 `db()`。
 */
export function tx<T>(fn: () => T): T {
  const d = db()
  if (d.isTransaction) return fn()
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

/**
 * 异步事务，供需要跨越安全存储/原生 API 的数据导入使用。
 *
 * `DatabaseSync` 本身是同步句柄，但导入的凭证写入接口是 Promise。若先
 * 提交 SQLite、再写凭证，第二个写入失败时就无法满足「导入失败 = 完全不变」。
 * 这里让事务保持打开直到 Promise 完成；嵌套调用沿用外层事务，和 `tx` 的
 * 语义一致。主进程同一时刻只有一个导入操作，因此不会出现两个异步事务交叉。
 */
export async function txAsync<T>(fn: () => T | Promise<T>): Promise<T> {
  const d = db()
  if (d.isTransaction) return await fn()
  d.exec('BEGIN')
  try {
    const out = await fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    try { d.exec('ROLLBACK') } catch { /* 原始错误更有用 */ }
    throw err
  }
}

/** 关库。退出前调,或测试里重置。 */
export function closeDatabase(): void {
  prepared.clear()
  handle?.close()
  handle = null
  handlePath = null
}

/**
 * 库文件与 WAL 的字节数(`storage:getStats` 用)。
 * 内存库、以及 WAL 刚被 checkpoint 掉的时候都会是 0 —— 那是事实,不是错误。
 */
export function fileStats(): { dbBytes: number; walBytes: number } {
  if (handlePath === null || handlePath === MEMORY) return { dbBytes: 0, walBytes: 0 }
  const size = (p: string): number => {
    try {
      return statSync(p).size
    } catch {
      return 0
    }
  }
  return { dbBytes: size(handlePath), walBytes: size(`${handlePath}-wal`) }
}

/** 当前数据库主文件路径；未指定文件库时返回 null（测试内存库）。 */
export function databaseFilePath(): string | null {
  return handlePath === null || handlePath === MEMORY ? null : handlePath
}

/** 当前连接已经执行到的 schema 版本，供备份 manifest 校验使用。 */
export function databaseSchemaVersion(): number {
  const row = db().prepare('PRAGMA user_version').get() as Record<string, unknown>
  return Number(row['user_version'] ?? 0)
}

/** 在复制快照或替换文件前把 WAL 合并并截断。 */
export function checkpointDatabase(): void {
  db().exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

/**
 * 整理库文件。**同步且可能很慢**(要重写整个文件),
 * 所以只由用户在设置-数据页显式点、不自动跑 —— 方案 §9。
 */
export function vacuumDatabase(): void {
  const d = db()
  // WAL 先落盘再 VACUUM,否则刚删掉的数据还占着 -wal,回收不到位
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  d.exec('VACUUM')
}
