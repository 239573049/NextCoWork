/**
 * 改动集落盘的对账 —— 合并语义(首个 before / 最后一个 after)、超限降级、
 * 撤销态翻转,以及删会话时的级联清理。走 `repo`,用真文件库、每个用例独立目录。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from '../index'
import * as repo from '../repo'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-fc-'))
  openDatabase(dir)
  repo.ensureSession({ id: 'sess', workspaceId: 'ws', title: 'T' })
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const modify = (relPath: string, before: string, after: string) => ({
  relPath,
  absPath: `/ws/${relPath}`,
  before,
  after,
  changeKind: 'modified' as const,
  inWorkspace: true
})

describe('saveFileChangeSet', () => {
  it('聚合 +X −Y 与文件数,文件按路径排序', () => {
    repo.saveFileChangeSet({
      rootRunId: 'run',
      sourceRunId: 'run',
      sessionId: 'sess',
      workspaceId: 'ws',
      at: 1,
      changes: [
        modify('b.ts', 'x', 'x\ny'),
        { relPath: 'a.ts', absPath: '/ws/a.ts', before: null, after: 'new\nfile', changeKind: 'created', inWorkspace: true }
      ]
    })
    const set = repo.getFileChangeSet('run')
    expect(set?.fileCount).toBe(2)
    expect(set?.additions).toBe(3) // b.ts +1, a.ts +2
    expect(set?.deletions).toBe(0)
    expect(set?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(set?.files[0]).toMatchObject({ changeKind: 'created', additions: 2 })
  })

  it('叠加(父子两次落同一 run):保留最早 before、推进到最新 after', () => {
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'child', sessionId: 'sess', workspaceId: 'ws', at: 1, changes: [modify('a.ts', 'v0', 'v1')] })
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'run', sessionId: 'sess', workspaceId: 'ws', at: 2, changes: [modify('a.ts', 'v1', 'v2')] })
    const diff = repo.getFileSnapshotDiff('run', 'a.ts')
    expect(diff).toMatchObject({ before: 'v0', after: 'v2' })
    expect(repo.getFileChangeSet('run')?.fileCount).toBe(1)
  })

  it('单文件超 1 MiB:标 oversize、内容不入库、禁 diff', () => {
    const huge = 'a'.repeat(1024 * 1024 + 1)
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'run', sessionId: 'sess', workspaceId: 'ws', at: 1, changes: [modify('big.ts', 'small', huge)] })
    const set = repo.getFileChangeSet('run')
    expect(set?.files[0]?.oversize).toBe(true)
    const diff = repo.getFileSnapshotDiff('run', 'big.ts')
    expect(diff).toMatchObject({ oversize: true, before: '', after: '' })
    // 撤销要用的完整行仍在,但内容为 null(内容没入库)
    expect(repo.listFileSnapshots('run')[0]).toMatchObject({ oversize: true, before: null, after: null })
  })

  it('撤销态翻转 applied ⇄ reverted', () => {
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'run', sessionId: 'sess', workspaceId: 'ws', at: 1, changes: [modify('a.ts', 'x', 'y')] })
    expect(repo.getFileChangeSetState('run')).toBe('applied')
    repo.setChangeSetState('run', 'reverted', 2)
    expect(repo.getFileChangeSet('run')?.state).toBe('reverted')
  })

  it('删会话级联清空改动集', () => {
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'run', sessionId: 'sess', workspaceId: 'ws', at: 1, changes: [modify('a.ts', 'x', 'y')] })
    repo.deleteSession('sess')
    expect(repo.getFileChangeSet('run')).toBeUndefined()
    expect(repo.listFileSnapshots('run')).toHaveLength(0)
  })

  it('空改动不落盘', () => {
    repo.saveFileChangeSet({ rootRunId: 'run', sourceRunId: 'run', sessionId: 'sess', workspaceId: 'ws', at: 1, changes: [] })
    expect(repo.getFileChangeSet('run')).toBeUndefined()
  })
})
