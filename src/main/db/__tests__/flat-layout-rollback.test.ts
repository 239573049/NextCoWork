/**
 * 扁平布局迁移搬到一半失败时的回滚。
 *
 * 真实症状只在 Windows 上出现:Chromium 或杀毒软件握着某个目录的句柄,
 * rename 抛 `EPERM`。那时候库已经搬进 `data/` 了,而 `skills/` 还在根层 ——
 * 下一次启动看到一个「没有库的 data/」,于是一切从零开始,用户的会话
 * 还散落在根层没人认领。所以中途失败必须整体退回原位。
 *
 * mock 掉 `renameSync` 是唯一能在 macOS/Linux 上复现它的办法:POSIX 的 rename
 * 根本不看打开句柄,拿真文件怎么锁都锁不出这个错。
 *
 * ★ 单独一个文件,不并进 flat-layout.test.ts —— `vi.mock('node:fs')` 是模块级的,
 *   混进那套用例里会让每一条都跑在被改写过的 fs 上。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 这一轮要假装「搬不动」的源路径后缀。 */
const locked = vi.hoisted(() => ({ suffixes: [] as string[] }))

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    renameSync: (
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ): void => {
      if (locked.suffixes.some((suffix) => String(from).endsWith(suffix))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), {
          code: 'EPERM',
          syscall: 'rename'
        })
      }
      actual.renameSync(from, to)
    }
  }
})

import { DATA_SUBDIRNAME, DB_FILENAME, closeDatabase, openDatabase } from '../index'
import { migrateFlatLayout } from '../flat-layout'

let root = ''
let dataRoot = ''

beforeEach(() => {
  closeDatabase()
  root = mkdtempSync(join(tmpdir(), 'nextcowork-flat-rollback-'))
  dataRoot = join(root, DATA_SUBDIRNAME)
  locked.suffixes = []
  // 真库 —— 它是清单里第一个被搬的,回滚时也是最后一个退回来的。
  openDatabase(root)
  closeDatabase()
  mkdirSync(join(root, 'attachments', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'attachments', 'sessions', 'a.png'), 'png')
  mkdirSync(join(root, 'skills'), { recursive: true })
  writeFileSync(join(root, 'skills', 'SKILL.md'), '自己写的技能')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

describe('搬不动时整体回滚', () => {
  it('★ 已经搬走的全部退回原位,不留半截布局', () => {
    locked.suffixes = ['skills']

    expect(() => migrateFlatLayout(root, dataRoot)).toThrow(/EPERM/)

    // 库和附件在 skills 之前就搬走了,必须都回来
    expect(existsSync(join(root, DB_FILENAME))).toBe(true)
    expect(existsSync(join(root, 'attachments', 'sessions', 'a.png'))).toBe(true)
    expect(existsSync(join(root, 'skills', 'SKILL.md'))).toBe(true)
    // 新根上一个都不能剩 —— 剩下库就等于「下次启动认 data/ 里那份空的」
    expect(existsSync(join(dataRoot, DB_FILENAME))).toBe(false)
    expect(existsSync(join(dataRoot, 'attachments'))).toBe(false)
  })

  it('第一项就搬不动时同样退回,不会把 data/ 留成半成品', () => {
    locked.suffixes = [DB_FILENAME]

    expect(() => migrateFlatLayout(root, dataRoot)).toThrow(/EPERM/)

    expect(existsSync(join(root, DB_FILENAME))).toBe(true)
    expect(existsSync(join(root, 'skills', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dataRoot, 'skills'))).toBe(false)
  })
})
