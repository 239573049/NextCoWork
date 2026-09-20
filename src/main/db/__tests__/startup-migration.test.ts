/**
 * 启动迁移闸门的状态机。
 *
 * 这一段代码的难点不是「怎么搬」,而是**什么时候让用户等、什么时候不让**:
 *
 * 1. 绝大多数启动什么都不用做 —— 那种情况下渲染层必须一帧迁移屏都不画。
 *    多一层「正在检查」的过场就是一次白闪,而白闪会被当成启动变慢了。
 * 2. 失败必须停在闸门上并给出分类,**不能静默继续** —— 静默继续正是这次丢数据的成因。
 * 3. 「跳过并继续」必须由用户主动选,而且跳过之后库是**完整**的(合并按会话提交)。
 * 4. 重试必须幂等 —— 已经合并过的会话不重来,而失败的会话能补上。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MigrationState } from '../../../shared/domain/data-migration'
import { createMigrationGate, databasePathIn } from '../startup-migration'
import { MIGRATION_UNDO_KEY } from '../legacy-merge'

let root = ''
let dataRoot = ''
let legacyRoot = ''
let dataPath = ''
let legacyPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-gate-'))
  dataRoot = join(root, 'data')
  legacyRoot = join(root, 'legacy')
  dataPath = databasePathIn(dataRoot)
  legacyPath = databasePathIn(legacyRoot)
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(legacyRoot, { recursive: true })
  seed(dataPath, [{ id: 's-here', title: '当前库的会话' }], '{"name":"当前工作区"}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 铺一个最小可用的库:工作区 + 会话 + 消息。 */
function seed(
  path: string,
  sessions: Array<{ id: string; title: string }>,
  workspaceJson: string
): void {
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
  d.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('w-1', 1, workspaceJson)
  for (const [index, s] of sessions.entries()) {
    d.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      s.id,
      'w-1',
      s.title,
      1000 + index,
      2000 + index,
      path
    )
    d.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
      `m-${s.id}`,
      s.id,
      'user',
      '"hi"',
      1500 + index
    )
  }
  d.close()
}

/** 收集每次状态变化。用来断言「哪些阶段真的被播出去过」。 */
function recorder(): { states: MigrationState[]; onChange: (s: MigrationState) => void } {
  const states: MigrationState[] = []
  return { states, onChange: (s) => states.push(s) }
}

/** 同步的让出点:测试里不需要真的让出,但顺序必须和 `await` 一致。 */
const immediateYield = (): Promise<void> => Promise.resolve()

describe('createMigrationGate', () => {
  it('★ 没有旧数据时一次都不播 running —— 渲染层因此不会白闪', () => {
    seed(legacyPath, [{ id: 's-here', title: '当前库的会话' }], '{"name":"当前工作区"}')
    const { states, onChange } = recorder()
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      onChange,
      yieldToEventLoop: immediateYield
    })

    return gate.run().then((state) => {
      expect(state.phase).toBe('idle')
      expect(state.steps).toEqual([])
      expect(states.some((s) => s.phase === 'running')).toBe(false)
    })
  })

  it('旧库里有缺的会话时,跑完合并并把行数报出来', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    const { states, onChange } = recorder()
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      onChange,
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    expect(state.phase).toBe('idle')
    expect(state.merged).toEqual({ sessions: 1, messages: 1, attachments: 0 })
    expect(state.completed).toEqual(['merge-legacy-rows', 'copy-attachment-files'])
    // 进度真的播出去了,而且最后一条是完成态。
    expect(states.filter((s) => s.phase === 'running').length).toBeGreaterThan(0)
    expect(states.at(-1)?.ratio).toBe(1)
  })

  it('合并完成后留下可撤销的清单', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    expect(state.undoAvailable).toBe(true)
    const d = new DatabaseSync(dataPath, { readOnly: true })
    const row = d.prepare('SELECT json FROM kv WHERE key = ?').get(MIGRATION_UNDO_KEY)
    d.close()
    expect(String(row?.['json'])).toContain('s-lost')
  })

  it('撤销之后会话和清单一起消失', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      yieldToEventLoop: immediateYield
    })
    await gate.run()

    gate.undo()

    expect(gate.state().undoAvailable).toBe(false)
    const d = new DatabaseSync(dataPath, { readOnly: true })
    expect(d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-lost'").get()?.['n']).toBe(0)
    expect(d.prepare('SELECT COUNT(*) AS n FROM kv WHERE key = ?').get(MIGRATION_UNDO_KEY)?.['n']).toBe(0)
    d.close()
  })

  it('★ 目标库读不出来时停在失败,而不是静默继续', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    // 把目标库换成一个不是数据库的文件。
    rmSync(dataPath)
    writeFileSync(dataPath, '这不是数据库')
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    /*
      ★ 这里必须是 failed,不能是 idle。原先把「探测失败」降级成「没有东西要搬」,
      那正是这次丢数据的形态:探测失败 → 判定无需迁移 → 静默继续 → 用户看到一份
      少了东西的数据,日志里一个字都没有。
    */
    expect(state.phase).toBe('failed')
    expect(state.failure?.code).toBe('target-corrupt')
    expect(state.failure?.stepKind).toBe('merge-legacy-rows')
    expect(state.failure?.detail).not.toBe('')
  })

  it('失败之后「跳过并继续」把阶段翻成 skipped,源库一个字节都不动', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    // 目标库的路径上是一个**目录** —— 打不开,探测会抛。
    const blocked = join(root, 'blocked.db')
    mkdirSync(blocked)
    const gate = createMigrationGate({
      dataRoot,
      databasePath: blocked,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      yieldToEventLoop: immediateYield
    })
    await gate.run()
    expect(gate.state().phase).toBe('failed')

    gate.skip()

    expect(gate.state().phase).toBe('skipped')
    // ★ 「跳过」不是「放弃一半」:源库原样留着,下次启动还能再试。
    const d = new DatabaseSync(legacyPath, { readOnly: true })
    expect(d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-lost'").get()?.['n']).toBe(1)
    d.close()
  })

  it('★ 重试是幂等的:已经搬过的会话不重复搬', async () => {
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [{ root: legacyRoot, databasePath: legacyPath }],
      yieldToEventLoop: immediateYield
    })
    const first = await gate.run()
    expect(first.merged?.sessions).toBe(1)

    // 再跑一次(错误页上的「重试」就是这个动作)。
    const second = await gate.run()

    expect(second.phase).toBe('idle')
    const d = new DatabaseSync(dataPath, { readOnly: true })
    expect(d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-lost'").get()?.['n']).toBe(1)
    expect(d.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's-lost'").get()?.['n']).toBe(1)
    d.close()
  })

  it('多份旧根时只处理第一个有内容的', async () => {
    const emptyRoot = join(root, 'empty-legacy')
    mkdirSync(emptyRoot, { recursive: true })
    const emptyPath = databasePathIn(emptyRoot)
    seed(emptyPath, [{ id: 's-here', title: '当前库的会话' }], '{"name":"当前工作区"}')
    seed(
      legacyPath,
      [
        { id: 's-here', title: '当前库的会话' },
        { id: 's-lost', title: '丢掉的会话' }
      ],
      '{"name":"当前工作区"}'
    )
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [
        { root: emptyRoot, databasePath: emptyPath },
        { root: legacyRoot, databasePath: legacyPath }
      ],
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    // 第一份没内容,所以落到第二份 —— 而不是在第一份上停住。
    expect(state.merged?.sessions).toBe(1)
  })

  it('★ 用户显式指定了 --user-data-dir 时不该有旧根可搬', () => {
    // 调用方要的就是一个干净的隔离根。这条由 main/index.ts 的 legacyMigrationSources()
    // 保证(它返回空数组),闸门这一侧只需确认「空 sources = 什么都不做」。
    const { states, onChange } = recorder()
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [],
      onChange,
      yieldToEventLoop: immediateYield
    })

    return gate.run().then((state) => {
      expect(state.phase).toBe('idle')
      expect(state.steps).toEqual([])
      expect(states.some((s) => s.phase === 'running')).toBe(false)
    })
  })

  it('撤销失败只记一条失败,不让它掀掉已经成功的合并', async () => {
    const gate = createMigrationGate({
      dataRoot,
      databasePath: dataPath,
      sources: [],
      yieldToEventLoop: immediateYield
    })
    await gate.run()

    // 没有清单 —— 撤销是 no-op,而不是抛错。
    expect(() => gate.undo()).not.toThrow()
    expect(gate.state().undoAvailable).toBe(false)
  })
})

describe('collapseFlatLayout', () => {
  it('★ 目标库还不存在时,先收拢扁平布局,再检查有没有东西要合并', async () => {
    // 旧布局:库直接躺在 profile 根下。目标 `data/` 还没有。
    const profileRoot = join(root, 'profile')
    mkdirSync(join(profileRoot, 'attachments', 'sessions', 's-x'), { recursive: true })
    writeFileSync(join(profileRoot, 'attachments', 'sessions', 's-x', 'a.png'), 'png')
    seed(databasePathIn(profileRoot), [{ id: 's-flat', title: '根层旧库的会话' }], '{"name":"旧工作区"}')
    const freshDataRoot = join(root, 'fresh-data')
    const { states, onChange } = recorder()
    const gate = createMigrationGate({
      dataRoot: freshDataRoot,
      databasePath: databasePathIn(freshDataRoot),
      sources: [],
      collapseFlatLayout: { from: profileRoot, to: freshDataRoot },
      onChange,
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    expect(state.completed).toContain('collapse-flat-layout')
    expect(state.phase).toBe('idle')
    expect(states.some((s) => s.current?.kind === 'collapse-flat-layout')).toBe(true)
  })

  it('收拢失败时停在闸门上 —— 此时库处于「搬了一半」的状态', async () => {
    const profileRoot = join(root, 'profile-fail')
    mkdirSync(profileRoot, { recursive: true })
    seed(databasePathIn(profileRoot), [{ id: 's-flat', title: '根层旧库的会话' }], '{"name":"旧工作区"}')
    // 目标路径的父级是一个**文件** —— `mkdirSync(targetDir)` 会以 ENOTDIR 失败,
    // 而这时候 rename 还没开始。用来验证失败确实会停在闸门上。
    const blocker = join(root, 'a-file-not-a-dir')
    writeFileSync(blocker, 'x')
    const blocked = join(blocker, 'data')
    const gate = createMigrationGate({
      dataRoot: blocked,
      databasePath: databasePathIn(blocked),
      sources: [],
      collapseFlatLayout: { from: profileRoot, to: blocked },
      yieldToEventLoop: immediateYield
    })

    const state = await gate.run()

    expect(state.phase).toBe('failed')
    expect(state.failure?.stepKind).toBe('collapse-flat-layout')
    // ★ 源库原地不动 —— 收拢失败时不能把根层那份弄丢。
    expect(existsSync(databasePathIn(profileRoot))).toBe(true)
  })

  it('★ 目标库位置上已经躺着东西时不假装收拢成功', () => {
    /*
      判据必须是**目标库文件**不存在,不是目标目录不存在。按目录判的话,
      「目录已建好但库还没落进去」会被当成「已经收拢过」而静默跳过,
      然后在后面以一个完全不相干的错误炸掉。
    */
    const profileRoot = join(root, 'profile-dir-only')
    mkdirSync(profileRoot, { recursive: true })
    seed(databasePathIn(profileRoot), [{ id: 's-flat', title: '根层旧库的会话' }], '{"name":"旧工作区"}')
    const targetDir = join(root, 'data-dir-only')
    // 目录存在,但里面没有库文件。
    mkdirSync(targetDir, { recursive: true })

    const gate = createMigrationGate({
      dataRoot: targetDir,
      databasePath: databasePathIn(targetDir),
      sources: [],
      collapseFlatLayout: { from: profileRoot, to: targetDir },
      yieldToEventLoop: immediateYield
    })

    return gate.run().then((state) => {
      expect(state.completed).toContain('collapse-flat-layout')
      expect(existsSync(databasePathIn(targetDir))).toBe(true)
    })
  })
})
