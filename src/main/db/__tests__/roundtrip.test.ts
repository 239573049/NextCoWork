/**
 * **「退出应用重开,配置还在」** —— 步骤 1 的验收条件,后面整个模型管理都建在它上面。
 *
 * 所以这里测的不是「SQL 语句写对了没有」,而是**跨进程边界的那一下**:
 * 每个用例都真的关库、真的重开,再读回来。用真文件不用 `:memory:` ——
 * 内存库上「关了再开」是句空话,而这正是要测的东西。
 *
 * 走 `store` 而不是 `repo`:全应用用的是前者,而这次改动的全部承诺就是
 * 「访问器签名不变、实现换成 SQL」。密钥那条是例外,`store` 上本来就没有
 * 密钥访问器(加解密属于 `main/host/index.ts`),所以直接对 `repo` 测字节保真。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/domain/settings'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import type { Workspace } from '../../../shared/domain/workspace'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../shared/domain/workspace'
import { store } from '../../state/store'
import { DB_FILENAME, closeDatabase, openDatabase } from '../index'
import * as repo from '../repo'

let dir = ''

/** 关掉再开 = 模拟一次退出重启。库文件留在原地,只有句柄换了。 */
const restart = (): void => {
  closeDatabase()
  openDatabase(dir)
}

beforeEach(() => {
  // 先关:前一个用例可能留着句柄,而 openDatabase 对重复打开是抛错的
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-db-'))
  openDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const provider = (id: string, priority: number): UpstreamProvider => ({
  id,
  name: id,
  protocol: 'anthropic',
  baseUrl: `https://${id}.invalid`,
  credentialRef: `${id}:key`,
  priority,
  enabled: true
})

const alias = (providerId: string, name: string): ModelAlias => ({
  alias: name,
  providerId,
  upstreamModel: `${providerId}-上游名`,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  contextWindow: 100_000,
  maxOutputTokens: 4096
})

const workspace = (id: string): Workspace => ({
  id,
  name: `工作区 ${id}`,
  rootPath: `/tmp/${id}`,
  settings: { ...DEFAULT_WORKSPACE_SETTINGS, defaultModel: 'm' },
  createdAt: 1_700_000_000_000,
  lastOpenedAt: 1_700_000_001_000
})

describe('★ 关库重开之后,配置一样都不少', () => {
  it('供应商 / 别名 / 工作区 / 设置 / kv 全部读得回来', () => {
    store.putProvider(provider('主', 0))
    store.putProvider(provider('备', 1))
    store.putAlias(alias('主', 'claude-sonnet-4'))
    store.putAlias(alias('备', 'claude-sonnet-4'))
    store.putWorkspace(workspace('ws-1'))
    store.updateSettings({
      defaultModel: 'claude-sonnet-4',
      gateway: { preferredPort: 20000 }
    })
    store.setKv('tabs.outer.main', {
      outer: [{ id: 't1' }],
      activeOuterId: 't1'
    })

    restart()

    expect(store.listProviders().map((p) => p.id)).toEqual(['主', '备'])
    expect(store.listAliases()).toHaveLength(2)
    expect(store.getWorkspace('ws-1')?.name).toBe('工作区 ws-1')
    expect(store.getSettings().defaultModel).toBe('claude-sonnet-4')
    expect(store.getSettings().gateway.preferredPort).toBe(20000)
    expect(store.getKv('tabs.outer.main', null)).toEqual({
      outer: [{ id: 't1' }],
      activeOuterId: 't1'
    })
  })

  it('别名带着能力位和数字字段一起回来,不是只剩个名字', () => {
    store.putProvider(provider('主', 0))
    store.putAlias(alias('主', 'm'))

    restart()

    const [a] = store.listAliases()
    expect(a).toEqual(alias('主', 'm'))
  })

  /**
   * ★ `PRAGMA foreign_keys` 是**连接级**的,不是存在文件里的属性。
   * 重开时忘了开,级联就静默失效 —— 而症状(下拉框里一个选不动的模型)
   * 离这里非常远。所以级联要在**重开之后**再验一次。
   */
  it('删 provider 的级联在重开之后仍然生效', () => {
    store.putProvider(provider('主', 0))
    store.putProvider(provider('备', 1))
    store.putAlias(alias('主', 'm1'))
    store.putAlias(alias('主', 'm2'))
    store.putAlias(alias('备', 'm1'))

    restart()
    store.removeProvider('主')

    expect(store.listAliases().map((a) => a.providerId)).toEqual(['备'])
  })

  it('删工作区连带删掉它的内层 Tab 记录,且两者一起落盘', () => {
    store.putWorkspace(workspace('ws-1'))
    store.setKv('tabs.inner.ws-1', { tabs: [{ id: 'x' }], activeTabId: 'x' })

    store.removeWorkspace('ws-1')
    restart()

    expect(store.getWorkspace('ws-1')).toBeUndefined()
    expect(store.getKv('tabs.inner.ws-1', 'FALLBACK')).toBe('FALLBACK')
  })
})

describe('密钥:数据库这一层只认字节', () => {
  /**
   * 存进去的是 `safeStorage.encryptString` 的产物 —— 密文里必然有非 UTF-8 的字节。
   * 哪天有人图省事把 BLOB 改成 TEXT,这一条会当场红:那种改动的症状是
   * 「密钥存进去了,读出来解不开」,而且只在某些 key 上出现。
   */
  it('非 UTF-8 的密文原样进、原样出,跨重启不变', () => {
    const cipher = new Uint8Array([0xff, 0x00, 0xfe, 0x01, 0x80, 0x7f])
    repo.putCredential('主:key', cipher)

    restart()

    expect(repo.getCredential('主:key')).toEqual(cipher)
    expect(repo.getCredential('不存在的')).toBeUndefined()
  })

  it('同一个 ref 重复写是更新;删掉之后读回 undefined', () => {
    repo.putCredential('r', new Uint8Array([1]))
    repo.putCredential('r', new Uint8Array([2, 3]))
    restart()
    expect(repo.getCredential('r')).toEqual(new Uint8Array([2, 3]))

    repo.removeCredential('r')
    restart()
    expect(repo.getCredential('r')).toBeUndefined()
  })
})

describe('迁移', () => {
  it('重开不会重跑迁移,也不会清空已有的行', () => {
    store.putProvider(provider('主', 0))
    restart()
    restart()

    const raw = new DatabaseSync(join(dir, DB_FILENAME))
    const rows = raw.prepare('SELECT version FROM migrations').all()
    const version = raw.prepare('PRAGMA user_version').get()
    raw.close()

    expect(rows).toHaveLength(1)
    expect(Number(version?.['user_version'])).toBe(1)
    expect(store.listProviders()).toHaveLength(1)
  })

  /**
   * ★ 旧版本存下的行会缺新字段。读回 `undefined` 的话,它会顺着 IPC 一路流到
   * 界面上变成一个空下拉框 —— 而不是一个报错。
   *
   * 这不是假想:方案 §7 下一步就要把 `gateway.failover` 改名成 `routing.failover`,
   * 那之后**所有已经存在的行**都缺 `routing`。
   */
  it('旧行缺字段时补的是默认值,不是 undefined', () => {
    closeDatabase()
    const raw = new DatabaseSync(join(dir, DB_FILENAME))
    raw
      .prepare(
        'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json'
      )
      // 一个「上个版本」的行:只有两个字段,嵌套块也只给了一半
      .run(JSON.stringify({ theme: 'dark', gateway: { enabled: true } }))
    raw.close()
    openDatabase(dir)

    const s = store.getSettings()
    expect(s.theme).toBe('dark')
    expect(s.gateway.enabled).toBe(true)
    // 同一个嵌套块里没给的属性拿默认值,而不是整块被替换掉
    expect(s.gateway.preferredPort).toBe(DEFAULT_SETTINGS.gateway.preferredPort)
    // 整块缺席的也一样
    expect(s.subagent).toEqual(DEFAULT_SETTINGS.subagent)
    expect(s.locale).toBe(DEFAULT_SETTINGS.locale)
  })
})

describe('首次启动:库文件所在的目录还不存在', () => {
  /**
   * ★ `DatabaseSync` **不会**替你建目录,它只抛 `unable to open database file` ——
   * 一条完全不提目录的错。而这条路径是全新安装必走的:`app.getPath('userData')`
   * 在第一次启动时可能还没落地,dev 那个 `…-dev` 后缀的更是没人建过。
   *
   * 少了 `mkdirSync` 的表现是**应用起不来**,不是某个功能不好使,
   * 所以这一条守的是整个步骤 1 的最坏情况。
   */
  it('自己把多层父目录建出来,并且照常读写', () => {
    closeDatabase()
    const fresh = join(dir, '还没建过', 'userData-dev')
    expect(() => openDatabase(fresh)).not.toThrow()

    store.putProvider(provider('主', 0))
    closeDatabase()
    openDatabase(fresh)
    expect(store.listProviders().map((p) => p.id)).toEqual(['主'])

    // 库确实落在那个新建的目录里,不是退回上一层或内存
    expect(statSync(join(fresh, DB_FILENAME)).size).toBeGreaterThan(0)
  })
})

describe('openDatabase 的调用顺序是被钉死的', () => {
  /**
   * ★ 守的是这样一次改动:有人把 `openDatabase()` 挪到 `initRuntime()` 后面。
   * 那时 seed 会写进一个内存兜底库,换成文件库时那些行凭空消失 ——
   * 症状「配置重启后没了」和**完全没做持久化**一模一样,查起来会绕很远。
   */
  it('重复打开直接抛,而不是静默换一个库', () => {
    expect(() => openDatabase(dir)).toThrow(/已经打开/)
  })

  it('先碰过 store(走内存兜底)再 openDatabase,抛的错要点明是顺序问题', () => {
    closeDatabase()
    store.listProviders() // 没人指定位置 —— 开一个内存库兜底
    expect(() => openDatabase(dir)).toThrow(/内存兜底/)
  })
})
