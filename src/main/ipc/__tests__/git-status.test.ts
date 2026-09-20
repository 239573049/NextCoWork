/**
 * `parseStatus` 的断言 —— 盯的是「暂存区 / 未暂存」这一次分组。
 *
 * 需求:面板上那两个分组完全由 `staged` / `unstaged` 决定,而这两个布尔值曾经因为
 * 把 porcelain v2 的 `.` 当成「有改动」而双双为真 —— 109 个改动显示成两份 109,
 * 且「暂存」按钮点下去毫无反应。这里的第一条用例就是那次回归的复现。
 */
import { describe, expect, it } from 'vitest'
import { parseStatus } from '../git-status'

/** 造一条 porcelain v2 的普通改动记录(`1` 开头)。 */
function ordinary(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 aaaaaaa bbbbbbb ${path}`
}

function zeroed(records: string[]): string {
  return records.map((record) => `${record}\0`).join('')
}

describe('parseStatus', () => {
  it('treats porcelain v2 "." as no change, so a staged-only file is not listed as unstaged', () => {
    const snapshot = parseStatus(zeroed([ordinary('M.', 'src/a.ts'), ordinary('A.', 'src/b.ts')]))
    expect(snapshot.files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['src/a.ts', true, false],
      ['src/b.ts', true, false]
    ])
  })

  it('keeps a file in both groups when it was staged and then edited again', () => {
    const [file] = parseStatus(zeroed([ordinary('MM', 'src/a.ts')])).files
    expect(file?.staged).toBe(true)
    expect(file?.unstaged).toBe(true)
  })

  it('reports a worktree-only edit as unstaged', () => {
    const [file] = parseStatus(zeroed([ordinary('.M', 'src/a.ts')])).files
    expect(file?.staged).toBe(false)
    expect(file?.unstaged).toBe(true)
  })

  it('reads branch, upstream and ahead/behind from the header records', () => {
    const snapshot = parseStatus(
      zeroed([
        '# branch.oid 5d77615',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -3',
        ordinary('M.', 'a.ts')
      ])
    )
    expect(snapshot.branch).toBe('main')
    expect(snapshot.upstream).toBe('origin/main')
    expect(snapshot.ahead).toBe(2)
    expect(snapshot.behind).toBe(3)
    expect(snapshot.unborn).toBe(false)
    expect(snapshot.detached).toBe(false)
  })

  it('takes the rename source from the next record, not from the same one', () => {
    const snapshot = parseStatus(
      zeroed([
        '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.ts',
        'src/old.ts',
        ordinary('M.', 'src/after.ts')
      ])
    )
    expect(snapshot.files.map((f) => f.path)).toEqual(['src/new.ts', 'src/after.ts'])
    expect(snapshot.files[0]?.renamedFrom).toBe('src/old.ts')
  })

  it('marks untracked entries and both AA and DD as conflicted-or-untracked', () => {
    const snapshot = parseStatus(
      zeroed([
        '? src/fresh.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
        ordinary('AA', 'src/both-added.ts')
      ])
    )
    const [fresh, conflict, bothAdded] = snapshot.files
    expect([fresh?.untracked, fresh?.staged, fresh?.unstaged]).toEqual([true, false, false])
    expect(conflict?.conflicted).toBe(true)
    expect(bothAdded?.conflicted).toBe(true)
    // 冲突的文件不进任何一个分组 —— 面板不给它暂存按钮
    expect([bothAdded?.staged, bothAdded?.unstaged]).toEqual([false, false])
  })

  it('handles paths that contain spaces', () => {
    const [file] = parseStatus(zeroed([ordinary('M.', 'src/my notes/a b.ts')])).files
    expect(file?.path).toBe('src/my notes/a b.ts')
  })

  it('flags an unborn repository from branch.oid', () => {
    const snapshot = parseStatus(zeroed(['# branch.oid (initial)', '# branch.head main']))
    expect(snapshot.unborn).toBe(true)
  })
})
