/**
 * 退出时的**封库**语义。
 *
 * `closeDatabase()` 默认是重置(测试在 beforeEach 里关掉、下一次 `db()` 自动开内存库
 * 继续跑);`closeDatabase({ final: true })` 是应用退出,此后任何写入都必须失败。
 *
 * 分这一刀的原因是一条静默丢数据的路径:退出时仍在跑的 run 有一个异步收尾续延
 * (`runtime.ts` 里 `running.finally`),它在 `closeDatabase()` 之后才落地。而 `db()`
 * 原先在 handle 为 null 时会**凭空开一个内存库**并跑完整套迁移,于是那条转录被写进
 * 一个当场就要被丢掉的库里,不抛错、不打日志,用户只看到最后一轮对话没了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDatabase, DatabaseClosedError, openDatabase } from '../index'
import { store } from '../../state/store'

let directory = ''

beforeEach(() => {
  closeDatabase()
  directory = mkdtempSync(join(tmpdir(), 'ncw-seal-'))
  openDatabase(directory)
})

afterEach(() => {
  closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

it('refuses late writes after the application has sealed the database', () => {
  store.setHistory('session-1', [])
  closeDatabase({ final: true })
  expect(() => store.setHistory('session-1', [])).toThrow(DatabaseClosedError)
})

/** 重置语义必须原样保留,否则每一个在 beforeEach 里关库的测试都会炸。 */
it('still falls back to an in-memory database after a plain reset', () => {
  closeDatabase()
  expect(() => store.setHistory('session-1', [])).not.toThrow()
})

/** 重新开库要解封 —— 否则一次退出流程被中断就再也写不进去了。 */
it('unseals when the database is opened again', () => {
  closeDatabase({ final: true })
  const reopened = mkdtempSync(join(tmpdir(), 'ncw-seal-again-'))
  try {
    openDatabase(reopened)
    expect(() => store.setHistory('session-1', [])).not.toThrow()
  } finally {
    closeDatabase()
    rmSync(reopened, { recursive: true, force: true })
  }
})
