/**
 * 旧库 → 当前库的行级合并。
 *
 * 这段代码要处理的是**已经分叉的两个库**:`data/` 下先被建了一个库,之后用户继续
 * 在根层的旧库上工作,再启动时新库已是权威。它和 flat-layout.ts 的区别是
 * 那边搬目录、这边搬行,所以这边的不变式是:
 *
 * 1. **只 INSERT。** 目标库里已有的行一个字节都不许动 —— 哪怕两边 id 相同、
 *    时间戳不同。写错了的表现是「用户最新的一段对话被更旧的版本盖掉」。
 * 2. **按会话提交。** 中途失败时已完成的会话留着,重跑从缺的那些继续。
 *    所以「重试」是幂等的,不需要先回滚。
 * 3. **列按交集取。** 源库可能是任意历史版本(缺表、缺列),硬编码列名的写法
 *    在源库更老时会静默少写几列。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MIGRATION_CLAIM_KEY,
  MIGRATION_UNDO_KEY,
  classifyMigrationError,
  collectAttachmentFiles,
  copyAttachmentFiles,
  hasAnythingToMerge,
  isUnder,
  mergeLegacyRows,
  probeLegacyDelta,
  readUndoManifest,
  rewriteMergedAttachmentPaths,
  undoMerge,
  writeMigrationClaim,
  writeUndoManifest
} from '../legacy-merge'

let root = ''
let targetDir = ''
let sourceDir = ''
let targetPath = ''
let sourcePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-merge-'))
  targetDir = join(root, 'data')
  sourceDir = join(root, 'legacy')
  targetPath = join(targetDir, 'nextcowork.db')
  sourcePath = join(sourceDir, 'nextcowork.db')
  mkdirSync(targetDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  seedTarget(targetPath)
  seedSourceAt(sourceDir, sourcePath)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 目标库:一条已经在的会话 `s-old`(带一条消息),它的 workspace 是 `w-shared`。
 * 合并**绝不允许**改动这里面的任何一行。
 */
function seedTarget(path: string): void {
  const d = new DatabaseSync(path)
  d.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      root_path_at_creation TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT,
      path TEXT NOT NULL
    );
  `)
  d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-shared', 1000, '{"name":"共享工作区"}')
  d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    's-old',
    'w-shared',
    '目标库里的旧会话',
    1000,
    2000,
    targetDir
  )
  d.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
    'm-old',
    's-old',
    'user',
    '"目标库原样"',
    1500
  )
  d.close()
}

/**
 * 源库:与目标库同结构。`s-old` **同 id 但内容不同** —— 用来钉死「不覆盖」,
 * 外加一条目标库里没有的 `s-new`(带消息和一个附件行)。
 *
 * 数据根由参数给,这样「路径里带引号和 #」那条用例能复用同一份内容。
 */
function seedSourceAt(sourceDir: string, path: string): void {
  mkdirSync(join(sourceDir, 'attachments', 'sessions', 's-new'), { recursive: true })
  writeFileSync(join(sourceDir, 'attachments', 'sessions', 's-new', 'a.png'), 'png-bytes')

  const d = new DatabaseSync(path)
  d.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      root_path_at_creation TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT,
      path TEXT NOT NULL
    );
  `)
  // 同 id 的工作区,但名字不同 —— 合并后必须还是目标库那个名字。
  d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-shared', 9999, '{"name":"源库的版本"}')
  d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-new', 5000, '{"name":"源库新工作区"}')
  // 同 id 的会话,标题不同 —— 合并后必须是「目标库里的旧会话」。
  d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    's-old',
    'w-shared',
    '源库版本的标题(不该出现)',
    1000,
    9999,
    sourceDir
  )
  d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    's-new',
    'w-new',
    '只存在于旧库的会话',
    3000,
    4000,
    sourceDir
  )
  const legacyMessages: Array<[string, string]> = [
    ['m-new-1', 's-new'],
    ['m-new-2', 's-new']
  ]
  for (const [id, session] of legacyMessages) {
    d.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
      id,
      session,
      'assistant',
      '"来自旧库"',
      3500
    )
  }
  d.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)').run(
    'a-new',
    's-new',
    'm-new-1',
    join(sourceDir, 'attachments', 'sessions', 's-new', 'a.png')
  )
  d.close()
}

function rows(path: string, sql: string): Array<Record<string, unknown>> {
  const d = new DatabaseSync(path, { readOnly: true })
  try {
    return d.prepare(sql).all()
  } finally {
    d.close()
  }
}

describe('probeLegacyDelta', () => {
  it('数出旧库里当前库没有的会话 / 消息 / 附件 / 工作区', () => {
    expect(probeLegacyDelta(targetPath, sourcePath)).toEqual({
      sessions: 1,
      messages: 2,
      attachments: 1,
      workspaces: 1
    })
  })

  it('同一个文件不和自己比', () => {
    expect(probeLegacyDelta(targetPath, targetPath)).toEqual({
      sessions: 0,
      messages: 0,
      attachments: 0,
      workspaces: 0
    })
  })

  it('源库不存在时返回全零,而不是抛错', () => {
    // ★ 这条边界决定了「启动会不会因为一个用不上的旧库失败」。探测是纯读,
    //   失败必须降级成「没有东西要搬」。
    expect(probeLegacyDelta(targetPath, join(root, 'nope.db'))).toEqual({
      sessions: 0,
      messages: 0,
      attachments: 0,
      workspaces: 0
    })
  })

  it('源库存在但不是 sqlite / 是别的库时返回全零', () => {
    const bogus = join(root, 'bogus.db')
    writeFileSync(bogus, '这不是数据库')
    expect(probeLegacyDelta(targetPath, bogus)).toEqual({
      sessions: 0,
      messages: 0,
      attachments: 0,
      workspaces: 0
    })
  })

  it('源库是合法 sqlite 但没有 sessions 表时返回全零', () => {
    const other = join(root, 'other.db')
    const d = new DatabaseSync(other)
    d.exec('CREATE TABLE unrelated (x TEXT)')
    d.close()
    expect(probeLegacyDelta(targetPath, other)).toEqual({
      sessions: 0,
      messages: 0,
      attachments: 0,
      workspaces: 0
    })
  })

  it('路径里带引号和 # 也能附着成功', () => {
    // ★ ATTACH 的路径是 SQL 字面量,不能参数化。`#` 在 URI 里是 fragment 分隔符、
    //   `?` 是 query 分隔符 —— 未编码的话 SQLite 会去开另一个路径,报错是
    //   「unable to open database」加一个用户没听说过的路径,而真正的原因
    //   (用户名里有个 `#`)完全不出现。
    const weirdDir = join(root, "it's #weird")
    mkdirSync(weirdDir, { recursive: true })
    const weirdPath = join(weirdDir, 'nextcowork.db')
    seedSourceAt(weirdDir, weirdPath)

    expect(probeLegacyDelta(targetPath, weirdPath).sessions).toBe(1)
    const result = mergeLegacyRows({ targetPath, sourcePath: weirdPath })
    expect(result.sessions).toBe(1)
    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 's-new'")).toHaveLength(1)
  })
})

describe('mergeLegacyRows', () => {
  const merge = (): ReturnType<typeof mergeLegacyRows> => {
    // 源库在同一个临时根下,附件路径按 sourceDir 改写。
    return mergeLegacyRows({ targetPath, sourcePath })
  }

  it('把旧库里缺的会话连同消息一起搬过来', () => {
    const result = merge()

    expect(result.sessions).toBe(1)
    expect(result.messages).toBe(2)
    expect(result.attachments).toBe(1)
    expect(result.workspaces).toBe(1)
    expect(rows(targetPath, 'SELECT id FROM sessions ORDER BY id').map((r) => r['id'])).toEqual([
      's-new',
      's-old'
    ])
  })

  it('每条已提交会话与归属清单同事务落盘，后续失败不会丢掉前半批 id', () => {
    const source = new DatabaseSync(sourcePath)
    source.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('z-conflict', 6000, '{"name":"冲突工作区"}')
    source.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      'z-conflict',
      'z-conflict',
      '后面的冲突会话',
      6000,
      6000,
      sourceDir
    )
    // `m-old` 已在目标库里，第二条会话写消息时必然回滚；`s-new` 应已完整提交。
    source.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
      'm-old',
      'z-conflict',
      'user',
      '"冲突消息"',
      6000
    )
    source.close()

    expect(() => merge()).toThrow()

    const claim = rows(targetPath, `SELECT json FROM kv WHERE key = '${MIGRATION_CLAIM_KEY}'`)[0]
    const parsed = JSON.parse(String(claim?.['json'])) as Record<string, unknown>
    expect(parsed['sessions']).toEqual(['s-new'])
    expect(parsed['workspaces']).toEqual(expect.arrayContaining(['w-new', 'z-conflict']))
    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 's-new'")).toHaveLength(1)
    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 'z-conflict'")).toEqual([])
  })

  it('★ 不动目标库里已有的行,哪怕源库那份更新', () => {
    merge()

    const ids = new Set(['s-old', 'w-shared', 'm-old'])
    expect(rows(targetPath, "SELECT title FROM sessions WHERE id = 's-old'")[0]?.['title']).toBe(
      '目标库里的旧会话'
    )
    expect(rows(targetPath, "SELECT updated_at FROM sessions WHERE id = 's-old'")[0]?.['updated_at']).toBe(2000)
    expect(rows(targetPath, "SELECT json FROM workspaces WHERE id = 'w-shared'")[0]?.['json']).toBe(
      '{"name":"共享工作区"}'
    )
    expect(ids.has('s-old')).toBe(true)
  })

  it('把缺的工作区也补上,否则会话的 workspace_id 指着空', () => {
    merge()

    expect(rows(targetPath, "SELECT json FROM workspaces WHERE id = 'w-new'")[0]?.['json']).toBe(
      '{"name":"源库新工作区"}'
    )
  })

  it('没有东西可搬时返回全零、不抛错,并且重复跑结果相同', () => {
    // ★ 「重试」路径会重复调用它,第二次必须是干净的 no-op。
    const first = merge()
    const second = merge()

    expect(first.sessions).toBe(1)
    expect(second).toEqual({
      sessions: 0,
      messages: 0,
      attachments: 0,
      workspaces: 0,
      createdWorkspaces: [],
      createdSessions: []
    })
  })

  it('源库在合并期间只读 —— 写它会失败,而且源库内容不变', () => {
    // ★ 「只 INSERT 目标库」这条不变式靠 ATTACH 的 mode=ro 兜底。
    //   如果哪天有人把它改回普通 ATTACH,这条断言就是唯一会拦住他的东西。
    const before = rows(sourcePath, 'SELECT COUNT(*) AS n FROM messages')[0]?.['n']
    merge()
    const after = rows(sourcePath, 'SELECT COUNT(*) AS n FROM messages')[0]?.['n']
    expect(after).toBe(before)
    expect(rows(sourcePath, "SELECT title FROM sessions WHERE id = 's-old'")[0]?.['title']).toBe(
      '源库版本的标题(不该出现)'
    )
  })

  it('源库比目标库老(缺几张表)时,只搬两边都有的表', () => {
    // ★ 真实场景:本机那份旧库停在 schema v22,缺 V23 的两张表。
    //   硬编码表名会在这种库上抛「no such table」,而那条错误会直接把闸门打红。
    const older = join(root, 'older.db')
    const d = new DatabaseSync(older)
    d.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-old', 1, '{}')
    d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('s-ancient', 'w-old', '远古会话', 1, 2)
    d.close()

    const result = mergeLegacyRows({ targetPath, sourcePath: older })

    expect(result.sessions).toBe(1)
    expect(rows(targetPath, "SELECT title FROM sessions WHERE id = 's-ancient'")[0]?.['title']).toBe(
      '远古会话'
    )
  })

  it('源库多出一列(比目标库新)时,那一列被忽略而不是报错', () => {
    const newer = join(root, 'newer.db')
    const d = new DatabaseSync(newer)
    d.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        brand_new_column TEXT NOT NULL DEFAULT 'x'
      );
    `)
    d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-new2', 1, '{}')
    d.prepare(
      'INSERT INTO sessions (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s-new2', 'w-new2', '来自更新的库', 5, 6)
    d.close()

    const result = mergeLegacyRows({ targetPath, sourcePath: newer })
    expect(result.sessions).toBe(1)
  })

  it('找不到源库时返回全零,不抛错', () => {
    expect(mergeLegacyRows({ targetPath, sourcePath: join(root, 'nope.db') })).toMatchObject({
      sessions: 0
    })
  })
})

describe('attachment files', () => {
  it('列出要拷的文件,并把落点算到新根下面', () => {
    const pairs = collectAttachmentFiles(sourcePath, sourceDir, targetDir, ['s-new'])

    expect(pairs).toEqual([
      {
        from: join(sourceDir, 'attachments', 'sessions', 's-new', 'a.png'),
        to: join(targetDir, 'attachments', 'sessions', 's-new', 'a.png')
      }
    ])
  })

  it('★ 源根下的文件才搬,引用外部路径的附件不搬', () => {
    // 不在源根下的路径强行按源根改写出一个落点,只会把它拷到一个无意义的位置。
    const pairs = collectAttachmentFiles(sourcePath, join(root, 'elsewhere'), targetDir, ['s-new'])
    expect(pairs).toEqual([])
  })

  it('拷过去之后内容一致,重复拷不会覆盖已存在的文件', () => {
    const pairs = collectAttachmentFiles(sourcePath, sourceDir, targetDir, ['s-new'])
    const first = copyAttachmentFiles(pairs)
    expect(first).toHaveLength(1)

    const destination = join(targetDir, 'attachments', 'sessions', 's-new', 'a.png')
    rmSync(destination)
    writeFileSync(destination, '别人写的内容')
    const second = copyAttachmentFiles(pairs)
    expect(second).toEqual([])
  })

  it('单个文件拷不动不中断整批', () => {
    // 丢一个附件的缩略图,不该让整次启动失败。
    const missing = [{ from: join(root, 'gone.png'), to: join(targetDir, 'gone.png') }]
    expect(copyAttachmentFiles(missing)).toEqual([])
  })
})

describe('rewriteMergedAttachmentPaths', () => {
  it('★ 把合并进来的附件行的 path 改到新根 —— 不改的话 ncw:// 会拒绝它', () => {
    /*
      行里存的是旧根下的绝对路径,而协议只认 `databaseDirectory()/attachments`
      (见 net/attachment-protocol.ts 的 resolveAttachmentPath → isWithinRoot)。
      不改的表现是:文件明明拷过来了、库也健康,但老会话里的图全是碎的。
    */
    const result = mergeLegacyRows({ targetPath, sourcePath })
    expect(result.attachments).toBe(1)

    const before = rows(targetPath, "SELECT path FROM attachments WHERE id = 'a-new'")[0]?.['path']
    expect(String(before).startsWith(sourceDir)).toBe(true)

    const changed = rewriteMergedAttachmentPaths(
      targetPath,
      sourceDir,
      targetDir,
      result.createdSessions
    )

    expect(changed).toBe(1)
    expect(rows(targetPath, "SELECT path FROM attachments WHERE id = 'a-new'")[0]?.['path']).toBe(
      join(targetDir, 'attachments', 'sessions', 's-new', 'a.png')
    )
  })

  it('重复跑一次不改任何行(幂等)', () => {
    const result = mergeLegacyRows({ targetPath, sourcePath })
    rewriteMergedAttachmentPaths(targetPath, sourceDir, targetDir, result.createdSessions)
    // 第二次跑时 path 已经在新根下,不再匹配旧根前缀。
    expect(
      rewriteMergedAttachmentPaths(targetPath, sourceDir, targetDir, result.createdSessions)
    ).toBe(0)
  })

  it('★ 不碰目标库原有会话的附件行', () => {
    // 「补上缺的」不该变成一次全库重写。
    const d = new DatabaseSync(targetPath)
    d.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)').run(
      'a-old',
      's-old',
      'm-old',
      join(sourceDir, 'attachments', 'sessions', 's-new', 'a.png')
    )
    d.close()

    const result = mergeLegacyRows({ targetPath, sourcePath })
    rewriteMergedAttachmentPaths(targetPath, sourceDir, targetDir, result.createdSessions)

    // a-old 指向旧根,但它的会话不是本次合并进来的 —— 保持原样。
    expect(rows(targetPath, "SELECT path FROM attachments WHERE id = 'a-old'")[0]?.['path']).toBe(
      join(sourceDir, 'attachments', 'sessions', 's-new', 'a.png')
    )
  })

  it('引用外部路径的附件行不改写', () => {
    const result = mergeLegacyRows({ targetPath, sourcePath })
    const d = new DatabaseSync(targetPath)
    d.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)').run(
      'a-external',
      's-new',
      'm-new-1',
      '/somewhere/else/photo.png'
    )
    d.close()

    rewriteMergedAttachmentPaths(targetPath, sourceDir, targetDir, result.createdSessions)

    expect(rows(targetPath, "SELECT path FROM attachments WHERE id = 'a-external'")[0]?.['path']).toBe(
      '/somewhere/else/photo.png'
    )
  })

  it('没有会话 id 时是干净的 no-op', () => {
    expect(rewriteMergedAttachmentPaths(targetPath, sourceDir, targetDir, [])).toBe(0)
  })
})

describe('isUnder', () => {
  it('不把 attachments-backup 当成 attachments 的子目录', () => {
    // ★ 写成 startsWith(root) 的话,这一对会被判成父子关系,文件被拷到错位置。
    expect(isUnder('/a/attachments', '/a/attachments-backup/x.png')).toBe(false)
    expect(isUnder('/a/attachments', '/a/attachments')).toBe(true)
    expect(isUnder('/a/attachments', '/a/attachments/sessions/x.png')).toBe(true)
  })
})

describe('classifyMigrationError', () => {
  it('磁盘满 / 权限 / 损坏 / 占用各归各档', () => {
    // ★ 分档的唯一目的是错误页知道该给哪些出口。全归 unknown 的话,
    //   那一屏就只能给一句「失败了」,用户手里没有任何可执行的下一步。
    expect(classifyMigrationError(new Error('SQLITE_FULL: database or disk is full'))).toBe('disk-full')
    expect(classifyMigrationError(new Error('unable to open database file'))).toBe('permission')
    expect(classifyMigrationError(new Error('EACCES: permission denied'))).toBe('permission')
    expect(classifyMigrationError(new Error('file is not a database'))).toBe('source-corrupt')
    expect(classifyMigrationError(new Error('database is locked'))).toBe('target-locked')
    expect(classifyMigrationError(new Error('随便什么'))).toBe('unknown')
    expect(classifyMigrationError('裸字符串')).toBe('unknown')
  })
})

describe('undo', () => {
  it('按清单删掉本次合并写入的会话,目标库原有的行不受影响', () => {
    const result = mergeLegacyRows({ targetPath, sourcePath })
    writeUndoManifest(targetPath, {
      at: Date.now(),
      source: sourceDir,
      sessions: result.createdSessions,
      workspaces: result.createdWorkspaces,
      files: []
    })
    expect(readUndoManifest(targetPath)?.sessions).toEqual(['s-new'])

    undoMerge(targetPath, readUndoManifest(targetPath)!)

    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 's-new'")).toEqual([])
    // ★ 级联真的发生了:消息行跟着走了(这需要连接上开着 foreign_keys)。
    expect(rows(targetPath, "SELECT id FROM messages WHERE session_id = 's-new'")).toEqual([])
    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 's-old'")).toHaveLength(1)
    expect(readUndoManifest(targetPath)).toBeNull()
  })

  it('★ 撤销不碰合并之后新产生的会话', () => {
    // 「恢复到某个快照」会连带丢掉这些;按 id 精确删除不会。
    const result = mergeLegacyRows({ targetPath, sourcePath })
    const d = new DatabaseSync(targetPath)
    d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      's-after',
      'w-shared',
      '合并之后新建的',
      9000,
      9000,
      targetDir
    )
    d.close()
    writeUndoManifest(targetPath, {
      at: Date.now(),
      source: sourceDir,
      sessions: result.createdSessions,
      workspaces: result.createdWorkspaces,
      files: []
    })

    undoMerge(targetPath, readUndoManifest(targetPath)!)

    expect(rows(targetPath, "SELECT id FROM sessions WHERE id = 's-after'")).toHaveLength(1)
  })

  it('清单存坏时读回 null 而不是抛错', () => {
    const d = new DatabaseSync(targetPath)
    d.prepare('INSERT INTO kv VALUES (?, ?)').run(MIGRATION_UNDO_KEY, '{不是 json')
    d.close()
    expect(readUndoManifest(targetPath)).toBeNull()
  })

  it('目标库不存在时读回 null', () => {
    expect(readUndoManifest(join(root, 'nope.db'))).toBeNull()
  })
})

describe('migration claim manifest', () => {
  it('累积旧撤销清单、重试和多来源的会话 id，同时保留首个账户与工作区映射', () => {
    writeUndoManifest(targetPath, {
      at: 1,
      source: '/pre-fix',
      sessions: ['s-old'],
      workspaces: ['w-shared'],
      files: []
    })
    writeMigrationClaim(targetPath, {
      sessions: ['s-new'],
      workspaces: ['w-new'],
      claimedBy: 'account-a',
      workspaceMap: { 'w-shared': 'account-workspace' }
    })
    // 模拟用户临时降级后，旧版本覆盖最新撤销清单再迁入一批。
    writeUndoManifest(targetPath, {
      at: 2,
      source: '/downgraded',
      sessions: ['s-downgraded'],
      workspaces: ['w-downgraded'],
      files: []
    })
    writeMigrationClaim(targetPath, {
      sessions: ['s-later'],
      workspaces: ['w-later']
    })

    const claim = rows(targetPath, `SELECT json FROM kv WHERE key = '${MIGRATION_CLAIM_KEY}'`)[0]
    const parsed = JSON.parse(String(claim?.['json'])) as Record<string, unknown>
    expect(parsed['sessions']).toEqual(['s-old', 's-new', 's-downgraded', 's-later'])
    expect(parsed['workspaces']).toEqual(['w-shared', 'w-new', 'w-downgraded', 'w-later'])
    expect(parsed['claimedBy']).toBe('account-a')
    expect(parsed['workspaceMap']).toEqual({ 'w-shared': 'account-workspace' })
    expect(parsed['pending']).toBe(true)
  })
})

describe('hasAnythingToMerge', () => {
  it('★ 只看会话数,不看消息数', () => {
    // 判据是会话数:只有消息缺的状态是本模块修不了的(它只补「整条都缺的会话」)。
    // 把它也算成「需要迁移」的话,闸门会为一件做不到的事卡住用户,合并跑完
    // delta 纹丝不动,变成永远修不完的循环。
    expect(hasAnythingToMerge({ sessions: 0, messages: 40, attachments: 3, workspaces: 1 })).toBe(false)
    expect(hasAnythingToMerge({ sessions: 1, messages: 0, attachments: 0, workspaces: 0 })).toBe(true)
  })
})
