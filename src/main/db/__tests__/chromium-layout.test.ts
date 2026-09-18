/**
 * Chromium 会话集 → `chromium/` 子目录的一次性迁移。
 *
 * 这段代码搬的是用户已有的登录态(Cookies / Local Storage / 分区),跑在启动路径上、
 * app ready 之前。三条边界值得钉死:
 *
 * 1. 会话集搬进 `chromium/`,而 `Local State` / `Preferences` / `Crashpad` **必须留在
 *    根层** —— 尤其 `Local State` 存着 cookie 加密密钥,跟着搬走会连累 Cookies 解不了密。
 * 2. 全新 profile(根层没有任何会话条目)一个字节都不搬,也不凭空造出 `chromium/`。
 * 3. `chromium/` 已存在即视为已迁移,幂等掠过。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHROMIUM_SUBDIRNAME, migrateChromiumIntoSubdir } from '../chromium-layout'

let root = ''
let chromiumDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-chromium-'))
  chromiumDir = join(root, CHROMIUM_SUBDIRNAME)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 在 profile 根上铺一套老的扁平会话布局(会话集 + 留在根层的那几样)。 */
function seedFlatProfile(): void {
  writeFileSync(join(root, 'Cookies'), 'chromium')
  mkdirSync(join(root, 'Local Storage', 'leveldb'), { recursive: true })
  writeFileSync(join(root, 'Local Storage', 'leveldb', '000003.log'), 'ls')
  mkdirSync(join(root, 'Network'))
  writeFileSync(join(root, 'Network', 'Cookies'), 'net')
  mkdirSync(join(root, 'Partitions', 'plugin-host'), { recursive: true })
  writeFileSync(join(root, 'DIPS-wal 3'), 'wal') // 带碰撞后缀,靠模式扫出来
  // 留在根层、永不搬的那几样
  writeFileSync(join(root, 'Local State'), '{"os_crypt":{"encrypted_key":"…"}}')
  writeFileSync(join(root, 'Preferences'), '{}')
  mkdirSync(join(root, 'Crashpad'))
}

describe('Chromium 会话集搬进 chromium/', () => {
  it('会话集进 chromium/,Local State / Preferences / Crashpad 留在根层', () => {
    seedFlatProfile()

    expect(migrateChromiumIntoSubdir(root)).toBeGreaterThan(0)

    // 会话集搬到位了
    expect(readFileSync(join(chromiumDir, 'Cookies'), 'utf8')).toBe('chromium')
    expect(readFileSync(join(chromiumDir, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('ls')
    expect(existsSync(join(chromiumDir, 'Network', 'Cookies'))).toBe(true)
    expect(existsSync(join(chromiumDir, 'Partitions', 'plugin-host'))).toBe(true)
    expect(existsSync(join(chromiumDir, 'DIPS-wal 3'))).toBe(true)

    // ★ 是 rename —— 旧位置必须空了
    expect(existsSync(join(root, 'Cookies'))).toBe(false)
    expect(existsSync(join(root, 'Local Storage'))).toBe(false)
    expect(existsSync(join(root, 'DIPS-wal 3'))).toBe(false)

    // ★ 关键:加密密钥所在的 Local State 及浏览器级偏好绝不能跟着搬走
    expect(readFileSync(join(root, 'Local State'), 'utf8')).toContain('encrypted_key')
    expect(existsSync(join(chromiumDir, 'Local State'))).toBe(false)
    expect(existsSync(join(root, 'Preferences'))).toBe(true)
    expect(existsSync(join(chromiumDir, 'Preferences'))).toBe(false)
    expect(existsSync(join(root, 'Crashpad'))).toBe(true)
    expect(existsSync(join(chromiumDir, 'Crashpad'))).toBe(false)
  })

  it('根层没有任何会话条目时不搬,也不造出空的 chromium/', () => {
    // 全新 profile:只有应用数据根,没有 Chromium 会话条目
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'Local State'), '{}') // 单有它不算「待迁移的旧布局」

    expect(migrateChromiumIntoSubdir(root)).toBe(0)
    expect(existsSync(chromiumDir)).toBe(false)
  })

  it('chromium/ 已存在即视为已迁移,幂等掠过、不动根层残留', () => {
    seedFlatProfile()
    mkdirSync(chromiumDir)

    expect(migrateChromiumIntoSubdir(root)).toBe(0)
    // 闸门已合:根层的 Cookies 原样留着,没有被二次搬动
    expect(existsSync(join(root, 'Cookies'))).toBe(true)
    expect(existsSync(join(chromiumDir, 'Cookies'))).toBe(false)
  })
})
