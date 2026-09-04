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
import type { McpServerConfig } from '../../../shared/domain/mcp'
import { mcpSecretRef } from '../../../shared/domain/mcp'
import { SEARCH_PROVIDER_IDS, searchSecretRef } from '../../../shared/domain/search'
import { DEFAULT_SETTINGS } from '../../../shared/domain/settings'
import { MIGRATIONS } from '../schema'
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import { anthropicCacheTtlOf } from '../../../shared/domain/provider'
import type { Workspace } from '../../../shared/domain/workspace'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../../shared/domain/workspace'
import { store } from '../../state/store'
import { DATABASE_DIRNAME, DB_FILENAME, closeDatabase, defaultDatabaseDirectory, openDatabase } from '../index'
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

  it('Provider 的协议专属缓存档位跨重启并经导出导入保留', () => {
    const configured = [
      ['关闭', 'off'],
      ['五分钟', '5m'],
      ['一小时', '1h']
    ] as const

    for (const [id, cacheTtl] of configured) {
      store.putProvider({
        ...provider(id, configured.findIndex(([name]) => name === id)),
        protocolOptions: { anthropic: { cacheTtl } }
      })
    }

    restart()

    const readTtls = Object.fromEntries(
      store.listProviders().map((p) => [p.id, anthropicCacheTtlOf(p)])
    )
    expect(readTtls).toEqual({ 关闭: 'off', 五分钟: '5m', 一小时: '1h' })

    // Provider JSON is part of the regular data snapshot; no special export
    // channel is needed for protocol-specific options.
    const exported = repo.exportDataSnapshot()
    expect(exported.providers.map((p) => [p.id, anthropicCacheTtlOf(p)])).toEqual([
      ['关闭', 'off'],
      ['五分钟', '5m'],
      ['一小时', '1h']
    ])

    for (const [id] of configured) store.removeProvider(id)
    expect(store.listProviders()).toEqual([])
    repo.mergeDataExport(exported)
    restart()

    expect(
      Object.fromEntries(store.listProviders().map((p) => [p.id, anthropicCacheTtlOf(p)]))
    ).toEqual({ 关闭: 'off', 五分钟: '5m', 一小时: '1h' })
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

/**
 * V2 的两张表。这里测的仍然是「关了再开还在」,外加两件**只有跨进程才看得出来**的事:
 * 删配置要连密钥一起删,以及搜索服务读回来是「目录八家」而不是「库里那几行」。
 */
describe('MCP 服务器', () => {
  const stdio = (id: string): McpServerConfig => ({
    id,
    name: id,
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    envNames: ['TOKEN']
  })

  it('三种传输方式都能原样读回来', () => {
    store.putMcpServer(stdio('local'))
    store.putMcpServer({
      id: 'remote',
      name: '远端',
      enabled: false,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/v1',
      headerNames: ['Authorization']
    })
    restart()

    const all = store.listMcpServers()
    expect(all.map((c) => c.id)).toEqual(['local', 'remote'])
    const local = all[0]
    expect(local?.transport).toBe('stdio')
    // 可辨识联合读回来之后仍然是那个分支 —— JSON 列保住了变体特有的字段
    expect(local !== undefined && local.transport === 'stdio' ? local.args : null).toEqual([
      '-y',
      '@modelcontextprotocol/server-everything'
    ])
  })

  /**
   * ★ 这一条是 `removeMcpServer` 存在的理由。只删配置的话,`credentials` 里
   * 那行密文会变成孤儿(键名存在刚被删掉的配置里),而且下次建一个同 id 的
   * 服务器会**默默继承**上一个的 token —— 症状是「我没填 Authorization,它却连上了」。
   */
  it('删服务器时密钥一起删,同 id 重建不会继承旧密钥', () => {
    store.putMcpServer(stdio('s1'))
    repo.putCredential(mcpSecretRef('s1', 'env'), new Uint8Array([9, 9]))
    restart()
    expect(repo.getCredential(mcpSecretRef('s1', 'env'))).toEqual(new Uint8Array([9, 9]))

    store.removeMcpServer('s1')
    restart()
    expect(store.listMcpServers()).toEqual([])
    expect(repo.getCredential(mcpSecretRef('s1', 'env'))).toBeUndefined()
  })
})

describe('搜索服务', () => {
  /**
   * ★ 一家都没配过时库是空的,但界面要列出八家。这个左连接收在 repo 里做一次,
   * 而不是让设置页、`web_search`、连通性测试各做一遍 —— 三份实现必然分叉。
   */
  it('库为空时也返回目录里的八家', () => {
    const all = store.listSearchProviders()
    expect(all).toHaveLength(SEARCH_PROVIDER_IDS.length)
    expect(all.every((c) => !c.enabled)).toBe(true)
  })

  it('存过的按 priority 排在前,没存过的接在后面', () => {
    store.putSearchProviders([
      { id: 'brave', enabled: true, priority: 0 },
      { id: 'tavily', enabled: true, priority: 1 }
    ])
    restart()

    const all = store.listSearchProviders()
    expect(all.slice(0, 2).map((c) => c.id)).toEqual(['brave', 'tavily'])
    // 八家一个不少 —— 覆盖两家不等于把另外六家弄丢了
    expect(all).toHaveLength(SEARCH_PROVIDER_IDS.length)
  })

  it('清 Key 只清这一家,不动别家', () => {
    repo.putCredential(searchSecretRef('tavily'), new Uint8Array([1]))
    repo.putCredential(searchSecretRef('exa'), new Uint8Array([2]))
    store.clearSearchCredential('tavily')
    restart()

    expect(repo.getCredential(searchSecretRef('tavily'))).toBeUndefined()
    expect(repo.getCredential(searchSecretRef('exa'))).toEqual(new Uint8Array([2]))
  })
})

describe('迁移', () => {
  it('默认数据库目录是项目下的 .next-cowork', () => {
    expect(defaultDatabaseDirectory()).toBe(join(process.cwd(), DATABASE_DIRNAME))
  })

  it('重开不会重跑迁移,也不会清空已有的行', () => {
    store.putProvider(provider('主', 0))
    restart()
    restart()

    const raw = new DatabaseSync(join(dir, DB_FILENAME))
    const rows = raw.prepare('SELECT version FROM migrations').all()
    const version = raw.prepare('PRAGMA user_version').get()
    raw.close()

    /*
      ★ 对着 `MIGRATIONS` 断言,不写死数字。写死的话每加一条迁移都会挂在这里,
      而失败信息(`expected 2 to be 1`)完全说不出「你只是加了条迁移」——
      下一个人会先去怀疑迁移跑重了。这一条要测的是**重开不重跑**,
      也就是「行数 == 迁移条数」,而不是「行数 == 1」。
    */
    expect(rows).toHaveLength(MIGRATIONS.length)
    expect(Number(version?.['user_version'])).toBe(
      MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
    )
    expect(store.listProviders()).toHaveLength(1)
  })

  it('从旧版第 6 版升级时补 owner_id,并修复去重索引', () => {
    // 模拟已经执行过旧版 1~6 的真实用户库:第 5 版只有 scope/status,
    // 第 6 版只有 display_name,两者都没有 owner_id。
    const legacyDir = mkdtempSync(join(tmpdir(), 'nextcowork-legacy-'))
    const legacyPath = join(legacyDir, DB_FILENAME)
    const raw = new DatabaseSync(legacyPath)
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    const insert = raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const migration of MIGRATIONS.slice(0, 6)) {
      // 第 5 版曾有一个发布变体漏掉 owner_id,但仍写入了同一个迁移号。
      // 用那条真实历史形态构造数据库,验证第 7 版能补列。
      const sql = migration.version === 5
        ? migration.sql
            .replace('ALTER TABLE attachments ADD COLUMN owner_id TEXT;\n', '')
            .replace('UPDATE attachments SET owner_id = session_id WHERE owner_id IS NULL;\n', '')
            .replace('CREATE INDEX attachments_by_checksum ON attachments (checksum, scope, owner_id);', 'CREATE INDEX attachments_by_checksum ON attachments (checksum, scope);')
        : migration.sql
      raw.exec(sql)
      insert.run(migration.version, migration.name, Date.now())
    }
    raw.close()

    // 让应用按当前迁移表打开这个旧库,只应执行新增的第 7 条。
    closeDatabase()
    openDatabase(legacyDir)
    const upgraded = new DatabaseSync(legacyPath, { readOnly: true })
    const columns = upgraded.prepare('PRAGMA table_info(attachments)').all().map((r) => String(r['name']))
    const checksumIndex = upgraded
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'attachments_by_checksum'")
      .get()
    const versions = upgraded.prepare('SELECT version FROM migrations ORDER BY version').all().map((r) => Number(r['version']))
    upgraded.close()
    closeDatabase()
    rmSync(legacyDir, { recursive: true, force: true })

    expect(columns).toContain('owner_id')
    expect(String(checksumIndex?.['sql'])).toContain('(checksum, scope, owner_id)')
    expect(versions).toEqual(MIGRATIONS.map((migration) => migration.version))
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

/**
 * 第 3 条迁移(`model_pricing` / `usage_records`)。定价库的访问器还没写(步骤 3/5),
 * 所以这一组直接对表断言 —— 测的是 **DDL 承诺的那几件事**,而它们都会**静默**地坏:
 *
 * 1. 加了外键 → 整张种子表插不进去;
 * 2. 唯一索引写成普通复合主键 → 重复行共存,查价随机命中一条;
 * 3. `cost_micros` 写成 NOT NULL DEFAULT 0 → 「查不到定价」变成「这次免费」。
 *
 * 三件都不会有人报 bug,所以在这里钉住。
 */
describe('定价与用量的表结构', () => {
  /** 直连库文件。`enableForeignKeyConstraints` 默认为 true,正是外键那条要的环境 */
  const raw = (): DatabaseSync => new DatabaseSync(join(dir, DB_FILENAME))

  const insertPricing = (
    d: DatabaseSync,
    providerId: string | null,
    modelId: string,
    effectiveFrom: string | null
  ): void => {
    d.prepare(
      `INSERT INTO model_pricing
         (provider_id, model_id, effective_from, display_name, currency, modality,
          tiers, source, fetched_at)
       VALUES (?, ?, ?, 'x', 'USD', 'text', '[]', 'https://example.com', '2026-09-04')`
    ).run(providerId, modelId, effectiveFrom)
  }

  /**
   * ★★ **`model_pricing.provider_id` 上不能有外键。**
   *
   * 种子表按**厂商**记价(`deepseek` / `zai`),而那些厂商用户可能一个都没配 ——
   * 加外键的后果不是「少几行」,是**整张种子表一行都插不进去**,
   * 表现为「装完之后定价页整页空白」。
   *
   * 这条用一个**确定不存在**于 providers 表里的 id 去插,所以它红的时候
   * 只有一个可能:有人给这列补了 `REFERENCES providers (id)`。
   */
  it('provider_id 指向一个没配过的厂商时照样插得进去(不能有外键)', () => {
    const d = raw()
    expect(d.prepare('SELECT COUNT(*) c FROM providers').get()?.['c']).toBe(0)
    expect(() => insertPricing(d, 'deepseek', 'deepseek-v4-flash', null)).not.toThrow()
    d.close()
  })

  /**
   * ★ NULL 在 UNIQUE 里彼此不相等,所以 `(provider_id, model_id, effective_from)`
   * 做普通复合主键**挡不住**这一条 —— 表达式索引是唯一拦得住的写法。
   */
  it('通用价(provider_id 与 effective_from 都为 NULL)不能重复', () => {
    const d = raw()
    insertPricing(d, null, 'gpt-6-astra', null)
    expect(() => insertPricing(d, null, 'gpt-6-astra', null)).toThrow(/UNIQUE/)
    d.close()
  })

  /** 反向:索引不能宽到把该共存的行也拦掉 —— 这两种形状种子表里都真实存在 */
  it('同名模型的不同厂商价、以及同厂商的不同生效区间,都能共存', () => {
    const d = raw()
    insertPricing(d, null, 'glm-5.3-flash', null)
    insertPricing(d, 'zai', 'glm-5.3-flash', '2026-01-01')
    insertPricing(d, 'zai', 'glm-5.3-flash', '2026-09-10')
    expect(d.prepare('SELECT COUNT(*) c FROM model_pricing').get()?.['c']).toBe(3)
    d.close()
  })

  /**
   * ★★ `cost_micros` 的 NULL 和 0 是**两个不同的事实**:前者「查不到定价」,
   * 后者「真的不要钱」。PricingTable 顶部那张「用过但查不到定价」的表就是
   * 靠 `IS NULL` 筛出来的 —— 这一列要是 NOT NULL DEFAULT 0,那个入口直接失效,
   * 而「种子表 modelId 抄错了」从此没有任何外显方式。
   */
  it('cost_micros 可空,且 NULL 与 0 查得出区别', () => {
    const d = raw()
    const ins = (id: string, cost: number | null): void => {
      d.prepare(
        `INSERT INTO usage_records
           (id, at, run_id, provider_id, alias, upstream_model, latency_ms, ok, cost_micros)
         VALUES (?, 1, 'r', 'p', 'a', 'm', 10, 1, ?)`
      ).run(id, cost)
    }
    ins('无定价', null)
    ins('免费', 0)

    const missing = d.prepare('SELECT id FROM usage_records WHERE cost_micros IS NULL').all()
    expect(missing.map((r) => r['id'])).toEqual(['无定价'])
    d.close()
  })

  /**
   * ★ 和上一条**刻意相反**:token 数缺省补 0 是对的 —— `TokenUsage` 里没有缓存字段
   * 就是真的没有那类 token。这条断言把这个不对称固定下来,免得有人为了「一致」
   * 把两边改成同一种写法(往哪边改都会坏掉其中一个)。
   */
  it('token 计数列缺省是 0,不是 NULL', () => {
    const d = raw()
    d.prepare(
      `INSERT INTO usage_records (id, at, run_id, provider_id, alias, upstream_model, latency_ms, ok)
       VALUES ('x', 1, 'r', 'p', 'a', 'm', 10, 1)`
    ).run()
    const row = d.prepare('SELECT * FROM usage_records WHERE id = ?').get('x')
    expect(row?.['input_tokens']).toBe(0)
    expect(row?.['cache_write_1h_tokens']).toBe(0)
    // 同一行里,没给的费用仍然是 NULL
    expect(row?.['cost_micros']).toBeNull()
    d.close()
  })

  it('两张表跨重启都在,索引也在', () => {
    restart()
    const d = raw()
    const names = (type: string): string[] =>
      d
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`)
        .all(type)
        .map((r) => String(r['name']))
    expect(names('table')).toEqual(expect.arrayContaining(['model_pricing', 'usage_records']))
    expect(names('index')).toEqual(
      expect.arrayContaining([
        'model_pricing_key',
        'model_pricing_by_model',
        'usage_records_by_at',
        'usage_records_by_model',
        'usage_records_by_provider'
      ])
    )
    d.close()
  })
})
