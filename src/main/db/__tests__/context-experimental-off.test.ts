/**
 * 第 11 条迁移:智能上下文管理默认关闭,存量库一并翻过来。
 *
 * 这条迁移有两个方向,少测哪个都会通过一个错误的实现:
 * - 只断言「升级完是 false」的话,一条每次启动都跑的 `UPDATE` 也是绿的 ——
 *   而那样用户在设置里重新打开,下次启动又被关上;
 * - 只断言「关掉了」的话,把值写成数字 `0` 同样是绿的 —— 读路径上它照样是假值,
 *   本地一点异样都看不出来,但这台机器导出的备份会整份过不了 `isDataExport`。
 *   所以断言用 `toBe(false)` 而不是 `toBeFalsy()`,并连着旁边的字段一起看。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILENAME, closeDatabase, openDatabase } from '../index'
import * as repo from '../repo'
import { MIGRATIONS } from '../schema'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-ctxdefault-db-'))
  openDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个停在第 10 版的真实库,并把 `settings` 那一行写成给定的 JSON。
 * 返回目录 —— 交给 `openDatabase` 就会跑第 11 条。
 */
function seedV10(settingsJson: string): string {
  const legacyDir = mkdtempSync(join(tmpdir(), 'nextcowork-v10-'))
  const raw = new DatabaseSync(join(legacyDir, DB_FILENAME))
  raw.exec(
    'CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  )
  const insert = raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of MIGRATIONS.slice(0, 10)) {
    raw.exec(migration.sql)
    insert.run(migration.version, migration.name, Date.now())
  }
  raw.prepare('INSERT INTO settings (id, json) VALUES (1, ?)').run(settingsJson)
  raw.close()
  return legacyDir
}

/** 在 `legacyDir` 上开库跑迁移,跑完把临时目录收干净并还原到本用例的 dir。 */
function upgraded(legacyDir: string, assert: () => void): void {
  closeDatabase()
  openDatabase(legacyDir)
  try {
    assert()
  } finally {
    closeDatabase()
    rmSync(legacyDir, { recursive: true, force: true })
    openDatabase(dir)
  }
}

describe('第 11 条迁移', () => {
  it('存量的 experimentalMode: true 被翻成 false,同块的 autoCompact 与其余设置原样留着', () => {
    const legacyDir = seedV10(
      JSON.stringify({
        theme: 'dark',
        defaultModel: 'some-alias',
        contextManagement: { experimentalMode: true, autoCompact: true }
      })
    )

    upgraded(legacyDir, () => {
      const settings = repo.getSettings()
      // ★ 必须是布尔 false,不是 0。数字在读路径上照样是假值,行为看不出差别 ——
      //   `toBe(false)` 是这里唯一拦得住它的东西。放过去的话,这台机器导出的备份
      //   会整份过不了 `isDataExport` 的校验(见 schema.ts 第 11 条的注释)。
      expect(settings.contextManagement.experimentalMode).toBe(false)
      expect(settings.contextManagement.autoCompact).toBe(true)
      expect(settings.theme).toBe('dark')
      expect(settings.defaultModel).toBe('some-alias')
    })
  })

  it('迁移只跑一次:升级后用户重新打开,再开库不会被关回去', () => {
    const legacyDir = seedV10(
      JSON.stringify({ contextManagement: { experimentalMode: true, autoCompact: true } })
    )

    closeDatabase()
    openDatabase(legacyDir)
    try {
      expect(repo.getSettings().contextManagement.experimentalMode).toBe(false)
      // 用户自己在设置里又打开了
      repo.updateSettings({ contextManagement: { experimentalMode: true } })

      // 关掉再开 —— 迁移表里已经记着第 11 版,这条 UPDATE 不该再执行
      closeDatabase()
      openDatabase(legacyDir)
      expect(repo.getSettings().contextManagement.experimentalMode).toBe(true)
    } finally {
      closeDatabase()
      rmSync(legacyDir, { recursive: true, force: true })
      openDatabase(dir)
    }
  })

  it('本来就是 false、以及根本没有这一块的旧行,都不会被写坏', () => {
    const off = seedV10(
      JSON.stringify({ theme: 'light', contextManagement: { experimentalMode: false, autoCompact: false } })
    )
    upgraded(off, () => {
      const settings = repo.getSettings()
      expect(settings.contextManagement).toEqual({ experimentalMode: false, autoCompact: false })
      expect(settings.theme).toBe('light')
    })

    // 比 contextManagement 更早的库里压根没有这个块。json_set 造不出中间对象,
    // 这一行原样不动,新默认值由 mergeSettings 铺上去。
    const absent = seedV10(JSON.stringify({ theme: 'light' }))
    upgraded(absent, () => {
      expect(repo.getSettings().contextManagement).toEqual({
        experimentalMode: false,
        autoCompact: true
      })
    })
  })
})
